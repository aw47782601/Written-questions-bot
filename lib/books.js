const env = require('./env');
const supabase = require('./supabaseClient');
const gemini = require('./gemini');
const { extractPagesFromPdf } = require('./pdf');
const { chunkPages } = require('./chunker');

const EMBED_BATCH_SIZE = 20; // texts per single batchEmbedContents call
// How many embedding batches are in flight at once. gemini.embedTexts
// already spreads requests across every key in GEMINI_API_KEYS and backs
// off/rotates on 429 by itself, so batches no longer need an artificial
// fixed delay between them — running several concurrently is what
// actually fixes large-book timeouts (a 450+ page book used to serialize
// dozens of batches with a 15s sleep between each, easily blowing past
// Vercel's 300s function limit even though the real embedding work only
// takes a fraction of that).
const MAX_CONCURRENT_EMBED_BATCHES = 5;
// Image pipeline (caption + embed + DB write, merged into one pass per
// image — see ingestPageImages) is deliberately its OWN constant, not
// tied to MAX_CONCURRENT_EMBED_BATCHES: text embedding is cheap/fast
// (a single embedContent call per batch), while image captioning is a
// full vision generateContent call that can take several seconds each,
// so it's the actual bottleneck on an image-heavy book and benefits far
// more from higher concurrency. This is an outer safety ceiling only —
// the actual value used is min(this, keyCount * WORKERS_PER_KEY, number
// of images); see ingestPageImages for why more than one image can
// safely share a single key at once (Gemini's real limit is
// requests-per-minute, not "one in flight at a time per key").
const MAX_CONCURRENT_IMAGE_PIPELINE = 40;
// Vercel's Hobby-plan hard cap is 300s (see module.exports.config in
// api/telegram-webhook.js) — stop dispatching new batches with enough
// headroom left to report a clean "partially processed" error instead of
// the whole function getting killed mid-flight and leaving the book stuck
// in "processing" status forever with no error message.
const SOFT_TIME_BUDGET_MS = 260000;

async function setBookFields(bookId, fields) {
  await supabase
    .from('books')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', bookId);
}

async function listBooks() {
  const { data, error } = await supabase.from('books').select('*').order('created_at', { ascending: true });
  if (error) throw new Error(`Supabase error listing books: ${error.message}`);
  return data;
}

async function listReadyBooks() {
  const books = await listBooks();
  return books.filter((b) => b.status === 'ready');
}

async function getBook(bookId) {
  const { data, error } = await supabase.from('books').select('*').eq('id', bookId).maybeSingle();
  if (error) throw new Error(`Supabase error fetching book: ${error.message}`);
  return data;
}

async function renameBook(bookId, newName) {
  await setBookFields(bookId, { name: newName });
}

async function deleteBook(bookId) {
  // book_chunks.book_id has ON DELETE CASCADE, so this also removes its
  // chunks.
  const { error } = await supabase.from('books').delete().eq('id', bookId);
  if (error) throw new Error(`Supabase error deleting book: ${error.message}`);
}

// Runs `worker` over `items` with at most `limit` in flight at once,
// respecting a soft wall-clock budget: once `budgetMs` has elapsed since
// the call started, no new items are dispatched (in-flight ones are still
// awaited to completion) and the returned `timedOut` flag is set so the
// caller can report a clean partial-progress error instead of letting the
// whole function get killed by the platform's hard timeout.
async function runWithConcurrency(items, limit, worker, budgetMs) {
  const start = Date.now();
  let nextIndex = 0;
  let timedOut = false;

  // workerIndex identifies which of the `workerCount` parallel loops this
  // is (0, 1, 2, ...) — stable for the lifetime of this call, unlike
  // `current`/the item being processed, which changes every iteration.
  // Callers use it to pin each worker to its own Gemini API key (see
  // ingestPageImages/ingestNewBook below) so N workers running at once
  // use N different keys instead of each picking one at random and
  // sometimes colliding on the same key.
  async function runNext(workerIndex) {
    while (nextIndex < items.length) {
      if (Date.now() - start > budgetMs) {
        timedOut = true;
        return;
      }
      const current = nextIndex++;
      await worker(items[current], current, workerIndex);
    }
  }

  const workerCount = Math.min(limit, items.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => runNext(workerIndex)));
  return { timedOut };
}

