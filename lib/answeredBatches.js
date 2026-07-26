// Holds the FINAL result set of an already-answered batch (after
// lib/batchAnswer.js has run), keyed to the user, so a small number of
// failed/unclear questions can be retried — or a confusingly-worded one
// reworded and re-answered — without resubmitting or re-paying quota for
// the whole batch again. Complements lib/pendingBatches.js, which only
// covers the staging BEFORE answering.
//
// Stored in the same generic bot_config key/value table as
// pendingBatches (see lib/botConfig.js) for the same reason: Vercel
// serverless invocations don't share memory.
//
// results here are the FINAL, reordered array exactly as delivered to
// the user (see reorderUnansweredLast in api/telegram-webhook.js) — so
// results[i] always matches the "i+1." number the user sees in the text
// reply / PDF, which is what lets a "45: ..." reword reply or the retry
// button target the right question by that same number.
const botConfig = require('./botConfig');

// Kept alive longer than pendingBatches' 20-minute TTL — the user is
// expected to come back to this only AFTER reading the delivered
// answers/PDF, which can take a while.
const TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

function keyFor(userId) {
  return `answeredbatch_${userId}`;
}

function makeToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Saves a freshly-delivered batch and returns the token to embed in the
// retry/reword buttons' callback_data.
async function saveBatch(userId, { bookId, bookName, format, designId, colorKey, spoiler, results }) {
  const token = makeToken();
  await botConfig.setConfig(keyFor(userId), {
    token,
    bookId,
    bookName,
    format,
    designId,
    colorKey,
    spoiler,
    results,
    createdAt: Date.now(),
  });
  return token;
}

// Read-only lookup, validating the token/TTL the same way pendingBatches
// does. Doesn't delete — a batch can be retried/reworded more than once
// within its TTL (e.g. retry, then later reword a different question).
async function peekBatch(userId, token) {
  const pending = await botConfig.getConfig(keyFor(userId));
  if (!pending) return null;
  if (token && pending.token && pending.token !== token) return null;
  if (Date.now() - (pending.createdAt || 0) > TTL_MS) return null;
  return pending;
}

// Overwrites the stored results (after a retry/reword merge) and bumps
// createdAt, extending the TTL window from "last touched" rather than
// only from the original delivery — same token is kept so buttons shown
// on the (now-updated) redelivery message keep working.
async function updateBatch(userId, token, patch) {
  const pending = await peekBatch(userId, token);
  if (!pending) return null;
  const updated = { ...pending, ...patch, createdAt: Date.now() };
  await botConfig.setConfig(keyFor(userId), updated);
  return updated;
}

module.exports = { saveBatch, peekBatch, updateBatch };
