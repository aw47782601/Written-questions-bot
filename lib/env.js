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
  GEMINI_GENERATION_MODEL: process.env.GEMINI_GENERATION_MODEL || 'gemini-2.0-flash',
  GEMINI_EMBEDDING_MODEL: process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004',

  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),

  BATCH_SIZE: parseInt(process.env.BATCH_SIZE || '10', 10),
  TOP_K_CHUNKS: parseInt(process.env.TOP_K_CHUNKS || '5', 10),
  MAX_DAILY_GEMINI_CALLS: parseInt(process.env.MAX_DAILY_GEMINI_CALLS || '1200', 10),
};