// Renders each page of the book to an image (up to
// env.MAX_IMAGE_PAGES_PER_BOOK), auto-captions each one, embeds the raw
// image bytes with the multimodal embedding model, and inserts one
// chunk_type='image' row per page into book_chunks — so a question whose
// answer only lives in a diagram/figure/table (not extractable as PDF
// text) can still be retrieved via lib/rag.js's normal similarity search,
// since text and image chunks share the same embedding space (see
// lib/gemini.js embedImages/captionImage and lib/pdf.js renderPageImages).
//
// This is opt-in (env.ENABLE_IMAGE_CHUNKS) and best-effort: any failure
// here is caught by the caller and just reported, never fails the whole
// book upload — the text chunks already cover the book either way.
// budgetMs/startTime let this share the same soft wall-clock budget as
// the text-chunking pass above, so a huge book can't blow past Vercel's
// function timeout.
//
// pages (optional): the same per-page { page_number, text } array the
// text-chunking pass used. When given and the book has extractable text
// on at least one page, this is a MIXED book — only the pages that don't
// carry enough of their own text (see MIN_WORDS_FOR_TEXT_COVERAGE below)
// get rendered+captioned+embedded as images; pages with normal body text
// are already covered by their text chunks and would just be redundant,
// doubled embedding cost. When `pages` is omitted, or every page is
// empty (a fully scanned/image-only book), every page up to
// MAX_IMAGE_PAGES_PER_BOOK is image-embedded, same as before.
const MIN_WORDS_FOR_TEXT_COVERAGE = 20;

