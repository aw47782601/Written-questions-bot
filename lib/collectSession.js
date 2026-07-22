// "Collect mode" — started with /text, finished with /done (or discarded
// with /cancel). While active, every plain-text message the user sends is
// appended to one running list of questions instead of being answered
// immediately. This is what fixes the "pasted 100 questions, Telegram
// split it into 2 messages, bot answered them as 2 separate batches ->
// 2 PDFs" problem: both messages land in the SAME batch, so /done
// produces exactly one combined batch (and, if the user picked a PDF
// reply, one combined PDF).
//
// The running question count is shown by EDITING one anchor status
// message (the one sent when /text was first used) rather than sending a
// new message for every incoming chunk, per the user's request.
//
// Stored in the existing generic bot_config key/value table (see
// lib/botConfig.js) — same pattern as lib/pendingBatches.js — since Vercel
// serverless invocations don't share memory with each other.
const botConfig = require('./botConfig');
const { extractQuestionsFromText } = require('./questionExtractor');

// Generous TTL: unlike a pending format-choice prompt (20 min), collecting
// is a user-paced, possibly-slow activity (pasting many messages), so give
// it a couple of hours before treating it as abandoned.
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function keyFor(userId) {
  return `collectsession_${userId}`;
}

// Starts a new collect session anchored to `messageId` (the status message
// that will be edited as questions come in). Overwrites any previous
// session for this user (callers should check getSession first if they
// want to warn about an in-progress session instead of silently
// restarting it).
async function startSession(userId, chatId, messageId) {
  const session = {
    chatId,
    messageId,
    questions: [],
    createdAt: Date.now(),
  };
  await botConfig.setConfig(keyFor(userId), session);
  return session;
}

async function getSession(userId) {
  const session = await botConfig.getConfig(keyFor(userId));
  if (!session) return null;
  if (Date.now() - (session.createdAt || 0) > TTL_MS) {
    await botConfig.deleteConfig(keyFor(userId));
    return null;
  }
  return session;
}

// Extracts questions from `text` and appends them to the active session,
// if any. Returns the updated session, or null if the user has no active
// collect session (caller should fall back to normal handling).
async function addText(userId, text) {
  const session = await getSession(userId);
  if (!session) return null;

  const newQuestions = extractQuestionsFromText(text);
  const updated = {
    ...session,
    questions: [...session.questions, ...newQuestions],
  };
  await botConfig.setConfig(keyFor(userId), updated);
  return updated;
}

// Ends the session and returns it (read + delete), or null if there was
// none active.
async function endSession(userId) {
  const session = await getSession(userId);
  if (!session) return null;
  await botConfig.deleteConfig(keyFor(userId));
  return session;
}

// Discards the session without returning its questions (used by /cancel).
// Returns true if a session actually existed.
async function cancelSession(userId) {
  const session = await getSession(userId);
  if (!session) return false;
  await botConfig.deleteConfig(keyFor(userId));
  return true;
}

module.exports = { startSession, getSession, addText, endSession, cancelSession };
