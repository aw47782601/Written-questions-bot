const supabase = require('./supabaseClient');
const env = require('./env');

class DailyLimitReachedError extends Error {}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Atomically increments today's Gemini call counter. Throws if this
// would push usage past MAX_DAILY_GEMINI_CALLS.
async function checkAndIncrement(count) {
  const { data, error } = await supabase.rpc('increment_usage', {
    inc: count,
    d: today(),
  });
  if (error) throw new Error(`Usage tracking error: ${error.message}`);

  if (data > env.MAX_DAILY_GEMINI_CALLS) {
    throw new DailyLimitReachedError(
      `تم الوصول للحد الأقصى من الطلبات المسموح بها اليوم (${env.MAX_DAILY_GEMINI_CALLS}). جرب تاني بكرة.`
    );
  }
  return data;
}

module.exports = { checkAndIncrement, DailyLimitReachedError };
