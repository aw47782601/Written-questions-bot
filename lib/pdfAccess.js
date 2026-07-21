// Admin-controlled access to PDF answer *designs*, per design id (see
// lib/pdfDesigns.js for the registry). Mirrors the banned_users pattern in
// lib/botConfig.js: everything lives in the generic bot_config key/value
// store, so no DB migration is needed.
//
// For each design there are two independent settings, namespaced by
// designId so every design gets its own, fully separate access control:
//   - pdf_access_mode_<designId>: { mode: 'all' | 'whitelist' } — 'all'
//     (default) means every user can use this design; 'whitelist'
//     restricts it to admins plus whoever's in that design's whitelist.
//   - pdf_access_whitelist_<designId>: { ids: ["123", "456", ...] } —
//     string user ids, managed via the admin's button-driven "🎨 صلاحيات
//     تصاميم الـ PDF" panel (see handlePdfAccessPanel and friends in
//     api/telegram-webhook.js). Kept (and still readable) even while mode
//     is 'all', so switching a design back to 'whitelist' later doesn't
//     lose the group an admin already built up.
const botConfig = require('./botConfig');

function modeKey(designId) {
  return `pdf_access_mode_${designId}`;
}
function whitelistKey(designId) {
  return `pdf_access_whitelist_${designId}`;
}

async function getAccessMode(designId) {
  const cfg = await botConfig.getConfig(modeKey(designId));
  return cfg && cfg.mode === 'whitelist' ? 'whitelist' : 'all';
}

async function setAccessMode(designId, mode) {
  await botConfig.setConfig(modeKey(designId), { mode: mode === 'whitelist' ? 'whitelist' : 'all' });
}

async function getWhitelist(designId) {
  const cfg = await botConfig.getConfig(whitelistKey(designId));
  return cfg && Array.isArray(cfg.ids) ? cfg.ids : [];
}

async function setWhitelist(designId, ids) {
  await botConfig.setConfig(whitelistKey(designId), { ids });
}

async function addToWhitelist(designId, userId) {
  const ids = await getWhitelist(designId);
  const idStr = String(userId);
  if (!ids.includes(idStr)) {
    ids.push(idStr);
    await setWhitelist(designId, ids);
  }
  return ids;
}

// Returns true if the id was in the whitelist (and got removed), false if
// it wasn't there to begin with.
async function removeFromWhitelist(designId, userId) {
  const ids = await getWhitelist(designId);
  const idStr = String(userId);
  const filtered = ids.filter((id) => id !== idStr);
  const removed = filtered.length !== ids.length;
  if (removed) await setWhitelist(designId, filtered);
  return removed;
}

// isAdminFn is passed in (rather than importing api/telegram-webhook.js,
// which would be circular) so admins always retain access to every design
// regardless of mode/whitelist contents.
async function isDesignAllowed(designId, userId, isAdminFn) {
  if (isAdminFn && isAdminFn(userId)) return true;
  const mode = await getAccessMode(designId);
  if (mode === 'all') return true;
  const ids = await getWhitelist(designId);
  return ids.includes(String(userId));
}

// Returns the subset of lib/pdfDesigns.js's registry that this user is
// currently allowed to use, in registry order. An empty array means "no
// PDF format at all for this user" — that's what the per-batch format
// keyboard checks to decide whether to show the PDF/Both buttons at all.
async function getAccessibleDesigns(userId, isAdminFn) {
  // Required here (not at module top) to avoid a require cycle, since
  // pdfDesigns.js doesn't itself depend on this module — this is just to
  // keep the dependency direction obvious/one-way in the file layout.
  const { listDesigns } = require('./pdfDesigns');
  const designs = listDesigns();
  const flags = await Promise.all(designs.map((d) => isDesignAllowed(d.id, userId, isAdminFn)));
  return designs.filter((_, i) => flags[i]);
}

module.exports = {
  getAccessMode,
  setAccessMode,
  getWhitelist,
  setWhitelist,
  addToWhitelist,
  removeFromWhitelist,
  isDesignAllowed,
  getAccessibleDesigns,
};
