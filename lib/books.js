const env = require('./env');
const supabase = require('./supabaseClient');
const gemini = require('./gemini');
const { extractPagesFromPdf } = require('./pdf');
const { chunkPages } = require('./chunker');

const EMBED_BATCH_SIZE = 20; // texts per single batchEmbedContents call
const IMAGE_EMBED_BATCH_SIZE = 10; // images per single batchEmbedContents call — kept smaller than the text batch since each request part carries a full base64 image payload, not a short text string
// Vision captioning (gemini.captionImage) is a full generateContent call
// per image with no internal retry/rotation, so a lower concurrency than
// the text-embedding path keeps a single flaky key/page from stalling
// everything else while still processing several pages in parallel.
const MAX_CONCURRENT_IMAGE_CAPTIONS = 3;
// How many embedding batches are in flight at once. gemini.embedTexts
// already spreads requests across every key in GEMINI_API_KEYS and backs
// off/rotates on 429 by itself, so batches no longer need an artificial
// fixed delay between them — running several concurrently is what
// actually fixes large-book timeouts (a 450+ page book used to serialize
// dozens of batches with a 15s sleep between each, easily blowing past
// Vercel's 300s function limit even though the real embedding work only
// takes a fraction of that).
const MAX_CONCURRENT_EMBED_BATCHES = 5;
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

  async function runNext() {
    while (nextIndex < items.length) {
      if (Date.now() - start > budgetMs) {
        timedOut = true;
        return;
      }
      const current = nextIndex++;
      await worker(items[current], current);
    }
  }

  const workerCount = Math.min(limit, items.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, runNext));
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
async function ingestPageImages(bookId, pdfBuffer, onProgress, budgetMs, startTime) {
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
  const { renderPageImages } = require('./pdf');

  onProgress(`🖼️ بعمل رندر لصفحات الكتاب كصور (حتى ${env.MAX_IMAGE_PAGES_PER_BOOK} صفحة)...`);
  const images = await renderPageImages(pdfBuffer, { maxPages: env.MAX_IMAGE_PAGES_PER_BOOK });
  if (images.length === 0) return { imageChunks: 0, skipped: false };

  onProgress(`🧾 بعمل وصف تلقائي (caption) لـ ${images.length} صورة صفحة...`);
  const captions = new Array(images.length);
  let captioned = 0;
  let lastCaptionProgressAt = Date.now();
  await runWithConcurrency(
    images,
    MAX_CONCURRENT_IMAGE_CAPTIONS,
    async (img, idx) => {
      captions[idx] = await gemini.captionImage(img.buffer, img.mimeType, img.page_number);
      captioned += 1;
      const now = Date.now();
      if (now - lastCaptionProgressAt > 4000 || captioned >= images.length) {
        lastCaptionProgressAt = now;
        onProgress(`   ...📝 ${captioned}/${images.length} وصف`);
      }
    },
    remainingBudget()
  );

  const indexed = images.map((img, idx) => ({ img, idx }));
  const batches = [];
  for (let i = 0; i < indexed.length; i += IMAGE_EMBED_BATCH_SIZE) {
    batches.push(indexed.slice(i, i + IMAGE_EMBED_BATCH_SIZE));
  }

  onProgress(`🧠 بعمل embeddings للصور (${batches.length} دفعة)...`);
  let embedded = 0;
  let lastEmbedProgressAt = Date.now();
  const { timedOut } = await runWithConcurrency(
    batches,
    Math.min(MAX_CONCURRENT_EMBED_BATCHES, batches.length),
    async (batch) => {
      const vectors = await gemini.embedImages(
        batch.map(({ img }) => ({ buffer: img.buffer, mimeType: img.mimeType })),
        'RETRIEVAL_DOCUMENT'
      );

      const rows = batch.map(({ img, idx }, i) => ({
        book_id: bookId,
        content: captions[idx] || `(صورة صفحة ${img.page_number} — تعذر توليد وصف تلقائي لها)`,
        page_number: img.page_number,
        embedding: vectors[i],
        chunk_type: 'image',
        image_base64: img.buffer.toString('base64'),
      }));

      const { error } = await supabase.from('book_chunks').insert(rows);
      if (error) throw new Error(`Supabase image chunk insert error: ${error.message}`);

      embedded += batch.length;
      const now = Date.now();
      if (now - lastEmbedProgressAt > 4000 || embedded >= images.length) {
        lastEmbedProgressAt = now;
        onProgress(`   ...🖼️ ${embedded}/${images.length} صورة اتعملها embedding`);
      }
    },
    remainingBudget()
  );

  if (timedOut) {
    onProgress(
      `⚠️ اتوقف embedding الصور بعد ما خلص الوقت المتاح (${embedded}/${images.length} صورة اتعالجت). الكتاب لسه شغال عادي بالنص، وده مجرد تحسين إضافي فاتك جزء منه.`
    );
  }

  return { imageChunks: embedded, skipped: false };
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
    if (pages.length === 0 || pages.every((p) => !p.text.trim())) {
      throw new Error(
        'الملف ده مفيهوش نص قابل للاستخراج (ممكن يكون سكان/صور). محتاج نسخة نصية من الكتاب.'
      );
    }

    onProgress(`✂️ بقسم الكتاب (${pages.length} صفحة) لأجزاء قابلة للبحث...`);
    const chunks = chunkPages(pages);
    if (chunks.length === 0) {
      throw new Error('مقدرتش أستخرج أي محتوى قابل للتقسيم من الكتاب.');
    }

    const batches = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      batches.push(chunks.slice(i, i + EMBED_BATCH_SIZE));
    }

    const concurrency = Math.min(MAX_CONCURRENT_EMBED_BATCHES, batches.length);
    onProgress(
      `🧠 بعمل embeddings لـ ${chunks.length} جزء على ${batches.length} دفعة ` +
        `(${concurrency} دفعات بالتوازي في نفس الوقت)...`
    );

    let completedChunks = 0;
    let lastProgressAt = Date.now();

    const { timedOut } = await runWithConcurrency(
      batches,
      concurrency,
      async (batch) => {
        const vectors = await gemini.embedTexts(batch.map((c) => c.content), 'RETRIEVAL_DOCUMENT');

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

    // Image chunking is a best-effort bonus pass on top of the text
    // pipeline above, not a required step — the book is already fully
    // usable from text chunks alone. Any failure here (rendering error,
    // vision/embedding API failure, etc.) is caught and reported via
    // onProgress rather than failing the whole upload, and it shares the
    // remaining slice of the same soft wall-clock budget as the text pass.
    let imageChunks = 0;
    try {
      const result = await ingestPageImages(bookId, pdfBuffer, onProgress, SOFT_TIME_BUDGET_MS, startTime);
      imageChunks = result.imageChunks;
    } catch (imgErr) {
      console.error('Image-chunk ingestion failed (non-fatal):', imgErr);
      onProgress(`⚠️ فشل عمل embedding للصور (الكتاب اتحفظ عادي بالنص بس): ${imgErr.message}`);
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
