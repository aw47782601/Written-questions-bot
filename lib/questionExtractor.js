const { extractFullText } = require('./pdf');

// NOTE: there used to be a hard MAX_QUESTIONS = 100 cap here (questions
// beyond the 100th were silently dropped). That cap has been removed —
// batches of any size are now accepted in full. See also lib/collectSession.js,
// which lets a user spread one big batch across several Telegram messages
// (Telegram truncates long pastes into separate messages) and have them
// merged into a single batch/PDF instead of being answered separately.

// Strips a leading "1.", "1)", "1-", or Arabic-indic digit numbering
// from a line, e.g. "١- ما هي وظيفة..." -> "ما هي وظيفة..."
function stripNumbering(line) {
  return line.replace(/^\s*[\d\u0660-\u0669]+\s*[\.\)\-–]\s*/u, '').trim();
}

// Splits free text into individual questions: one per non-empty line.
// Handles both numbered lists and plain line-separated questions.
function extractQuestionsFromText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => stripNumbering(l))
    .map((l) => l.trim())
    .filter((l) => l.length > 3); // drop empty/near-empty lines

  return lines;
}

async function extractQuestionsFromPdfBuffer(buffer) {
  const text = await extractFullText(buffer);
  return extractQuestionsFromText(text);
}

async function extractQuestionsFromPlainTextBuffer(buffer) {
  return extractQuestionsFromText(buffer.toString('utf-8'));
}

module.exports = {
  extractQuestionsFromText,
  extractQuestionsFromPdfBuffer,
  extractQuestionsFromPlainTextBuffer,
};
