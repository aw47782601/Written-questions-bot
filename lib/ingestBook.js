const supabase = require('./supabaseClient');
const gemini = require('./gemini');
const { extractPagesFromPdf } = require('./pdf');
const { chunkPages } = require('./chunker');

const EMBED_BATCH_SIZE = 20; // conservative batch size per embedding call
const BATCH_DELAY_MS = 15000; // pace batches to stay under the free-tier 100/min embed quota

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setBookStatus(fields) {
  await supabase
    .from('book_meta')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', 1);
}

// Replaces the currently active book with a new one.
// onProgress(message) is optional, called at each major step so the
// caller can relay progress to the admin over Telegram.
async function ingestBook(pdfBuffer, fileName, onProgress = () => {}) {
  await setBookStatus({ status: 'processing', file_name: fileName, error_message: null });

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

    // Clear old chunks before inserting new ones (single active book).
    await supabase.from('book_chunks').delete().neq('id', 0);

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await gemini.embedTexts(batch.map((c) => c.content));

      const rows = batch.map((c, idx) => ({
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

    await setBookStatus({
      status: 'ready',
      total_pages: pages.length,
      total_chunks: chunks.length,
      error_message: null,
    });

    return { pages: pages.length, chunks: chunks.length };
  } catch (err) {
    await setBookStatus({ status: 'error', error_message: err.message });
    throw err;
  }
}

async function getBookStatus() {
  const { data, error } = await supabase.from('book_meta').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}

module.exports = { ingestBook, getBookStatus };
