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

module.exports = { retrieveChunks, keywordSearchChunks, debugRetrieve };
