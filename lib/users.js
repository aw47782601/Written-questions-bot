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

async function getUserData(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    console.error('getUserData error:', error.message);
    return null;
  }
  return data;
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

// Global stats for /stats. Adapted to this bot's own tables (users /
// qa_cache) instead of the source bot's processing_logs / model
// breakdown, which don't exist here.
async function getGlobalStats() {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [usersTotal, usersActiveToday, cacheTotal] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact', head: true }),
    supabase.from('users').select('*', { count: 'exact', head: true }).gte('last_active', startOfDay.toISOString()),
    supabase.from('qa_cache').select('*', { count: 'exact', head: true }),
  ]);

  return {
    users: { total: usersTotal.count || 0, active: usersActiveToday.count || 0 },
    cachedAnswers: cacheTotal.count || 0,
  };
}

async function getUserStats(targetId) {
  const user = await getUserData(targetId);
  if (!user) return null;
  return user;
}

module.exports = {
  upsertUser,
  getUserData,
  getAllUserIds,
  checkAndSendAlert,
  getGlobalStats,
  getUserStats,
};
