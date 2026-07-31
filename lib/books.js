const env = require('./env');
const supabase = require('./supabaseClient');
const gemini = require('./gemini');
const { extractPagesFromPdf } = require('./pdf');
const { chunkPages } = require('./chunker');

const EMBED_BATCH_SIZE = 20; // texts per single batchEmbedContents call
// Bucket the original uploaded PDF is saved to right after a book row is
// created, BEFORE any Gemini call is made — this is what makes
// continueBookImages (further down) possible at all. Previously the
// PDF buffer only ever lived in-memory for the lifetime of a single
// Vercel invocation; if that invocation got killed by the platform's
// 300s hard timeout partway through captioning, there was no way to
// finish the job later short of the admin re-uploading the exact same
// file (which also meant re-embedding every already-done text chunk —
// pure wasted quota on top of the interruption). Create this bucket
// once in the Supabase dashboard (Storage → New bucket → name
// "book-source-pdfs", private) before this is used.
const SOURCE_PDF_BUCKET = 'book-source-pdfs';
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

// Returns { error } (error is null on success) instead of throwing, so
// existing call sites that never checked the result (several of them
// fire-and-forget inside catch blocks reporting an unrelated failure)
// keep working unchanged. Callers that DO need to know whether the write
// actually landed — storeSourcePdf below is the important one — check
// the returned error explicitly. Before this, a failed update here (e.g.
// the books.source_pdf_path column not existing yet, a transient
// Supabase error, etc.) was completely invisible: storeSourcePdf's own
// try/catch only wrapped the Storage upload, not this call, so the PDF
// bytes could upload fine while the row never got its source_pdf_path,
// and the failure showed up nowhere — not in the console, not to an
// admin — until someone ran /continue_book on that book much later and
// got a generic "no PDF was saved" error with no clue why.
async function setBookFields(bookId, fields) {
  const { error } = await supabase
    .from('books')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', bookId);
  if (error) {
    console.error(`setBookFields failed for book ${bookId} (fields: ${Object.keys(fields).join(', ')}):`, error.message);
  }
  return { error };
}

