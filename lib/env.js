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
  GEMINI_EMBEDDING_MODEL: process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004',

  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),

  BATCH_SIZE: parseInt(process.env.BATCH_SIZE || '10', 10),
  TOP_K_CHUNKS: parseInt(process.env.TOP_K_CHUNKS || '8', 10),
  MAX_DAILY_GEMINI_CALLS: parseInt(process.env.MAX_DAILY_GEMINI_CALLS || '1200', 10),
};
