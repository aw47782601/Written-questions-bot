const supabase = require('./supabaseClient');
const env = require('./env');

// Returns top-K most relevant chunks for a given question embedding.
async function retrieveChunks(embedding, topK = env.TOP_K_CHUNKS) {
  const { data, error } = await supabase.rpc('match_book_chunks', {
    query_embedding: embedding,
    match_count: topK,
  });
  if (error) throw new Error(`Supabase similarity search error: ${error.message}`);
  return data; // [{ id, content, page_number, similarity }]
}

module.exports = { retrieveChunks };