// Best-effort, non-fatal: saves the original PDF to Supabase Storage and
// records its path on the book row (books.source_pdf_path). If this
// fails (storage quota, network, etc.) the book still ingests normally
// — it just can't be resumed later via /continue_book if a Vercel
// timeout cuts the run short; the admin would have to re-upload it as a
// fresh book in that case, same as before this existed.
//
// One specific failure mode used to be permanent and silent: if the
// "book-source-pdfs" bucket had never been created in the Supabase
// dashboard, EVERY upload failed with "Bucket not found" forever, and
// the only symptom was a log line + every future /continue_book on
// every book failing with the same "no PDF was saved" error, with no
// indication why. supabaseClient.js authenticates with the service-role
// key, which has permission to create buckets — so on that specific
// error, create the bucket once and retry the upload immediately
// instead of requiring someone to notice the log line and go create it
// by hand in the dashboard.
async function storeSourcePdf(bookId, pdfBuffer) {
  const path = `${bookId}.pdf`;
  const doUpload = () =>
    supabase.storage.from(SOURCE_PDF_BUCKET).upload(path, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  try {
    let { error: uploadErr } = await doUpload();

    if (uploadErr && /bucket not found/i.test(uploadErr.message || '')) {
      console.error(`storeSourcePdf: bucket "${SOURCE_PDF_BUCKET}" missing — creating it and retrying once...`);
      // fileSizeLimit explicitly set: Supabase's project-wide default
      // (commonly 50MB) can otherwise silently reject a large scanned
      // textbook PDF at upload time, which used to look identical to any
      // other storeSourcePdf failure — just a console.error line and a
      // book that quietly can't be resumed later.
      const { error: createErr } = await supabase.storage.createBucket(SOURCE_PDF_BUCKET, {
        public: false,
        fileSizeLimit: '200MB',
      });
      // Ignore "already exists" — a concurrent request may have created
      // it between our failed upload and this call.
      if (createErr && !/already exists/i.test(createErr.message || '')) throw createErr;
      ({ error: uploadErr } = await doUpload());
    }

    if (uploadErr) throw uploadErr;

    // The Storage upload succeeding is NOT enough — this is the piece
    // that actually makes /continue_book work later, so its error must
    // not be swallowed. Previously setBookFields() had no return value
    // to check, so a failure here (e.g. the books table not yet having a
    // source_pdf_path column) left the PDF sitting in Storage with the
    // book row never pointing at it, and nothing ever surfaced that.
    const { error: fieldErr } = await setBookFields(bookId, { source_pdf_path: path });
    if (fieldErr) throw new Error(`failed to record source_pdf_path on the book row: ${fieldErr.message}`);
  } catch (err) {
    console.error(`storeSourcePdf failed for book ${bookId} (book will not be resumable via /continue_book):`, err.message);
    // This used to be console.error only — invisible unless someone was
    // watching Vercel logs at that exact moment. Surface it to admins
    // immediately, at upload time, instead of leaving them to discover
    // it only when /continue_book unexpectedly fails on this book later
    // with no context on why.
    gemini
      .notifyAdmins(
        `⚠️ فشل حفظ نسخة الـ PDF الأصلية للكتاب #${bookId} — الكتاب هيتجهز عادي، بس /continue_book مش هيشتغل ` +
          `عليه لو اتقطعت المعالجة (هيحتاج رفع من جديد بدل ما يكمل). السبب: ${err.message}`
      )
      .catch(() => {});
  }
}

// Re-downloads the original PDF for a book, if it was saved. Returns
// null if the book predates this feature or storage failed at upload
// time — callers should tell the admin to re-upload as a fresh book.
async function fetchSourcePdf(bookId) {
  const book = await getBook(bookId);
  if (!book?.source_pdf_path) return null;
  const { data, error } = await supabase.storage.from(SOURCE_PDF_BUCKET).download(book.source_pdf_path);
  if (error) throw new Error(`Supabase storage download error: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

// Deletes the saved source PDF from Storage (and clears
// books.source_pdf_path) once every image chunk for this book has
// actually finished — i.e. no book_chunks row for it is still 'pending',
// 'caption_failed', or 'caption_only'. Safe to call after every image
// pass (ingestPageImages, continueBookImages) unconditionally: it always
// re-checks the real remaining count in the DB itself, so if the run
// timed out or some pages are still stuck failing, this is simply a
// no-op and the PDF stays put for the next /continue_book to use.
//
// Best-effort — a failure here (storage error, etc.) is logged and
// swallowed, never thrown, since it must never block or fail the
// captioning pass that called it. Worst case the PDF just lingers in
// storage a bit longer, same as before this existed.
async function cleanupSourcePdfIfComplete(bookId) {
  const { count, error } = await supabase
    .from('book_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', bookId)
    .eq('chunk_type', 'image')
    .in('image_status', ['pending', 'caption_failed', 'caption_only']);

  if (error) {
    console.error(`cleanupSourcePdfIfComplete: status check failed for book ${bookId} (leaving PDF in place):`, error.message);
    return;
  }
  if (count > 0) return; // still unfinished image pages — keep the PDF for the next /continue_book run

  const book = await getBook(bookId);
  if (!book?.source_pdf_path) return; // nothing saved, or already cleaned up

  const { error: removeErr } = await supabase.storage.from(SOURCE_PDF_BUCKET).remove([book.source_pdf_path]);
  if (removeErr) {
    console.error(`cleanupSourcePdfIfComplete: storage delete failed for book ${bookId} (leaving PDF in place):`, removeErr.message);
    return;
  }

  const { error: fieldErr } = await setBookFields(bookId, { source_pdf_path: null });
  if (fieldErr) {
    // The file itself is already gone from Storage at this point — log
    // loudly, since a stale source_pdf_path now points at nothing and a
    // future /continue_book on this book would fail confusingly on
    // download rather than with a clear "no PDF was saved" message.
    console.error(`cleanupSourcePdfIfComplete: deleted PDF for book ${bookId} but failed to clear source_pdf_path:`, fieldErr.message);
  }
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

// How many consecutive images share one freshly-randomized batch of
// keys. Instead of pinning each concurrent worker to one key for the
// entire pass (old behavior — worker 0 always uses keyPool[0], worker 1
// always keyPool[1], etc.), images are grouped in order into batches of
// IMAGE_KEY_BATCH_SIZE: batch 1 (images 0-4) draws a fresh random sample
// of up to IMAGE_KEY_BATCH_SIZE keys, batch 2 (images 5-9) draws a NEW
// fresh random sample, and so on. This spreads a run's key usage much
// more evenly across the whole pool (a small book no longer hammers just
// the couple of keys a fixed round-robin worker mapping happened to
// assign) while still capping how many DISTINCT keys are used per batch
// to IMAGE_KEY_BATCH_SIZE, same spirit as MAX_KEYS_PER_CAPTION_CALL in
// gemini.js.
const IMAGE_KEY_BATCH_SIZE = 5;

// Precomputes one preferredKey per job UP FRONT (by position in `jobs`,
// not by worker), so job index i always maps to the same key regardless
// of which concurrent worker happens to pick it up or what order jobs
// finish in. Returns an array the same length as jobCount; entries are
// null when allKeys is empty (caller falls back to gemini.js's own
// internal random key picking in that case).
function buildImageKeyAssignments(jobCount, allKeys) {
  const assignments = [];
  for (let i = 0; i < jobCount; i += IMAGE_KEY_BATCH_SIZE) {
    const batchLen = Math.min(IMAGE_KEY_BATCH_SIZE, jobCount - i);
    const batchKeys = gemini.shuffled(allKeys).slice(0, Math.min(IMAGE_KEY_BATCH_SIZE, allKeys.length));
    for (let j = 0; j < batchLen; j++) {
      assignments.push(batchKeys.length > 0 ? batchKeys[j % batchKeys.length] : null);
    }
  }
  return assignments;
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
// NOTE: the rendered image itself is never persisted — only its caption
// (content) and embedding are. The rendered page buffer lives in memory
// for this pass only, then it's gone. Retrieval still works exactly the
// same (search matches on the caption text/embedding); the difference is
// only that an answer citing an image page can no longer hand the user
// back the actual page picture, just the page number to look it up in
// the book themselves.
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

// Captions + embeds + saves ONE image row. Shared by the fresh-ingestion
// pass (ingestPageImages below) and the resume pass (continueBookImages,
// further down) so the exact same failure handling applies whether this
// is page 40 of a fresh upload or page 40 being retried a day later.
// Returns true only for a genuine successful caption (matches the old
// `done`/imageChunks counting rule — a placeholder that merely embedded
// fine is NOT a success).
async function processOneImageJob(job, bookId, preferredKey, captionQuotaState, collector) {
  // captionFailed tracks whether captionImage() itself threw — it DOES
  // throw on total failure (every sampled key×model combo exhausted or
  // erroring) instead of silently returning a fake-success placeholder
  // string, which is what used to let a failed page's row get marked
  // image_status: 'done' and counted as a success. When it throws, we
  // build the placeholder ourselves here so the pipeline still has SOME
  // text to embed for search purposes, but the row is correctly flagged
  // 'caption_failed' and never counted as a success.
  let content;
  let captionFailed = false;
  try {
    content = await gemini.captionImage(job.img.buffer, job.img.mimeType, job.page_number, [], preferredKey, captionQuotaState);
  } catch (err) {
    captionFailed = true;
    content = `(صورة صفحة ${job.page_number} — تعذر توليد وصف تلقائي لها)`;
    console.error(`captionImage threw for page ${job.page_number} (book ${bookId}):`, err.message);
  }

  try {
    const [embedding] = await gemini.embedTexts([content], 'RETRIEVAL_DOCUMENT', [], collector, preferredKey);

    const { error } = await supabase
      .from('book_chunks')
      .update({ content, embedding, image_status: captionFailed ? 'caption_failed' : 'done' })
      .eq('id', job.id);
    if (error) throw error;

    // Only a real, successful caption counts toward `done`/imageChunks
    // — a placeholder-text row that merely embedded successfully is NOT
    // a success for this page, it still needs a retry (see image_status:
    // 'caption_failed'/'pending', which continueBookImages filters on to
    // redo vision captioning specifically).
    return !captionFailed;
  } catch (err) {
    // Embedding (or the DB write itself) failed even though captioning
    // may well have succeeded — save the caption anyway and flag the row
    // so a resume pass only has to redo the cheap embedding step, not
    // re-run vision captioning from scratch. If captioning ALSO failed,
    // 'caption_failed' takes priority so the resume pass knows to redo
    // captioning first, not just embedding.
    console.error(`embedTexts/update failed for page ${job.page_number} (book ${bookId}):`, err.message);
    await supabase
      .from('book_chunks')
      .update({ content, image_status: captionFailed ? 'caption_failed' : 'caption_only' })
      .eq('id', job.id);
    return false;
  }
}

async function ingestPageImages(bookId, pdfBuffer, onProgress, budgetMs, startTime, pages = null, collector = null) {
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
  //
  // Deliberately NOT storing the rendered image bytes (image_base64) here
  // anymore. That used to insert every page's full base64-encoded PNG in
  // one bulk statement, which (a) filled up Supabase storage fast on
  // image-heavy books, since every page image was kept forever even
  // after captioning, and (b) was the actual cause of the "canceling
  // statement due to statement timeout" error — a single INSERT carrying
  // hundreds of multi-hundred-KB base64 strings is a multi-MB statement
  // that Postgres kills once it runs past the statement_timeout. The row
  // now only carries page_number + status; the image buffer stays in
  // memory (see `images[i]` below) for exactly as long as this pass needs
  // it to caption/embed, then it's discarded — search still works fully
  // (via the caption text in `content` + its embedding), the bot just no
  // longer has a copy of the image itself to hand back to the user, only
  // the page number to cite.
  onProgress(`💾 بحجز ${images.length} صف في قاعدة البيانات لصور الصفحات...`);
  const placeholderRows = images.map((img) => ({
    book_id: bookId,
    // book_chunks.content has a NOT NULL constraint, so a literal `null`
    // here fails the whole bulk insert (Supabase error: "null value in
    // column \"content\" ... violates not-null constraint"), which meant
    // NONE of the placeholder rows for the book got created — not even
    // the ones whose images were fine. Use a clearly-marked pending
    // placeholder instead; it gets overwritten with the real AI-generated
    // caption a few lines below once captionImage() resolves for that
    // page (or with the caption_only text if only embedding fails).
    content: `⏳ جاري توليد وصف الصورة (صفحة ${img.page_number})...`,
    page_number: img.page_number,
    embedding: null,
    chunk_type: 'image',
    image_status: 'pending',
  }));

  const { data: insertedRows, error: insertErr } = await supabase
    .from('book_chunks')
    .insert(placeholderRows)
    .select('id, page_number');

  if (insertErr) throw new Error(`Supabase image placeholder insert error: ${insertErr.message}`);

  // Keep each row's DB id paired with its already-in-memory buffer — the
  // buffer is only ever used in-process for captioning/embedding below,
  // it's never written to the DB.
  const jobs = insertedRows.map((row, i) => ({ id: row.id, page_number: row.page_number, img: images[i] }));

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
  const keyPool = env.GEMINI_API_KEYS;
  const imageConcurrency = Math.max(
    1,
    Math.min(MAX_CONCURRENT_IMAGE_PIPELINE, (keyPool.length || 1) * WORKERS_PER_KEY, jobs.length)
  );
  // See buildImageKeyAssignments above — job i (by position, not by
  // worker) gets a key drawn from a fresh random sample of up to
  // IMAGE_KEY_BATCH_SIZE keys re-rolled every IMAGE_KEY_BATCH_SIZE jobs.
  const imageKeyAssignments = buildImageKeyAssignments(jobs.length, keyPool);

  // ONE shared circuit-breaker for the whole book. Every concurrent
  // worker below passes this same object into gemini.captionImage() —
  // the moment any worker proves every key×model combo is out of quota,
  // every OTHER worker (and every page still queued) finds out instantly
  // and stops calling the API at all, instead of each of the book's
  // pages independently burning through the same 34 keys × 3 models all
  // over again. See gemini.js createCaptionQuotaState/captionImage.
  const captionQuotaState = gemini.createCaptionQuotaState();
  let quotaExhaustedNoticeShown = false;

  onProgress(
    `🧾🧠 بعمل وصف + embedding لـ ${jobs.length} صورة صفحة ` +
      `(${imageConcurrency} صورة بالتوازي على ${keyPool.length} مفتاح، ${WORKERS_PER_KEY} صور/مفتاح)...`
  );

  let done = 0;
  let processed = 0;
  let lastProgressAt = Date.now();

  // One merged pass — caption, then embed the CAPTION TEXT, then save —
  // per image, all running through the same concurrent pool. This
  // replaces what used to be two entirely separate full passes over all
  // images (caption every image first, THEN embed every image), which
  // cost roughly double the wall-clock time for no benefit: a worker now
  // moves straight from captioning image K to embedding image K instead
  // of waiting for every OTHER image's caption to finish first across
  // the whole book.
  //
  // Embedding the caption TEXT (via embedTexts) rather than the raw image
  // pixels (the old embedImages call) on purpose:
  //   1. A user's question is always embedded as text, through embedTexts
  //      with taskType RETRIEVAL_QUERY, which applies the "task:
  //      search_query | query: ..." prefix convention (see
  //      applyTaskPrefix in gemini.js). A raw image embedding never gets
  //      that prefix at all — it's a structurally different point in the
  //      embedding space than a query built that way, so image chunks
  //      were never quite comparing apples-to-apples against the
  //      questions searching for them. Embedding the caption text puts
  //      image chunks through the exact same text convention as both
  //      question embeddings and every ordinary text chunk.
  //   2. It drops the requirement that GEMINI_EMBEDDING_MODEL be a
  //      multimodal model (gemini-embedding-2+) — embedImages() throws
  //      outright on any other model. Plain embedTexts works with
  //      whatever text-embedding model is configured.
  //   3. The caption is already the single source of truth for what gets
  //      shown to the LLM at answer time (book_chunks.content) — indexing
  //      on exactly that text means "what got embedded" and "what the
  //      model reads" are now guaranteed to describe the same thing.
  const { timedOut } = await runWithConcurrency(
    jobs,
    imageConcurrency,
    async (job, idx, workerIndex) => {
      const preferredKey = imageKeyAssignments[idx];
      const success = await processOneImageJob(job, bookId, preferredKey, captionQuotaState, collector);
      if (success) done += 1;

      if (captionQuotaState.fullyExhausted && !quotaExhaustedNoticeShown) {
        quotaExhaustedNoticeShown = true;
        onProgress(
          '🚨 كل مفاتيح Gemini خلصت الكوتة — باقي صور الكتاب هتتحفظ بدون وصف (حالة "caption_failed") ' +
            'من غير ما نكمل نضرب الـ API على الفاضي. الكتاب هيكمل ويتحفظ عادي، بس محتاج شغلانة تانية لاحقًا ' +
            '(عبر /continue_book) لعمل وصف للصور دي بعد ما الكوتة ترجع أو تتضاف مفاتيح جديدة.'
        );
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
        `باقي الصور محفوظة في قاعدة البيانات بحالة "pending" — شغّل /continue_book ${bookId} لاحقًا عشان تكمل، مفيش صور ضاعت.`
    );
  }

  const failedImages = jobs.length - done;
  if (!timedOut && failedImages > 0) {
    // Every image row still got saved+embedded (so the book isn't
    // blocked), but a placeholder caption is not real, searchable
    // content — surface this clearly instead of letting it hide inside
    // an overall "success" message. captionQuotaState.fullyExhausted
    // tells us WHY, when it was quota (the common case), vs some other
    // per-page error.
    onProgress(
      `⚠️ ${failedImages}/${jobs.length} صورة فشل توليد وصف حقيقي لها` +
        (captionQuotaState.fullyExhausted ? ' (الكوتة خلصت لكل المفاتيح)' : '') +
        ` — اتحفظت بنص placeholder بدل الوصف الفعلي (حالة "caption_failed"). ` +
        `شغّل /continue_book ${bookId} بعد ما الكوتة ترجع أو تتضاف مفاتيح جديدة عشان يتعاد توليد الوصف الصح ليها.`
    );
  }

  // No-op if anything above is still unfinished (timed out, or pages
  // stuck in caption_failed/caption_only) — cleanupSourcePdfIfComplete
  // re-checks the real DB state itself before deleting anything.
  await cleanupSourcePdfIfComplete(bookId);

  return { imageChunks: done, skipped: false, totalImages: jobs.length, failedImages };
}

// Adds a new book (does NOT touch any existing book — multiple books
// can coexist, each user picks which one they want via /mybook).
// onProgress(message) is optional, called at each major step so the
// caller can relay progress to the admin over Telegram.
async function ingestNewBook(pdfBuffer, fileName, bookName, onProgress = () => {}) {
  const startTime = Date.now();
  // Passed to every gemini.embedTexts() call made during this ingestion
  // run (text-chunk batches below, plus every image-caption embedding
  // inside ingestPageImages). When a collector is provided, embedTexts
  // records { keyLabel } into collector.embeddingCalls instead of firing
  // an admin Telegram notification per call — without this, a single
  // large book (hundreds of text batches + hundreds of page images) sent
  // an admin one "🔑 تم استخدام..." message per call, which was pure
  // spam for a background ingestion job that already reports its own
  // progress via onProgress. Nothing currently reads this collector back
  // out after ingestion finishes — it exists purely as an opt-in switch
  // to silence the per-call notification path in gemini.js.
  const usageCollector = { embeddingCalls: [], generationCalls: [], failures: [] };
  const { data: created, error: createErr } = await supabase
    .from('books')
    .insert({ name: bookName, status: 'processing', file_name: fileName })
    .select()
    .single();
  if (createErr) throw new Error(`Supabase error creating book: ${createErr.message}`);

  const bookId = created.id;

  // Save the source PDF FIRST, before any Gemini call — so if this run
  // gets killed by Vercel's 300s timeout partway through (large book,
  // dead quota making captioning slow, etc.), /continue_book can pick
  // the image pass back up later without the admin re-uploading anything.
  await storeSourcePdf(bookId, pdfBuffer);

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
            usageCollector,
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
    let totalImages = 0;
    let failedImages = 0;
    try {
      const result = await ingestPageImages(bookId, pdfBuffer, onProgress, SOFT_TIME_BUDGET_MS, startTime, pages, usageCollector);
      imageChunks = result.imageChunks;
      totalImages = result.totalImages || 0;
      failedImages = result.failedImages || 0;
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

    return { id: bookId, pages: pages.length, chunks: chunks.length, imageChunks, totalImages, failedImages };
  } catch (err) {
    await setBookFields(bookId, { status: 'error', error_message: err.message });
    throw err;
  }
}

module.exports = {
  listBooks,
  listReadyBooks,
  getBook,
  renameBook,
  deleteBook,
  ingestNewBook,
  continueBookImages,
  fixLegacyFailedImages,
};

// Picks up exactly where a killed/interrupted image-captioning pass left
// off, WITHOUT re-rendering or re-embedding anything that already
// succeeded. Finds every book_chunks row for this book still in
// 'pending' (never even attempted), 'caption_failed' (vision call
// failed/quota was dead), or 'caption_only' (captioned fine but the
// embedding/DB write step failed) — and reprocesses ONLY those pages.
// Requires the book to have been uploaded after storeSourcePdf existed
// (see ingestNewBook) — older books that predate it have no
// source_pdf_path and can't be resumed this way; re-upload as new.
//
// Safe to call repeatedly: if Vercel's 300s limit cuts THIS run short
// too, whatever's left is still sitting there with the same statuses,
// ready for another /continue_book call — same soft time-budget pattern
// as the original ingestion (see SOFT_TIME_BUDGET_MS / runWithConcurrency).
async function continueBookImages(bookId, onProgress = () => {}) {
  if (!env.ENABLE_IMAGE_CHUNKS) return { resumed: 0, skipped: true };

  const startTime = Date.now();
  const book = await getBook(bookId);
  if (!book) throw new Error('الكتاب ده مش موجود.');

  const pdfBuffer = await fetchSourcePdf(bookId);
  if (!pdfBuffer) {
    throw new Error(
      'الكتاب ده اتحفظله نسخة من الـ PDF الأصلي وقت الرفع، أو حفظها فشل وقتها — ' +
        'مينفعش نكمله من غير الملف الأصلي. لازم ترفعه تاني كملف جديد.'
    );
  }

  const { data: unfinishedRows, error: fetchErr } = await supabase
    .from('book_chunks')
    .select('id, page_number')
    .eq('book_id', bookId)
    .eq('chunk_type', 'image')
    .in('image_status', ['pending', 'caption_failed', 'caption_only']);
  if (fetchErr) throw new Error(`Supabase error fetching unfinished image rows: ${fetchErr.message}`);

  if (unfinishedRows.length === 0) {
    onProgress('✅ مفيش صور محتاجة إكمال في الكتاب ده — كله خلص خلاص.');
    return { resumed: 0, skipped: false };
  }

  onProgress(`🔄 لقيت ${unfinishedRows.length} صورة لسه محتاجة وصف/embedding — بكمل من هنا من غير ما نعيد أي حاجة خلصت...`);

  const { renderPageImages } = require('./pdf');
  const pageNumbers = unfinishedRows.map((r) => r.page_number);
  const images = await renderPageImages(pdfBuffer, { pageNumbers });
  const imageByPage = new Map(images.map((img) => [img.page_number, img]));

  const jobs = unfinishedRows
    .map((row) => ({ id: row.id, page_number: row.page_number, img: imageByPage.get(row.page_number) }))
    .filter((j) => j.img);

  const captionQuotaState = gemini.createCaptionQuotaState();
  const usageCollector = { embeddingCalls: [], generationCalls: [], failures: [] };
  const keyPool = env.GEMINI_API_KEYS;
  const imageConcurrency = Math.max(
    1,
    Math.min(MAX_CONCURRENT_IMAGE_PIPELINE, (keyPool.length || 1) * 2, jobs.length)
  );
  // Same random-batch-of-IMAGE_KEY_BATCH_SIZE-keys-per-IMAGE_KEY_BATCH_SIZE-images
  // scheme as ingestPageImages (see buildImageKeyAssignments above), so a
  // resumed pass spreads key usage the same way a fresh pass does.
  const imageKeyAssignments = buildImageKeyAssignments(jobs.length, keyPool);

  let done = 0;
  let processed = 0;
  let lastProgressAt = Date.now();
  let quotaExhaustedNoticeShown = false;

  const { timedOut } = await runWithConcurrency(
    jobs,
    imageConcurrency,
    async (job, idx, workerIndex) => {
      const preferredKey = imageKeyAssignments[idx];
      const success = await processOneImageJob(job, bookId, preferredKey, captionQuotaState, null);
      if (success) done += 1;

      if (captionQuotaState.fullyExhausted && !quotaExhaustedNoticeShown) {
        quotaExhaustedNoticeShown = true;
        onProgress('🚨 الكوتة خلصت تاني قبل ما نكمل كل الصور — اللي اتعالج لحد دلوقتي اتحفظ، شغّل /continue_book تاني لاحقًا.');
      }

      processed += 1;
      const now = Date.now();
      if (now - lastProgressAt > 4000 || processed >= jobs.length) {
        lastProgressAt = now;
        onProgress(`   ...🖼️ ${processed}/${jobs.length} (${done} خلصوا وصف+embedding كامل)`);
      }
    },
    SOFT_TIME_BUDGET_MS - (Date.now() - startTime)
  );

  // Recompute total_chunks so it reflects the true final state (text
  // chunks + every image row that's genuinely 'done') rather than
  // whatever was last set before this resume run.
  const { count: textCount } = await supabase
    .from('book_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', bookId)
    .eq('chunk_type', 'text');
  const { count: doneImageCount } = await supabase
    .from('book_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', bookId)
    .eq('chunk_type', 'image')
    .eq('image_status', 'done');
  await setBookFields(bookId, { total_chunks: (textCount || 0) + (doneImageCount || 0) });

  if (timedOut) {
    onProgress(
      `⚠️ الوقت خلص تاني قبل ما نخلص كل حاجة (${processed}/${jobs.length} اتعالجت، ${done} خلصوا). ` +
        `شغّل /continue_book ${bookId} تاني لاحقًا عشان تكمل الباقي.`
    );
  } else {
    onProgress(`✅ خلصنا! ${done}/${jobs.length} صورة اتعملها وصف حقيقي بنجاح.`);
  }

  // Re-checks the real remaining count itself — a no-op if this run
  // timed out or some pages are still failing, so the PDF stays
  // available for the next /continue_book. Only actually deletes once
  // every page for this book is genuinely done.
  const pdfBeforeCleanup = await getBook(bookId);
  const hadSourcePdf = !!pdfBeforeCleanup?.source_pdf_path;
  await cleanupSourcePdfIfComplete(bookId);
  if (hadSourcePdf && !timedOut) {
    const bookAfterCleanup = await getBook(bookId);
    if (!bookAfterCleanup?.source_pdf_path) {
      onProgress('🗑️ كل صور الكتاب خلصت وصف — اتمسحت نسخة الـ PDF الأصلية من التخزين توفيرًا للمساحة.');
    }
  }

  return { resumed: jobs.length, done, timedOut };
}

// ---------------------------------------------------------------------
// Legacy backfill: fixes book_chunks image rows that predate the
// pending/caption_failed status system entirely (image_status is null
// on them). Those older rows still carry their originally-rendered page
// bytes in image_base64 — persisting that column stopped happening
// later on (see the note above ingestPageImages) — but since they were
// never tagged with image_status, continueBookImages (which filters ON
// image_status) can't find or resume them at all. What DOES identify
// them reliably is that their content is still the exact hard-coded
// failed-caption placeholder text from processOneImageJob's catch branch
// ("... تعذر توليد وصف تلقائي لها)").
//
// Unlike continueBookImages, this never touches lib/pdf.js or
// source_pdf_path — every image byte it needs already sits in the row's
// own image_base64 column, so a book whose original PDF was lost
// (storeSourcePdf failure, "book-source-pdfs" bucket never created,
// etc. — see storeSourcePdf above) can still be fixed with this.
//
// bookId (optional): scope to one book; omit to sweep every book with
// one call — useful for a large cross-book backlog (thousands of rows)
// instead of having to run this once per book id from /books.
//
// LEGACY_FIX_BATCH_SIZE caps how many rows a SINGLE invocation pulls
// from the DB, not how many it can ever fix — same soft-time-budget
// pattern as every other pass in this file. Rows this call doesn't reach
// are left completely untouched (same placeholder content, same
// image_base64), so re-running the same command later just continues:
// a row that gets genuinely fixed no longer matches the placeholder-text
// filter below and naturally drops out of the next run's selection — no
// separate "already processed" bookkeeping is needed for successes. A
// row that fails AGAIN keeps the exact same placeholder content, so it's
// picked up again by the next run once quota/keys recover, instead of
// ever being silently skipped or miscounted as done.
const LEGACY_FIX_BATCH_SIZE = 250;
const LEGACY_FAILED_CAPTION_MARKER = 'تعذر توليد وصف تلقائي لها';

// Sniffs the image's mime type from the leading bytes of its base64 text
// — these legacy rows predate any column that recorded this explicitly.
// lib/pdf.js renderPageImages only ever produces JPEG or PNG, so this
// only needs to distinguish those two; falling back to JPEG (its
// default) rather than throwing means a genuinely malformed buffer still
// just fails cleanly inside captionImage below, like any other per-row
// failure this function already handles.
function sniffImageMimeType(base64) {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  return 'image/jpeg';
}

async function fixLegacyFailedImages(bookId, onProgress = () => {}) {
  const startTime = Date.now();
  // Same opt-in silencing switch as ingestNewBook/continueBookImages (see
  // the comment above their usageCollector) — without this, a batch of
  // LEGACY_FIX_BATCH_SIZE rows fired one "🔑 تم استخدام..." admin
  // notification per row's embedding call, which was pure spam for a
  // background fix job that already reports its own progress via
  // onProgress.
  const usageCollector = { embeddingCalls: [], generationCalls: [], failures: [] };

  let query = supabase
    .from('book_chunks')
    .select('id, book_id, page_number, image_base64')
    .eq('chunk_type', 'image')
    .like('content', `%${LEGACY_FAILED_CAPTION_MARKER}%`)
    .not('image_base64', 'is', null)
    .order('id', { ascending: true })
    .limit(LEGACY_FIX_BATCH_SIZE);

  if (bookId) query = query.eq('book_id', bookId);

  const { data: rows, error: fetchErr } = await query;
  if (fetchErr) throw new Error(`Supabase error fetching legacy failed image rows: ${fetchErr.message}`);

  if (rows.length === 0) {
    onProgress(
      `✅ مفيش صفوف قديمة فيها صور فشل توليد وصفها (ومعاها نسخة الصورة محفوظة) لسه محتاجة إصلاح` +
        `${bookId ? ` في كتاب #${bookId}` : ''}.`
    );
    return { scanned: 0, fixed: 0, stillFailed: 0, timedOut: false };
  }

  onProgress(
    `🔧 لقيت ${rows.length} صف قديم${bookId ? ` (كتاب #${bookId})` : ' (من كل الكتب)'} فيهم صور فشل توليد وصفها ` +
      `وباقي معاهم نسخة الصورة الأصلية — بحاول أصلحهم من غير ما أعيد رندر أي PDF...`
  );

  const jobs = rows.map((row) => ({
    id: row.id,
    book_id: row.book_id,
    page_number: row.page_number,
    img: { buffer: Buffer.from(row.image_base64, 'base64'), mimeType: sniffImageMimeType(row.image_base64) },
  }));

  // Same random-batch-of-IMAGE_KEY_BATCH_SIZE-keys-per-IMAGE_KEY_BATCH_SIZE-jobs
  // scheme as ingestPageImages/continueBookImages above (see
  // buildImageKeyAssignments), so this legacy pass spreads key usage the
  // same way every other image pass in this file does.
  const keyPool = env.GEMINI_API_KEYS;
  const imageKeyAssignments = buildImageKeyAssignments(jobs.length, keyPool);
  const imageConcurrency = Math.max(
    1,
    Math.min(MAX_CONCURRENT_IMAGE_PIPELINE, (keyPool.length || 1) * 2, jobs.length)
  );

  const captionQuotaState = gemini.createCaptionQuotaState();
  let fixed = 0;
  let processed = 0;
  let lastProgressAt = Date.now();
  let quotaExhaustedNoticeShown = false;

  const { timedOut } = await runWithConcurrency(
    jobs,
    imageConcurrency,
    async (job, idx) => {
      const preferredKey = imageKeyAssignments[idx];

      let content;
      try {
        content = await gemini.captionImage(job.img.buffer, job.img.mimeType, job.page_number, [], preferredKey, captionQuotaState);
      } catch (err) {
        // Failed again — row is left completely untouched (content,
        // image_base64, everything) so the next run's selection query
        // still finds it. This is the "only count real successes, never
        // a repeat failure" requirement: nothing here is marked done,
        // and nothing here silently disappears from future runs.
        console.error(
          `fixLegacyFailedImages: captionImage threw for row ${job.id} (book ${job.book_id}, page ${job.page_number}):`,
          err.message
        );
        if (captionQuotaState.fullyExhausted && !quotaExhaustedNoticeShown) {
          quotaExhaustedNoticeShown = true;
          onProgress(
            '🚨 كل مفاتيح Gemini خلصت الكوتة قبل ما نخلص الدفعة دي — شغّل نفس الأمر تاني بعدين، ' +
              'اللي اتصلح فعلاً اتصلح والباقي زي ما هو محفوظ.'
          );
        }
        processed += 1;
        return;
      }

      try {
        // Embeds the CAPTION TEXT (via embedTexts), never the raw image
        // bytes — same convention as every other image row in this file
        // (see the note on embedImages vs embedTexts above ingestPageImages).
        const [embedding] = await gemini.embedTexts([content], 'RETRIEVAL_DOCUMENT', [], usageCollector, preferredKey);
        // Real caption AND its embedding both succeeded — only now is it
        // safe to overwrite the placeholder. image_base64 is deliberately
        // LEFT IN PLACE either way (success or failure) — it's the only
        // copy of that page's rendered bytes this legacy row has, so
        // nothing here ever deletes it.
        const { error } = await supabase
          .from('book_chunks')
          .update({ content, embedding, image_status: 'done' })
          .eq('id', job.id);
        if (error) throw error;
        fixed += 1;
      } catch (err) {
        // Captioning itself succeeded but the embed/DB write failed —
        // deliberately do NOT write the real caption without its
        // embedding (a later run would then see non-placeholder content
        // and wrongly treat the row as already fixed, with no embedding
        // ever generated for it). Row (including image_base64) stays
        // exactly as it was, picked up again by the next run.
        console.error(
          `fixLegacyFailedImages: embed/update failed for row ${job.id} (book ${job.book_id}, page ${job.page_number}):`,
          err.message
        );
      }

      processed += 1;
      const now = Date.now();
      if (now - lastProgressAt > 4000 || processed >= jobs.length) {
        lastProgressAt = now;
        onProgress(`   ...🔧 ${processed}/${jobs.length} (${fixed} اتصلحوا فعليًا بوصف حقيقي)`);
      }
    },
    SOFT_TIME_BUDGET_MS - (Date.now() - startTime)
  );

  const stillFailed = jobs.length - fixed;
  onProgress(
    timedOut
      ? `⚠️ الوقت خلص قبل ما نخلص الدفعة دي (${processed}/${jobs.length}، ${fixed} اتصلحوا فعليًا). ` +
          'شغّل نفس الأمر تاني عشان تكمل — هيكمل من غير ما يعيد اللي خلص.'
      : `✅ خلصت الدفعة: ${fixed}/${jobs.length} صورة اتصلحت فعليًا بوصف حقيقي.` +
          (stillFailed > 0
            ? ` ${stillFailed} لسه فشلت (هتترجع تتحاول تاني لو شغّلت الأمر تاني، أو لو فيه دفعة تانية بعد الـ ${LEGACY_FIX_BATCH_SIZE} صف دول).`
            : '')
  );

  return { scanned: jobs.length, fixed, stillFailed, timedOut };
}
