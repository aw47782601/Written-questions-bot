// "Collect mode" — started with /text, finished/cancelled with the
// "✅ ابدأ التحليل" / "❌ إلغاء" buttons. While active, every plain-text
// message the user sends is appended to one running list of questions
// instead of being answered immediately. This is what fixes the "pasted
// 100 questions, Telegram split it into 2 messages, bot answered them as
// 2 separate batches -> 2 PDFs" problem: both messages land in the SAME
// batch, so finishing produces exactly one combined batch (and, if the
// user picked a PDF reply, one combined PDF).
//
// Two-step message flow (per the user's request):
//  1. /text itself sends ONLY a plain "collecting is on" notice — no
//     count, no buttons, since there's nothing collected yet.
//  2. The FIRST set of questions received sends a NEW message that shows
//     the count and the ✅/❌ buttons. That message becomes the "anchor"
//     (messageId, below) and every subsequent set of questions EDITS that
//     same anchor message in place instead of sending a new one.
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

// Starts a new collect session with no anchor message yet (messageId:
// null) — the count/buttons message only gets created once the first set
// of questions actually arrives (see setAnchorMessage below). Overwrites
// any previous session for this user (callers should check getSession
// first if they want to warn about an in-progress session instead of
// silently restarting it).
async function startSession(userId, chatId) {
  const session = {
    chatId,
    messageId: null,
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
// collect session (caller should fall back to normal handling). Does NOT
// touch messageId — the caller decides, based on whether messageId is
// still null, whether to send the first anchor message or edit the
// existing one (see setAnchorMessage).
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

// Records the id of the count+buttons message once it's been sent for
// the first time, so every later set of questions edits it instead of
// sending a new one.
async function setAnchorMessage(userId, messageId) {
  const session = await getSession(userId);
  if (!session) return null;
  const updated = { ...session, messageId };
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

// Discards the session without returning its questions (used by the
// "❌ إلغاء" button). Returns true if a session actually existed.
async function cancelSession(userId) {
  const session = await getSession(userId);
  if (!session) return false;
  await botConfig.deleteConfig(keyFor(userId));
  return true;
}

module.exports = { startSession, getSession, addText, setAnchorMessage, endSession, cancelSession };
