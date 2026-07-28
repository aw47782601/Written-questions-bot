function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Supports multiple comma-separated Gemini API keys (GEMINI_API_KEYS) to
// spread requests across separate quotas. Falls back to a single
// GEMINI_API_KEY for backward compatibility.
function resolveGeminiApiKeys() {
  const multi = (process.env.GEMINI_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length > 0) return multi;
  return [required('GEMINI_API_KEY')];
}

module.exports = {
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  ADMIN_CHAT_IDS: (process.env.ADMIN_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  GEMINI_API_KEYS: resolveGeminiApiKeys(),
  // Three-tier generation model fallback (see lib/gemini.js for the
  // key×model retry sequence that uses these):
  //   1. GEMINI_GENERATION_MODEL          — tried first, on every key
  //   2. GEMINI_GENERATION_MODEL_FALLBACK — tried second, on every key
  //   3. GEMINI_GENERATION_MODEL_LITE     — last resort, tried on every
  //      key only after both models above have failed on all keys
  // gemini-2.0-flash was retired 2026-06-01, gemini-2.5-flash was retired
  // shortly after. Updated late July 2026: gemini-3.6-flash (GA, newest
  // and most capable/efficient Flash model, launched 2026-07-21) is now
  // primary, with gemini-3.5-flash and gemini-3-flash-preview as
  // fallbacks — check https://ai.google.dev/gemini-api/docs/models
  // before relying on these long-term, model names get retired.
  // IMPORTANT: gemini-3.6-flash (and Gemini-3-generation models in
  // general) use the newer `thinkingLevel` config, not the older
  // `thinkingBudget` — see getThinkingConfig() in lib/gemini.js, which
  // picks the right shape per model. Sending thinkingBudget to
  // gemini-3.6-flash is a hard 400 INVALID_ARGUMENT (it no longer has
  // backward-compat for that field, unlike gemini-3.5-flash).
  GEMINI_GENERATION_MODEL: process.env.GEMINI_GENERATION_MODEL || 'gemini-3.6-flash',
  GEMINI_GENERATION_MODEL_FALLBACK: process.env.GEMINI_GENERATION_MODEL_FALLBACK || 'gemini-3.5-flash',
  GEMINI_GENERATION_MODEL_LITE: process.env.GEMINI_GENERATION_MODEL_LITE || 'gemini-3-flash-preview',
  // Used only for question/chapter extraction (lib/questionExtractor.js) —
  // a cheap, fast structuring task (split raw pasted/PDF text into
  // individual questions and tag each with the chapter name that precedes
  // it, if any), deliberately kept separate from the 3-tier RAG-answer
  // model chain above since it doesn't need a heavier model.
  GEMINI_EXTRACTION_MODEL: process.env.GEMINI_EXTRACTION_MODEL || 'gemini-flash-lite-latest',
  // Embedding model for both text chunks AND image chunks. Image chunks
  // (see lib/books.js ingestPageImages) are captioned by a vision model
  // first, then the CAPTION TEXT is embedded through the exact same
  // embedTexts() path as any regular text chunk — the raw image pixels
  // are never embedded directly (see lib/gemini.js's now-unused
  // embedImages, kept only in case a future caller wants true multimodal
  // embedding). Because of that, GEMINI_EMBEDDING_MODEL does NOT need to
  // be a multimodal model (gemini-embedding-2+) for image chunks to work
  // — a plain text-only model like the text-embedding-004 default below
  // is fine.
  GEMINI_EMBEDDING_MODEL: process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004',
  // Whether book ingestion also renders each PDF page to an image,
  // captions it, and embeds that caption's text into book_chunks as a
  // chunk_type='image' row (see lib/books.js ingestPageImages). Off by
  // default: it roughly doubles Gemini calls per book (one caption call +
  // one embed call per page) and only helps when answers live in
  // diagrams/figures rather than text.
  ENABLE_IMAGE_CHUNKS: process.env.ENABLE_IMAGE_CHUNKS === 'true',
  // Hard cap on how many pages of a single book get rendered+captioned+
  // embedded as images, so a huge book can't silently balloon ingestion
  // time/cost. Books with more pages than this just skip image-chunking
  // (text chunks still cover the whole book as before).
  MAX_IMAGE_PAGES_PER_BOOK: parseInt(process.env.MAX_IMAGE_PAGES_PER_BOOK || '80', 10),

  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),

  BATCH_SIZE: parseInt(process.env.BATCH_SIZE || '10', 10),
  TOP_K_CHUNKS: parseInt(process.env.TOP_K_CHUNKS || '8', 10),
  MAX_DAILY_GEMINI_CALLS: parseInt(process.env.MAX_DAILY_GEMINI_CALLS || '1200', 10),
};
