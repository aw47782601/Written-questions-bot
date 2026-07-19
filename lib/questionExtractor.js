const { extractFullText } = require('./pdf');

const MAX_QUESTIONS = 100;

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

  return lines.slice(0, MAX_QUESTIONS);
}

async function extractQuestionsFromPdfBuffer(buffer) {
  const text = await extractFullText(buffer);
  return extractQuestionsFromText(text);
}

async function extractQuestionsFromPlainTextBuffer(buffer) {
  return extractQuestionsFromText(buffer.toString('utf-8'));
}

module.exports = {
  MAX_QUESTIONS,
  extractQuestionsFromText,
  extractQuestionsFromPdfBuffer,
  extractQuestionsFromPlainTextBuffer,
};
