// "/json_mcq mode" — started with the /json_mcq command. While active,
// every .json document the user sends is treated as an MCQ export (the
// "questions_*.json" shape produced by
// https://t.me/Mcq_pdf_to_mcq_telegram_bot — a `questions` array of
// { question, options[], correctAnswerIndex, explanation, sectionTitle }
// objects) and rendered straight to a PDF via lib/pdfDesignMcq.js, instead
// of going through the normal PDF/TXT *written*-question extraction path
// (lib/questionExtractor.js) that api/telegram-webhook.js's main document
// handler otherwise sends every .pdf/.txt upload through.
//
// Modeled after lib/collectSession.js's bot_config-backed per-user state
// (Vercel serverless invocations don't share memory with each other, so
// an in-memory flag wouldn't survive between requests) — but simpler:
// there's nothing to buffer across messages. Each .json file is
// self-contained and produces its own PDF immediately, so this is just an
// on/off flag with a generous TTL, refreshed on every file so a user
// working through several JSON exports back-to-back doesn't get timed out
// mid-session.
const botConfig = require('./botConfig');

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours, same generous window as collectSession

function keyFor(userId) {
  return `jsonmcqmode_${userId}`;
}

async function startMode(userId) {
  await botConfig.setConfig(keyFor(userId), { createdAt: Date.now() });
}

async function isActive(userId) {
  const state = await botConfig.getConfig(keyFor(userId));
  if (!state) return false;
  if (Date.now() - (state.createdAt || 0) > TTL_MS) {
    await botConfig.deleteConfig(keyFor(userId));
    return false;
  }
  return true;
}

// Slides the TTL forward — called after successfully handling a .json
// file so a user working through several exports in a row stays "in
// mode" instead of the window counting down from the very first file.
async function touch(userId) {
  const active = await isActive(userId);
  if (active) await botConfig.setConfig(keyFor(userId), { createdAt: Date.now() });
}

async function endMode(userId) {
  await botConfig.deleteConfig(keyFor(userId));
}

module.exports = { startMode, isActive, touch, endMode };
