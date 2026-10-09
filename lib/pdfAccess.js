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

// ---------------------------------------------------------------------------
// Bulk helpers (many ids in one go)
// ---------------------------------------------------------------------------

// Accepts Arabic-Indic (٠-٩) and Persian (۰-۹) digits too, since admins
// often paste ids from chats that use them.
function normalizeDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}

// Turns free text ("123 456, 789\n111") into { valid, invalid, duplicates }.
// Separators: whitespace / newline / , ; | and their Arabic forms (، ؛).
function parseIds(text) {
  const tokens = normalizeDigits(text || '')
    .split(/[\s,;،؛|]+/)
    .filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  for (const t of tokens) {
    if (/^\d{1,15}$/.test(t)) {
      if (seen.has(t)) duplicates++;
      else {
        seen.add(t);
        valid.push(t);
      }
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid, duplicates };
}

// One read + one write no matter how many ids. Returns which ids were new
// vs. already in the whitelist.
async function addManyToWhitelist(designId, userIds) {
  const ids = await getWhitelist(designId);
  const have = new Set(ids);
  const added = [];
  const already = [];
  for (const raw of userIds) {
    const id = String(raw);
    if (have.has(id)) already.push(id);
    else {
      have.add(id);
      ids.push(id);
      added.push(id);
    }
  }
  if (added.length > 0) await setWhitelist(designId, ids);
  return { added, already };
}

async function removeManyFromWhitelist(designId, userIds) {
  const ids = await getWhitelist(designId);
  const drop = new Set(userIds.map(String));
  const removed = ids.filter((id) => drop.has(id));
  const missing = [...drop].filter((id) => !ids.includes(id));
  if (removed.length > 0) await setWhitelist(designId, ids.filter((id) => !drop.has(id)));
  return { removed, missing };
}

// ---------------------------------------------------------------------------
// Saved id sets (e.g. "Class A") that can be activated on many designs at once.
// Stored as bot_config 'pdf_access_sets': { sets: [{ id, name, ids: [...] }] }
// ---------------------------------------------------------------------------
const SETS_KEY = 'pdf_access_sets';

async function getSets() {
  const cfg = await botConfig.getConfig(SETS_KEY);
  return cfg && Array.isArray(cfg.sets) ? cfg.sets : [];
}

async function saveSets(sets) {
  await botConfig.setConfig(SETS_KEY, { sets });
}

async function getSet(setId) {
  const sets = await getSets();
  return sets.find((s) => String(s.id) === String(setId)) || null;
}

async function createSet(name, ids) {
  const sets = await getSets();
  const id = sets.length > 0 ? Math.max(...sets.map((s) => Number(s.id) || 0)) + 1 : 1;
  const set = { id, name, ids: [...new Set(ids.map(String))] };
  sets.push(set);
  await saveSets(sets);
  return set;
}

// Returns the updated set, or null if the set doesn't exist.
async function addToSet(setId, userIds) {
  const sets = await getSets();
  const set = sets.find((s) => String(s.id) === String(setId));
  if (!set) return null;
  const have = new Set(set.ids);
  const added = [];
  const already = [];
  for (const raw of userIds) {
    const id = String(raw);
    if (have.has(id)) already.push(id);
    else {
      have.add(id);
      set.ids.push(id);
      added.push(id);
    }
  }
  if (added.length > 0) await saveSets(sets);
  return { set, added, already };
}

async function removeFromSet(setId, userIds) {
  const sets = await getSets();
  const set = sets.find((s) => String(s.id) === String(setId));
  if (!set) return null;
  const drop = new Set(userIds.map(String));
  const removed = set.ids.filter((id) => drop.has(id));
  const missing = [...drop].filter((id) => !set.ids.includes(id));
  if (removed.length > 0) {
    set.ids = set.ids.filter((id) => !drop.has(id));
    await saveSets(sets);
  }
  return { set, removed, missing };
}

async function deleteSet(setId) {
  const sets = await getSets();
  const filtered = sets.filter((s) => String(s.id) !== String(setId));
  if (filtered.length === sets.length) return false;
  await saveSets(filtered);
  return true;
}

// Adds (action 'add') or removes (action 'remove') the same ids on several
// designs. With opts.restrict, designs still in 'all' mode are switched to
// 'whitelist' on add so the ids actually take effect.
// Returns [{ designId, changed, unchanged, mode }] in the order given.
async function applyToDesigns(designIds, userIds, action, opts = {}) {
  const out = [];
  for (const designId of designIds) {
    let changed;
    let unchanged;
    if (action === 'remove') {
      const r = await removeManyFromWhitelist(designId, userIds);
      changed = r.removed.length;
      unchanged = r.missing.length;
    } else {
      const r = await addManyToWhitelist(designId, userIds);
      changed = r.added.length;
      unchanged = r.already.length;
      if (opts.restrict && (await getAccessMode(designId)) === 'all') {
        await setAccessMode(designId, 'whitelist');
      }
    }
    out.push({ designId, changed, unchanged, mode: await getAccessMode(designId) });
  }
  return out;
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
  parseIds,
  addManyToWhitelist,
  removeManyFromWhitelist,
  getSets,
  getSet,
  createSet,
  addToSet,
  removeFromSet,
  deleteSet,
  applyToDesigns,
  isDesignAllowed,
  getAccessibleDesigns,
};
