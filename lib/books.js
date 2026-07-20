const supabase = require('./supabaseClient');
const gemini = require('./gemini');
const { extractPagesFromPdf } = require('./pdf');
const { chunkPages } = require('./chunker');

const EMBED_BATCH_SIZE = 20; // conservative batch size per embedding call
const BATCH_DELAY_MS = 15000; // pace batches to stay under the free-tier per-minute embed quota

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function deleteBook(bookId) {
  // book_chunks.book_id has ON DELETE CASCADE, so this also removes its
  // chunks.
  const { error } = await supabase.from('books').delete().eq('id', bookId);
  if (error) throw new Error(`Supabase error deleting book: ${error.message}`);
}

// Adds a new book (does NOT touch any existing book — multiple books
// can coexist, each user picks which one they want via /mybook).
// onProgress(message) is optional, called at each major step so the
// caller can relay progress to the admin over Telegram.
async function ingestNewBook(pdfBuffer, fileName, bookName, onProgress = () => {}) {
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

    onProgress(`🧠 بعمل embeddings لـ ${chunks.length} جزء (هياخد شوية وقت)...`);

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await gemini.embedTexts(batch.map((c) => c.content), 'RETRIEVAL_DOCUMENT');

      const rows = batch.map((c, idx) => ({
        book_id: bookId,
        content: c.content,
        page_number: c.page_number,
        embedding: vectors[idx],
      }));

      const { error } = await supabase.from('book_chunks').insert(rows);
      if (error) throw new Error(`Supabase insert error: ${error.message}`);

      onProgress(`   ...${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}/${chunks.length}`);

      const isLastBatch = i + EMBED_BATCH_SIZE >= chunks.length;
      if (!isLastBatch) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    await setBookFields(bookId, {
      status: 'ready',
      total_pages: pages.length,
      total_chunks: chunks.length,
      error_message: null,
    });

    return { id: bookId, pages: pages.length, chunks: chunks.length };
  } catch (err) {
    await setBookFields(bookId, { status: 'error', error_message: err.message });
    throw err;
  }
}

module.exports = { listBooks, listReadyBooks, getBook, deleteBook, ingestNewBook };