async function ingestPageImages(bookId, pdfBuffer, onProgress, budgetMs, startTime, pages = null) {
  if (!env.ENABLE_IMAGE_CHUNKS) return { imageChunks: 0, skipped: true };

  if (!/^gemini-embedding/.test(env.GEMINI_EMBEDDING_MODEL)) {
    onProgress(
      `⚠️ تخطي عمل embedding للصور: GEMINI_EMBEDDING_MODEL الحالي (${env.GEMINI_EMBEDDING_MODEL}) مش موديل multimodal (لازم يكون gemini-embedding-2 أو أحدث).`
    );
    return { imageChunks: 0, skipped: true };
  }

  const remainingBudget = () => Math.max(budgetMs - (Date.now() - startTime), 0);
  if (remainingBudget() < 10000) {
    onProgress('⚠️ مفيش وقت كفاية فاضل لعمل embedding للصور بعد تجهيز النص — اتخطى الجزء ده.');
    return { imageChunks: 0, skipped: true };
  }

  // Required lazily — see lib/pdf.js renderPageImages for why (avoids
  // paying for pdfjs-dist/@napi-rs/canvas on every cold start when image
  // chunking is disabled).
  const { renderPageImages, detectPagesWithImages } = require('./pdf');

  const isMixedBook = pages && pages.some((p) => p.text.trim());
  let targetPageNumbers = null;

  if (isMixedBook) {
    const lowTextPages = new Set(
      pages
        .filter((p) => p.text.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS_FOR_TEXT_COVERAGE)
        .map((p) => p.page_number)
    );

    // A page with normal, substantial body text can still have a photo
    // or diagram embedded alongside that text — word count alone can't
    // see that (the page "looks" text-heavy either way). Detect actual
    // embedded raster images per page and union those in, so a mixed
    // text+photo page gets image-embedded too, on top of its own text
    // chunk. Best-effort: if detection itself fails for any reason
    // (malformed PDF structure, etc.), fall back to the word-count-only
    // list rather than losing image ingestion entirely for the book.
    let pagesWithEmbeddedImages = new Set();
    try {
      pagesWithEmbeddedImages = await detectPagesWithImages(pdfBuffer);
    } catch (err) {
      console.error('detectPagesWithImages failed (falling back to word-count heuristic only):', err.message);
    }

    const combined = new Set([...lowTextPages, ...pagesWithEmbeddedImages]);
    targetPageNumbers = pages.map((p) => p.page_number).filter((n) => combined.has(n));

    if (targetPageNumbers.length === 0) {
      onProgress('🖼️ كل صفحات الكتاب فيها نص كافي ومفيهاش صور مدمجة — مفيش صفحات محتاجة embedding كصور.');
      return { imageChunks: 0, skipped: false };
    }

    onProgress(
      `🖼️ بعمل رندر لـ ${Math.min(targetPageNumbers.length, env.MAX_IMAGE_PAGES_PER_BOOK)} صفحة ` +
        `(من أصل ${pages.length}) فيها صور/رسومات مدمجة أو مفيهاش نص كافي...`
    );
  } else {
    onProgress(`🖼️ بعمل رندر لصفحات الكتاب كصور (حتى ${env.MAX_IMAGE_PAGES_PER_BOOK} صفحة)...`);
  }

  const images = await renderPageImages(pdfBuffer, {
    maxPages: env.MAX_IMAGE_PAGES_PER_BOOK,
    pageNumbers: targetPageNumbers,
  });
  if (images.length === 0) return { imageChunks: 0, skipped: false };

  // Insert one placeholder row per image UP FRONT, before any Gemini call
  // is made. Previously this ran as two separate full passes — caption
  // ALL images, THEN embed+insert ALL images — which meant a caption
  // computed in pass 1 was silently thrown away entirely if pass 2 ran
  // out of time budget before reaching that image's turn (on a 300-image
  // book, only ~10 ever made it into the database; the other ~290 were
  // captioned or partly-captioned work that just vanished, with no row
  // and no error logged). Inserting every row immediately as 'pending'
  // means even a hard timeout only ever leaves clean, resumable rows
  // behind — a later backfill pass can find them via image_status and
  // finish the job without needing to re-render the PDF at all.
  onProgress(`💾 بحجز ${images.length} صف في قاعدة البيانات لصور الصفحات...`);
  const placeholderRows = images.map((img) => ({
    book_id: bookId,
    content: null,
    page_number: img.page_number,
    embedding: null,
    chunk_type: 'image',
    image_base64: img.buffer.toString('base64'),
    image_status: 'pending',
  }));

  const { data: insertedRows, error: insertErr } = await supabase
    .from('book_chunks')
    .insert(placeholderRows)
    .select('id, page_number');

  if (insertErr) throw new Error(`Supabase image placeholder insert error: ${insertErr.message}`);

  // Keep each row's DB id paired with its already-in-memory buffer so the
  // pipeline below never has to re-download the base64 we just uploaded.
  const jobs = insertedRows.map((row, i) => ({ id: row.id, page_number: row.page_number, img: images[i] }));

  // Shuffled once, then workers are pinned to keys in round-robin order
  // (worker 0 → keyPool[0], worker 1 → keyPool[1], ..., worker 20 →
  // keyPool[0] again, ...) instead of every captionImage()/embedImages()
  // call picking a random key independently.
  //
  // WORKERS_PER_KEY controls how many images a single key can have IN
  // FLIGHT AT ONCE. A Gemini key's real limit is requests-PER-MINUTE, not
  // "one request at a time" — so a key sitting idle between its own
  // requests can absolutely take on more than one concurrent image
  // without necessarily hitting its rate limit any faster than before.
  // Start conservative (2) and raise it if the logs below stay clean —
  // captionImage/embedImages already retry through every OTHER key
  // automatically on a 429, so an overly high value doesn't break
  // anything, it just shows up as more retry log lines with no speed
  // gain (a sign your keys share one underlying rate-limit pool and
  // WORKERS_PER_KEY should come back down).
  const WORKERS_PER_KEY = 2;
  const keyPool = gemini.shuffled(env.GEMINI_API_KEYS);
  const imageConcurrency = Math.max(
    1,
    Math.min(MAX_CONCURRENT_IMAGE_PIPELINE, (keyPool.length || 1) * WORKERS_PER_KEY, jobs.length)
  );

  onProgress(
    `🧾🧠 بعمل وصف + embedding لـ ${jobs.length} صورة صفحة ` +
      `(${imageConcurrency} صورة بالتوازي على ${keyPool.length} مفتاح، ${WORKERS_PER_KEY} صور/مفتاح)...`
  );

  let done = 0;
  let processed = 0;
  let lastProgressAt = Date.now();

  // One merged pass — caption, then embed, then save — per image, all
  // running through the same concurrent pool. This replaces what used to
  // be two entirely separate full passes over all images (caption every
  // image first, THEN embed every image), which cost roughly double the
  // wall-clock time for no benefit: a worker now moves straight from
  // captioning image K to embedding image K instead of waiting for every
  // OTHER image's caption to finish first across the whole book.
  const { timedOut } = await runWithConcurrency(
    jobs,
    imageConcurrency,
    async (job, idx, workerIndex) => {
      const preferredKey = keyPool.length > 0 ? keyPool[workerIndex % keyPool.length] : null;

      let content;
      try {
        content = await gemini.captionImage(job.img.buffer, job.img.mimeType, job.page_number, [], preferredKey);
      } catch (err) {
        content = `(صورة صفحة ${job.page_number} — تعذر توليد وصف تلقائي لها)`;
        console.error(`captionImage threw for page ${job.page_number} (book ${bookId}):`, err.message);
      }

      try {
        const [embedding] = await gemini.embedImages(
          [{ buffer: job.img.buffer, mimeType: job.img.mimeType }],
          'RETRIEVAL_DOCUMENT',
          [],
          null,
          preferredKey
        );

        const { error } = await supabase
          .from('book_chunks')
          .update({ content, embedding, image_status: 'done' })
          .eq('id', job.id);
        if (error) throw error;

        done += 1;
      } catch (err) {
        // Embedding (or the DB write itself) failed even though
        // captioning may well have succeeded — save the caption anyway
        // and flag the row so a backfill pass only has to redo the
        // cheap embedding step, not re-run vision captioning from
        // scratch.
        console.error(`embedImages/update failed for page ${job.page_number} (book ${bookId}):`, err.message);
        await supabase.from('book_chunks').update({ content, image_status: 'caption_only' }).eq('id', job.id);
      }

      processed += 1;
      const now = Date.now();
      if (now - lastProgressAt > 4000 || processed >= jobs.length) {
        lastProgressAt = now;
        onProgress(`   ...🖼️ ${processed}/${jobs.length} صورة اتعالجت (${done} خلصت وصف+embedding كامل)`);
      }
    },
    remainingBudget()
  );

  if (timedOut) {
    onProgress(
      `⚠️ اتوقف تجهيز الصور بعد ما خلص الوقت المتاح (${processed}/${jobs.length} صورة اتعالجت، ${done} خلصوا بالكامل). ` +
        `باقي الصور محفوظة في قاعدة البيانات بحالة "pending" ومحتاجة تشغيلة تانية لاحقة عشان تكمل — مفيش صور ضاعت.`
    );
  }

  return { imageChunks: done, skipped: false };
}

