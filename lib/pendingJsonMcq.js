// Holds a user's parsed-but-not-yet-rendered /json_mcq batch between "I
// read your JSON file, now pick a PDF color" and the moment they tap a
// color button (or finish typing a custom hex code). Mirrors
// lib/pendingBatches.js's stage/peek/take + token/TTL pattern, but kept as
// its own file/key (pendingjsonmcq_<userId>) rather than reusing
// pendingBatches directly — a user could in principle have a
// written-question batch (from a normal PDF/TXT upload) AND a JSON MCQ
// upload in flight at the same time, and the two shouldn't be able to
// clobber each other in the same bot_config row.
const botConfig = require('./botConfig');

// Same generous-but-bounded window as pendingBatches: long enough for the
// user to pick a color without rushing, short enough that a picked-up
// stale prompt doesn't silently render a batch from ages ago.
const TTL_MS = 20 * 60 * 1000; // 20 minutes

function keyFor(userId) {
  return `pendingjsonmcq_${userId}`;
}

function makeToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Stages a batch (the already-validated `questions` array, the original
// file name for naming the output PDF, and how many entries got skipped
// for missing fields) and returns the token to embed in the color
// buttons' callback_data.
async function stageBatch(userId, { questions, fileName, skipped = 0 }) {
  const token = makeToken();
  await botConfig.setConfig(keyFor(userId), {
    questions,
    fileName,
    skipped,
    token,
    createdAt: Date.now(),
  });
  return token;
}

// Consumes (reads + deletes) the pending batch for userId, but only if
// `token` matches the most recently staged one — an older/replaced or
// expired prompt returns null instead. Always deletes on read so a color
// choice can only ever be actioned once.
async function takeBatch(userId, token) {
  const key = keyFor(userId);
  const pending = await botConfig.getConfig(key);
  if (!pending) return null;
  await botConfig.deleteConfig(key);

  if (token && pending.token && pending.token !== token) return null;
  if (Date.now() - (pending.createdAt || 0) > TTL_MS) return null;

  return pending;
}

// Read-only version of takeBatch, for the "🎨 لون بالكود" step: validates
// the staged batch is still alive (and belongs to this token) before
// asking the user to type a hex code, without consuming it yet — the
// actual typed-code message is what calls takeBatch.
async function peekBatch(userId, token) {
  const pending = await botConfig.getConfig(keyFor(userId));
  if (!pending) return null;
  if (token && pending.token && pending.token !== token) return null;
  if (Date.now() - (pending.createdAt || 0) > TTL_MS) return null;
  return pending;
}

module.exports = { stageBatch, takeBatch, peekBatch };
