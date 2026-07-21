// Admin-controlled access to the PDF answer format. Mirrors the
// banned_users pattern in lib/botConfig.js: everything lives in the
// generic bot_config key/value store, so no DB migration is needed.
//
// Two independent settings:
//   - pdf_access_mode: { mode: 'all' | 'whitelist' } — 'all' (default)
//     means every user can request the PDF format; 'whitelist' restricts
//     it to admins plus whoever's in pdf_access_whitelist.
//   - pdf_access_whitelist: { ids: ["123", "456", ...] } — string user ids,
//     managed via /pdfallow and /pdfdisallow. Kept (and still readable)
//     even while mode is 'all', so switching back to 'whitelist' later
//     doesn't lose the list an admin already built up.
const botConfig = require('./botConfig');

const CONFIG_KEY_MODE = 'pdf_access_mode';
const CONFIG_KEY_WHITELIST = 'pdf_access_whitelist';

async function getAccessMode() {
  const cfg = await botConfig.getConfig(CONFIG_KEY_MODE);
  return cfg && cfg.mode === 'whitelist' ? 'whitelist' : 'all';
}

async function setAccessMode(mode) {
  await botConfig.setConfig(CONFIG_KEY_MODE, { mode: mode === 'whitelist' ? 'whitelist' : 'all' });
}

async function getWhitelist() {
  const cfg = await botConfig.getConfig(CONFIG_KEY_WHITELIST);
  return cfg && Array.isArray(cfg.ids) ? cfg.ids : [];
}

async function setWhitelist(ids) {
  await botConfig.setConfig(CONFIG_KEY_WHITELIST, { ids });
}

async function addToWhitelist(userId) {
  const ids = await getWhitelist();
  const idStr = String(userId);
  if (!ids.includes(idStr)) {
    ids.push(idStr);
    await setWhitelist(ids);
  }
  return ids;
}

// Returns true if the id was in the whitelist (and got removed), false if
// it wasn't there to begin with.
async function removeFromWhitelist(userId) {
  const ids = await getWhitelist();
  const idStr = String(userId);
  const filtered = ids.filter((id) => id !== idStr);
  const removed = filtered.length !== ids.length;
  if (removed) await setWhitelist(filtered);
  return removed;
}

// isAdminFn is passed in (rather than importing api/telegram-webhook.js,
// which would be circular) so admins always retain PDF access regardless
// of the whitelist mode/contents.
async function isPdfAllowed(userId, isAdminFn) {
  if (isAdminFn && isAdminFn(userId)) return true;
  const mode = await getAccessMode();
  if (mode === 'all') return true;
  const ids = await getWhitelist();
  return ids.includes(String(userId));
}

module.exports = {
  getAccessMode,
  setAccessMode,
  getWhitelist,
  setWhitelist,
  addToWhitelist,
  removeFromWhitelist,
  isPdfAllowed,
};
