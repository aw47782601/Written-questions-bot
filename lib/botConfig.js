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

module.exports = {
  getConfig,
  setConfig,
  deleteConfig,
  getMaintenanceMode,
  setMaintenanceMode,
  getBannedUsers,
  setBannedUsers,
  isUserBanned,
};