// Adds a new book (does NOT touch any existing book — multiple books
// can coexist, each user picks which one they want via /mybook).
// onProgress(message) is optional, called at each major step so the
// caller can relay progress to the admin over Telegram.
async function ingestNewBook(pdfBuffer, fileName, bookName, onProgress = () => {}) {
  const startTime = Date.now();
  const { data: created, error: createErr } = await supabase
    .from('books')
    .insert({ name: bookName, status: 'processing', file_name: fileName })
    .select()
    .single();
  if (createErr) throw new Error(`Supabase error creating book: ${createErr.message}`);

  const bookId = created.id;

  try {
    onProgress('📖 بستخرج النص من الكتاب...');
    const pages = await extractPagesFromPdf(pdfBuffer);
    // pdf-parse's pagerender fires once per page regardless of whether
    // that page has a text layer, so `pages` is a reliable page count
    // even for a scanned/image-only PDF — it's `p.text` that comes back
    // empty for those pages, not the array itself.
    const hasExtractableText = pages.length > 0 && pages.some((p) => p.text.trim());

    // A book with zero extractable text used to be a hard failure no
    // matter what. Now it's only a hard failure if there's also no way
    // to fall back to reading it as images — image-only/scanned PDFs
    // are exactly the case ENABLE_IMAGE_CHUNKS + ingestPageImages exist
    // for (see below), so let those through and skip straight to the
    // image pipeline instead of rejecting the upload outright.
    if (!hasExtractableText && !env.ENABLE_IMAGE_CHUNKS) {
      throw new Error(
        'الملف ده مفيهوش نص قابل للاستخراج (ممكن يكون سكان/صور). فعّل خاصية قراءة الكتاب كصور ' +
          '(ENABLE_IMAGE_CHUNKS) عشان يقدر يتعامل مع الكتب المصورة، أو ارفع نسخة نصية من الكتاب.'
      );
    }

    let chunks = [];
    let completedChunks = 0;

    if (hasExtractableText) {
      onProgress(`✂️ بقسم الكتاب (${pages.length} صفحة) لأجزاء قابلة للبحث...`);
      chunks = chunkPages(pages);

      const batches = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        batches.push(chunks.slice(i, i + EMBED_BATCH_SIZE));
      }

      const concurrency = Math.min(MAX_CONCURRENT_EMBED_BATCHES, batches.length);
      onProgress(
        `🧠 بعمل embeddings لـ ${chunks.length} جزء على ${batches.length} دفعة ` +
          `(${concurrency} دفعات بالتوازي في نفس الوقت)...`
      );

      let lastProgressAt = Date.now();

      // Same fixed key-per-worker assignment as the image passes in
      // ingestPageImages above — shuffled once, then each of the
      // `concurrency` batch workers keeps its own key for the whole pass
      // instead of picking one at random per batch.
      const textEmbedKeyPool = gemini.shuffled(env.GEMINI_API_KEYS);

      const { timedOut } = await runWithConcurrency(
        batches,
        concurrency,
        async (batch, batchIdx, workerIndex) => {
          const preferredKey =
            textEmbedKeyPool.length > 0 ? textEmbedKeyPool[workerIndex % textEmbedKeyPool.length] : null;
          const vectors = await gemini.embedTexts(
            batch.map((c) => c.content),
            'RETRIEVAL_DOCUMENT',
            [],
            null,
            preferredKey
          );

          const rows = batch.map((c, idx) => ({
            book_id: bookId,
            content: c.content,
            page_number: c.page_number,
            embedding: vectors[idx],
          }));

          const { error } = await supabase.from('book_chunks').insert(rows);
          if (error) throw new Error(`Supabase insert error: ${error.message}`);

          completedChunks += batch.length;
          // Batches complete out of order under concurrency, so this is a
          // running total rather than a strict "up to index N" progress —
          // still throttled so a fast run of small batches doesn't flood
          // Telegram with a message per batch.
          const now = Date.now();
          if (now - lastProgressAt > 4000 || completedChunks >= chunks.length) {
            lastProgressAt = now;
            onProgress(`   ...${Math.min(completedChunks, chunks.length)}/${chunks.length}`);
          }
        },
        SOFT_TIME_BUDGET_MS
      );

      if (timedOut) {
        throw new Error(
          `انتهى وقت المعالجة المسموح به قبل ما يخلص الكتاب بالكامل (${completedChunks}/${chunks.length} جزء اتعالج بنجاح). ` +
            'ده بيحصل مع الكتب الكبيرة جداً — جرب ترفع الكتاب تاني (هيبدأ من الأول)، أو قسمه لأجزاء أصغر وارفعهم كتب منفصلة.'
        );
      }
    } else {
      onProgress(
        '⚠️ الكتاب ده مفيهوش نص قابل للاستخراج (سكان/صور على الأغلب) — هيتقرا بالكامل كصور بدل النص.'
      );
    }

    // Image chunking: a best-effort bonus pass when there IS extractable
    // text (the book is already fully usable from text chunks alone in
    // that case), but the ONLY content source when there isn't — so any
    // failure here is still non-fatal and reported via onProgress rather
    // than failing the whole upload; whether the book ends up usable at
    // all is decided by the total-chunks check just below instead.
    let imageChunks = 0;
    try {
      const result = await ingestPageImages(bookId, pdfBuffer, onProgress, SOFT_TIME_BUDGET_MS, startTime, pages);
      imageChunks = result.imageChunks;
    } catch (imgErr) {
      console.error('Image-chunk ingestion failed (non-fatal):', imgErr);
      onProgress(`⚠️ فشل عمل embedding للصور: ${imgErr.message}`);
    }

    if (chunks.length + imageChunks === 0) {
      throw new Error(
        'مقدرتش أستخرج أي محتوى قابل للاستخدام من الكتاب — لا نص ولا صور اتعملها embedding بنجاح.'
      );
    }

    await setBookFields(bookId, {
      status: 'ready',
      total_pages: pages.length,
      total_chunks: chunks.length + imageChunks,
      error_message: null,
    });

    return { id: bookId, pages: pages.length, chunks: chunks.length, imageChunks };
  } catch (err) {
    await setBookFields(bookId, { status: 'error', error_message: err.message });
    throw err;
  }
}

module.exports = { listBooks, listReadyBooks, getBook, renameBook, deleteBook, ingestNewBook };
