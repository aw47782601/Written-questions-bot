// Holds a user's extracted-but-not-yet-answered question batch between
// "I found your questions, pick a format" and the moment they tap one of
// the format buttons. Replaces the old persistent /format preference
// (users.answer_format) — the user is now asked once PER batch of
// questions instead of setting a standing default.
//
// Stored in the existing generic `bot_config` key/value table (no schema
// change needed — see lib/botConfig.js) rather than in memory, because
// Vercel serverless functions don't share memory between the message
// that staged the batch and the later callback_query that picks the
// format; they can even run on different instances.
const botConfig = require('./botConfig');

// Stale prompts (e.g. the user staged a batch, disappeared, and taps the
// button two hours later) are rejected rather than silently answered —
// the book/context might have changed, and it avoids surprise Gemini
// usage long after the fact.
const TTL_MS = 20 * 60 * 1000; // 20 minutes

function keyFor(userId) {
  return `pendingbatch_${userId}`;
}

function makeToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Stages a batch and returns the token to embed in the format buttons'
// callback_data, so a stale/replaced prompt can be told apart from the
// current one (see takeBatch).
async function stageBatch(userId, { questions, bookId }) {
  const token = makeToken();
  await botConfig.setConfig(keyFor(userId), {
    questions,
    bookId,
    token,
    createdAt: Date.now(),
  });
  return token;
}

// Consumes (reads + deletes) the pending batch for userId, but only if
// `token` matches the most recently staged one — an older prompt whose
// batch got replaced by a newer one, or one that's simply expired,
// returns null instead. Always deletes on read so a button can only ever
// be actioned once.
async function takeBatch(userId, token) {
  const key = keyFor(userId);
  const pending = await botConfig.getConfig(key);
  if (!pending) return null;
  await botConfig.deleteConfig(key);

  if (token && pending.token && pending.token !== token) return null;
  if (Date.now() - (pending.createdAt || 0) > TTL_MS) return null;

  return pending;
}

module.exports = { stageBatch, takeBatch };
