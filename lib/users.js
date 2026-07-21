const supabase = require('./supabaseClient');
const botConfig = require('./botConfig');

// Upserts the user's profile + last_active timestamp. Pass alertIdSeen to
// also mark that they've now seen a given /setalert broadcast.
async function upsertUser(user, alertIdSeen = null) {
  if (!user || !user.id) return;
  const payload = {
    user_id: user.id,
    first_name: user.first_name || null,
    username: user.username || null,
    last_active: new Date().toISOString(),
  };
  if (alertIdSeen) payload.seen_alert_id = alertIdSeen;

  const { error } = await supabase.from('users').upsert(payload, { onConflict: 'user_id' });
  if (error) console.error('upsertUser error:', error.message);
}

// Same as upsertUser, but first checks whether the user already existed
// so the caller can notify the admin about genuinely new users only.
// Returns true if this user was NOT in the table before this call.
async function upsertUserAndCheckNew(user) {
  if (!user || !user.id) return false;
  const existing = await getUserData(user.id);
  await upsertUser(user);
  return !existing;
}

async function getUserData(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    console.error('getUserData error:', error.message);
    return null;
  }
  return data;
}

// Lightweight count-only query (head: true → no rows returned), used to
// show "total users so far" in the new-user admin notification without
// paying for the full getGlobalStats() round trip.
async function getTotalUserCount() {
  const { count, error } = await supabase.from('users').select('*', { count: 'exact', head: true });
  if (error) {
    console.error('getTotalUserCount error:', error.message);
    return null;
  }
  return count || 0;
}

async function getAllUserIds() {
  const { data, error } = await supabase.from('users').select('user_id');
  if (error) {
    console.error('getAllUserIds error:', error.message);
    return [];
  }
  return data.map((r) => r.user_id);
}

// Sends the current /setalert message once per user (tracked via
// seen_alert_id), typically called on /start.
async function checkAndSendAlert(chatId, user, sendMessage) {
  const alertCfg = await botConfig.getConfig('global_alert');
  if (!alertCfg || !alertCfg.text || !alertCfg.id) {
    await upsertUser(user);
    return;
  }
  const dbUser = await getUserData(user.id);
  if (!dbUser || dbUser.seen_alert_id !== alertCfg.id) {
    await sendMessage(chatId, `🔔 *تنويه هام:*\n\n${alertCfg.text}`);
    await upsertUser(user, alertCfg.id);
  } else {
    await upsertUser(user);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Global stats for /stats. Uses the real tables: users, and api_usage
// (usage_date, request_count) for today's Gemini call volume. qa_cache
// is gone — the answer cache was dropped as not useful.
async function getGlobalStats() {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [usersTotal, usersActiveToday, usageToday] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact', head: true }),
    supabase.from('users').select('*', { count: 'exact', head: true }).gte('last_active', startOfDay.toISOString()),
    supabase.from('api_usage').select('request_count').eq('usage_date', today()).maybeSingle(),
  ]);

  return {
    users: { total: usersTotal.count || 0, active: usersActiveToday.count || 0 },
    geminiCallsToday: usageToday.data?.request_count || 0,
  };
}

async function getUserStats(targetId) {
  const user = await getUserData(targetId);
  if (!user) return null;
  return user;
}

// --- Per-user selected book (multi-book support) -------------------------
// Each user picks which book their questions get answered against via
// /mybook, stored on users.selected_book_id. Persists across sessions so
// they don't have to pick every time.

async function getSelectedBookId(userId) {
  const user = await getUserData(userId);
  return user ? user.selected_book_id : null;
}

async function setSelectedBookId(userId, bookId) {
  const { error } = await supabase
    .from('users')
    .update({ selected_book_id: bookId })
    .eq('user_id', userId);
  if (error) console.error('setSelectedBookId error:', error.message);
}

// NOTE: there used to be a persistent per-user answer-format preference
// here (users.answer_format, set via /format). That's gone — the user is
// now asked which format they want (text / PDF / both) for every batch of
// questions via inline buttons instead of a standing default. See
// lib/pendingBatches.js and the ansfmt_ callback in api/telegram-webhook.js.
// No DB migration is needed for that flow (see migrations/add_answer_format.sql).

module.exports = {
  upsertUser,
  upsertUserAndCheckNew,
  getUserData,
  getAllUserIds,
  getTotalUserCount,
  checkAndSendAlert,
  getGlobalStats,
  getUserStats,
  getSelectedBookId,
  setSelectedBookId,
};
