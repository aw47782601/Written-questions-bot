const supabase = require('./supabaseClient');

// --- Generic bot_config key/value store ---------------------------------

async function getConfig(key) {
  const { data, error } = await supabase.from('bot_config').select('value').eq('key', key).maybeSingle();
  if (error) {
    console.error('bot_config get error:', error.message);
    return null;
  }
  return data ? data.value : null;
}

async function setConfig(key, value) {
  const { error } = await supabase
    .from('bot_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) console.error('bot_config set error:', error.message);
}

async function deleteConfig(key) {
  const { error } = await supabase.from('bot_config').delete().eq('key', key);
  if (error) console.error('bot_config delete error:', error.message);
}

// --- Maintenance mode -----------------------------------------------------
// Stored in Supabase (not an in-memory flag) because Vercel serverless
// functions don't share memory across invocations/instances — an
// in-memory toggle would only ever apply to whichever instance handled
// the /repairon request.

async function getMaintenanceMode() {
  const cfg = await getConfig('maintenance_mode');
  return !!(cfg && cfg.enabled);
}

async function setMaintenanceMode(enabled) {
  await setConfig('maintenance_mode', { enabled: !!enabled });
}

// --- Banned users -----------------------------------------------------------
// Stored as { ids: ["123", "456", ...] } (string user ids).

async function getBannedUsers() {
  const cfg = await getConfig('banned_users');
  return cfg && Array.isArray(cfg.ids) ? cfg.ids : [];
}

async function setBannedUsers(ids) {
  await setConfig('banned_users', { ids });
}

async function isUserBanned(userId) {
  const banned = await getBannedUsers();
  return banned.includes(String(userId));
}

// --- Scheduled block periods (e.g. exam times) -----------------------------
// Stored as { periods: [{ id, startAt, endAt, label }] }. startAt/endAt are
// absolute UTC ISO instants — already converted once, at creation time,
// from whatever Cairo-local wall-clock time the admin typed (see
// lib/cairoTime.js) — so checking "are we inside a period right now" later
// is a plain timestamp comparison with no timezone-awareness needed at
// check time.

async function getBlockedPeriods() {
  const cfg = await getConfig('blocked_periods');
  return cfg && Array.isArray(cfg.periods) ? cfg.periods : [];
}

async function setBlockedPeriods(periods) {
  await setConfig('blocked_periods', { periods });
}

async function addBlockedPeriod(startAt, endAt, label) {
  const periods = await getBlockedPeriods();
  const id = periods.length > 0 ? Math.max(...periods.map((p) => p.id)) + 1 : 1;
  periods.push({ id, startAt, endAt, label: label || null });
  await setBlockedPeriods(periods);
  return id;
}

async function removeBlockedPeriod(id) {
  const periods = await getBlockedPeriods();
  const filtered = periods.filter((p) => p.id !== id);
  const removed = filtered.length !== periods.length;
  if (removed) await setBlockedPeriods(filtered);
  return removed;
}

// Returns whichever stored period `now` currently falls inside, or null if
// none does (i.e. the bot should behave normally). While it's at it, drops
// any periods that have fully ended so the list doesn't grow forever with
// stale entries — but only writes back to Supabase when something was
// actually removed, so a normal check (the common case) doesn't cost an
// extra write on every single incoming message.
async function getActiveBlockedPeriod(now = new Date()) {
  const periods = await getBlockedPeriods();
  const nowMs = now.getTime();

  const stillRelevant = periods.filter((p) => Date.parse(p.endAt) > nowMs);
  if (stillRelevant.length !== periods.length) {
    await setBlockedPeriods(stillRelevant);
  }

  return stillRelevant.find((p) => nowMs >= Date.parse(p.startAt)) || null;
}

module.exports = {
  getConfig,
  setConfig,
  deleteConfig,
  getMaintenanceMode,
  setMaintenanceMode,
  getBannedUsers,
  setBannedUsers,
  isUserBanned,
  getBlockedPeriods,
  setBlockedPeriods,
  addBlockedPeriod,
  removeBlockedPeriod,
  getActiveBlockedPeriod,
};
