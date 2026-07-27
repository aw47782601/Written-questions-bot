const supabase = require('./supabaseClient');
const gemini = require('./gemini');
const env = require('./env');

// Returns top-K most relevant chunks for a given question embedding,
// scoped to a single book (bookId). bookId is required in normal use —
// every question is answered against exactly one book, the one the
// asking user has selected via /mybook.
async function retrieveChunks(embedding, bookId, topK = env.TOP_K_CHUNKS) {
  const { data, error } = await supabase.rpc('match_book_chunks', {
    query_embedding: embedding,
    match_count: topK,
    filter_book_id: bookId ?? null,
  });
  if (error) throw new Error(`Supabase similarity search error: ${error.message}`);
  return data; // [{ id, content, page_number, similarity }]
}

// Looks up any chunk_type='image' rows for the given page numbers, keyed
// by page_number → image_base64. Used to attach the actual rendered page
// image to an answer whose cited page has an image chunk (see
// lib/batchAnswer.js / lib/answeredBatches.js).
//
// Deliberately does NOT rely on retrieveChunks()/match_book_chunks for
// this — that RPC only returns { id, content, page_number, similarity }
// (see retrieveChunks above), with no chunk_type or image_base64 at all.
// An earlier version of the answer-attaching code searched for
// `c.chunk_type === 'image' && c.image_base64` inside the chunks
// retrieveChunks() had already returned, which meant that match could
// never succeed — image_base64 (and chunk_type) simply weren't there to
// match against, so a cited page's analyzed image never made it into the
// delivered answer even when captioning/embedding had both worked fine.
// Querying book_chunks directly here, independent of whatever columns
// match_book_chunks happens to project, fixes that regardless of the
// RPC's own return shape.
async function getImagePagesMap(bookId, pageNumbers) {
  const uniquePages = [...new Set((pageNumbers || []).filter((p) => p != null))];
  if (!bookId || uniquePages.length === 0) return new Map();

  const { data, error } = await supabase
    .from('book_chunks')
    .select('page_number, image_base64')
    .eq('book_id', bookId)
    .eq('chunk_type', 'image')
    .in('page_number', uniquePages);
  if (error) throw new Error(`Supabase image chunk lookup error: ${error.message}`);

  const map = new Map();
  for (const row of data || []) {
    if (row.image_base64) map.set(row.page_number, row.image_base64);
  }
  return map;
}

// DIAGNOSTIC: plain-text search on book_chunks, bypassing embeddings
// entirely. If a keyword you know is in the book returns nothing here,
// the problem is ingestion/chunking (content never made it into the
// table). If it DOES return rows here but retrieveChunks() finds
// nothing relevant for the same topic, the problem is the embedding
// model/vector search, not the content itself.
async function keywordSearchChunks(keyword, bookId = null, limit = 5) {
  let query = supabase.from('book_chunks').select('id, content, page_number').ilike('content', `%${keyword}%`).limit(limit);
  if (bookId) query = query.eq('book_id', bookId);
  const { data, error } = await query;
  if (error) throw new Error(`Supabase keyword search error: ${error.message}`);
  return data;
}

// DIAGNOSTIC: runs the exact same embed+retrieve pipeline a real
// question would use, but returns the raw matched chunks with their
// similarity scores instead of feeding them to the LLM. Low similarity
// scores across the board on a topic you know is in the book points to
// an embedding-model mismatch between ingestion time and now.
async function debugRetrieve(question, bookId = null, topK = env.TOP_K_CHUNKS) {
  const [embedding] = await gemini.embedTexts([question], 'RETRIEVAL_QUERY');
  return retrieveChunks(embedding, bookId, topK);
}

module.exports = { retrieveChunks, getImagePagesMap, keywordSearchChunks, debugRetrieve };
