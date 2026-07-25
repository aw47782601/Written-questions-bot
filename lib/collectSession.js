// "Collect mode" — started with /text, finished/cancelled with the
// "✅ ابدأ التحليل" / "❌ إلغاء" buttons. While active, every plain-text
// message the user sends is appended to one running RAW TEXT buffer
// instead of being answered immediately. This is what fixes the "pasted
// 100 questions, Telegram split it into 2 messages, bot answered them as
// 2 separate batches -> 2 PDFs" problem: both messages land in the SAME
// batch, so finishing produces exactly one combined batch (and, if the
// user picked a PDF reply, one combined PDF).
//
// IMPORTANT: the AI-based extraction/analysis (lib/questionExtractor.js,
// which calls Gemini) does NOT run per incoming message anymore. It runs
// exactly ONCE, on the full merged text, only when the user taps
// "✅ ابدأ التحليل" (see handleCollectStartButton in
// api/telegram-webhook.js). Reasons:
//  1. The user asked explicitly not to start AI analysis before that
//     button is pressed — collecting should be a free, instant, AI-free
//     step; only "ابدأ التحليل" should trigger Gemini calls.
//  2. Running extraction once on the whole merged text (instead of once
//     per message) lets a chapter/section title that lands in one message
//     correctly carry over to questions that land in a LATER message —
//     splitting per-message would reset that carry-over at every message
//     boundary.
//  3. It's also strictly fewer Gemini calls for the same batch.
// While collecting, no question count is shown at all (a regex/line-based
// guess would be misleading and was removed) — the status message only
// shows how many messages have been received so far. The real, accurate
// question count (and chapter tagging) is only known after "ابدأ التحليل"
// runs the AI.
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
    rawTexts: [], // raw pasted text chunks — unanalyzed until "ابدأ التحليل"
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
  // Defensive normalization: a session created by a previous deploy of
  // this bot may still be sitting in storage in an OLD shape (e.g.
  // { questions: [...] } from back when extraction ran per-message, or
  // { rawTexts, lineCount } from a since-removed regex line-count
  // estimate). Coerce anything old/malformed into the current
  // { rawTexts } shape instead of throwing, so an in-flight /text session
  // survives a deploy instead of crashing the next message.
  if (!Array.isArray(session.rawTexts)) {
    session.rawTexts = [];
  }
  return session;
}

// Appends `text` (RAW, unanalyzed) to the active session's buffer, if any.
// No Gemini call happens here — that's the whole point (see the notes at
// the top of this file). Returns the updated session, or null if the user
// has no active collect session (caller should fall back to normal
// handling). Does NOT touch messageId — the caller decides, based on
// whether messageId is still null, whether to send the first anchor
// message or edit the existing one (see setAnchorMessage).
async function addText(userId, text) {
  const session = await getSession(userId);
  if (!session) return null;

  const updated = {
    ...session,
    rawTexts: [...session.rawTexts, text],
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

// Ends the session and returns it (read + delete) with a merged `text`
// field (all collected raw chunks joined with newlines), or null if there
// was none active. This raw text is what the caller (handleCollectStartButton
// in api/telegram-webhook.js) runs the ONE Gemini extraction call on — that
// AI call is the actual analysis step, and only happens here, after the
// user tapped "✅ ابدأ التحليل".
async function endSession(userId) {
  const session = await getSession(userId);
  if (!session) return null;
  await botConfig.deleteConfig(keyFor(userId));
  return { ...session, text: (session.rawTexts || []).join('\n') };
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
