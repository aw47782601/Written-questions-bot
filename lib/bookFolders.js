// Book folders — lets the admin group a large book list (30+) into named
// folders from /books, and lets regular users browse books folder-first
// from /mybook. Deliberately stored in the existing generic bot_config
// key/value table (same pattern as blocked_periods/banned_users in
// lib/botConfig.js) instead of a new Supabase table/column — no schema
// migration needed, and books.js/listBooks() stays untouched.
//
// Shape stored under bot_config key 'book_folders':
//   { folders: [{ id, name }], assignments: { "<bookId>": folderId } }
// A book with no entry in `assignments` is "unfiled" — shown under the
// pseudo-folder key UNFILED_KEY ('none') everywhere in the UI.
const botConfig = require('./botConfig');

const CONFIG_KEY = 'book_folders';
const UNFILED_KEY = 'none';

async function getFoldersState() {
  const cfg = await botConfig.getConfig(CONFIG_KEY);
  return {
    folders: cfg && Array.isArray(cfg.folders) ? cfg.folders : [],
    assignments: cfg && cfg.assignments && typeof cfg.assignments === 'object' ? cfg.assignments : {},
  };
}

async function setFoldersState(state) {
  await botConfig.setConfig(CONFIG_KEY, state);
}

async function listFolders() {
  const { folders } = await getFoldersState();
  return folders;
}

async function getFolder(folderId) {
  const folders = await listFolders();
  return folders.find((f) => f.id === Number(folderId)) || null;
}

async function createFolder(name) {
  const state = await getFoldersState();
  const id = state.folders.length > 0 ? Math.max(...state.folders.map((f) => f.id)) + 1 : 1;
  state.folders.push({ id, name });
  await setFoldersState(state);
  return id;
}

async function renameFolder(folderId, newName) {
  const state = await getFoldersState();
  const folder = state.folders.find((f) => f.id === Number(folderId));
  if (!folder) return false;
  folder.name = newName;
  await setFoldersState(state);
  return true;
}

// Deleting a folder never deletes its books — they just become unfiled
// (their assignment entry is dropped) so nothing is ever lost by mistake.
async function deleteFolder(folderId) {
  const state = await getFoldersState();
  const before = state.folders.length;
  state.folders = state.folders.filter((f) => f.id !== Number(folderId));
  if (state.folders.length === before) return false;
  Object.keys(state.assignments).forEach((bookId) => {
    if (state.assignments[bookId] === Number(folderId)) delete state.assignments[bookId];
  });
  await setFoldersState(state);
  return true;
}

async function getBookFolderId(bookId) {
  const { assignments } = await getFoldersState();
  const raw = assignments[String(bookId)];
  return raw == null ? null : raw;
}

// Pass folderId === null to unfile the book (remove its assignment).
async function setBookFolder(bookId, folderId) {
  const state = await getFoldersState();
  if (folderId == null) {
    delete state.assignments[String(bookId)];
  } else {
    state.assignments[String(bookId)] = Number(folderId);
  }
  await setFoldersState(state);
}

async function removeBookAssignment(bookId) {
  await setBookFolder(bookId, null);
}

// Pure grouping helper — takes the already-fetched book list (from
// books.listBooks()/listReadyBooks()) plus the folders state, and buckets
// books into their folders + an "unfiled" bucket. No DB calls of its own,
// so callers that already have both pieces can group repeatedly for free.
function groupBooksByFolder(allBooks, state) {
  const byFolderId = new Map(state.folders.map((f) => [f.id, { ...f, books: [] }]));
  const unfiled = [];
  allBooks.forEach((b) => {
    const raw = state.assignments[String(b.id)];
    const folderId = raw == null ? null : Number(raw);
    if (folderId != null && byFolderId.has(folderId)) {
      byFolderId.get(folderId).books.push(b);
    } else {
      unfiled.push(b);
    }
  });
  return { folders: Array.from(byFolderId.values()), unfiled };
}

module.exports = {
  UNFILED_KEY,
  getFoldersState,
  listFolders,
  getFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  getBookFolderId,
  setBookFolder,
  removeBookAssignment,
  groupBooksByFolder,
};
