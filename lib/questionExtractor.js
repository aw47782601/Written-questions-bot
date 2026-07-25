const { extractFullText } = require('./pdf');
const gemini = require('./gemini');
const env = require('./env');
const usageTracker = require('./usageTracker');
const telegram = require('./telegram');

// NOTE: there used to be a hard MAX_QUESTIONS = 100 cap here (questions
// beyond the 100th were silently dropped). That cap has been removed —
// batches of any size are now accepted in full. See also lib/collectSession.js,
// which lets a user spread one big batch across several Telegram messages
// (Telegram truncates long pastes into separate messages) and have them
// merged into a single batch/PDF instead of being answered separately.
//
// Extraction used to be pure regex (split on newlines, strip leading
// numbering). That's now done by Gemini instead (see
// GEMINI_EXTRACTION_MODEL / gemini-flash-lite-latest in lib/env.js):
// it's more robust to messy pasted/scanned text (wrapped lines, stray
// numbering styles, inconsistent spacing), and — the main reason for the
// switch — it can additionally recognize a chapter/section/unit title
// line that appears before a run of questions and tag each of those
// questions with it, which a fixed regex has no way to do. That chapter
// tag flows through lib/batchAnswer.js -> the PDF results array, where
// lib/pdfGenerator.js draws a chapter banner before that group's cards.

// Each chunk is its own Gemini call — keeps prompt+output comfortably
// within the lite model's budget even for a very large pasted batch or a
// long PDF, instead of trying to structure the whole thing in one shot.
const CHUNK_CHAR_LIMIT = 6000;

function splitIntoChunks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    if (currentLen + line.length + 1 > CHUNK_CHAR_LIMIT && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          chapter: { type: 'string', nullable: true },
        },
        required: ['question', 'chapter'],
      },
    },
  },
  required: ['items'],
};

function buildExtractionPrompt(text, carryChapter) {
  return `You are structuring raw text (pasted by a student/teacher, or extracted from a PDF/TXT file) that contains a list of study questions — possibly with chapter/section/unit title lines mixed in before groups of questions.

TASK: split the text into individual questions, and for each one report the chapter/section/unit title that most recently appeared before it (if any).

RULES:
- Keep each question's original wording as-is, just strip any leading numbering (e.g. "1.", "2)", "3-", "٣-").
- A chapter/section/unit title is a short heading line, NOT a question itself and NOT part of any question's wording — it looks like "الفصل الأول: ...", "Chapter 3: ...", "الوحدة الثانية", "Unit 2 - ...", etc, in Arabic or English (or mixed).
- Ignore lines that are just numbering, page numbers, or pure decoration/separators (e.g. "---", "===") — they are not questions.
- Once a chapter title appears, apply it to every question that follows until the next chapter title (or the text ends).
- If no chapter title has appeared yet before a question, set "chapter" to null.
- Preserve the original order of the questions.
${carryChapter ? `- CONTINUATION NOTICE: this text is a continuation of a previous chunk of the same document. Unless a NEW chapter title appears at the very start of this text, the first question(s) here still belong to the chapter carried over from before: "${carryChapter}".` : ''}

Return ONLY a JSON object matching the schema — an "items" array, one entry per question, each shaped exactly like {"question": "...", "chapter": "..." or null}.

Text:
${text}`;
}

// Bare-minimum emergency fallback — used ONLY if the AI call itself
// completely fails (e.g. every Gemini key/model exhausted), so a batch
// doesn't just die outright. Not used as the normal extraction path.
function stripNumbering(line) {
  return line.replace(/^\s*[\d\u0660-\u0669]+\s*[.)\-–]\s*/u, '').trim();
}

function fallbackLineSplit(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => stripNumbering(l))
    .map((l) => l.trim())
    .filter((l) => l.length > 3);
}

// Splits free text into individual { question, chapter } items via
// Gemini (gemini-flash-lite-latest by default — see
// env.GEMINI_EXTRACTION_MODEL), processed chunk by chunk with the
// most-recently-seen chapter name carried across chunk boundaries so a
// chapter title near the end of one chunk still applies to questions
// that land in the next chunk.
async function extractQuestionsFromText(text) {
  const chunks = splitIntoChunks(text);
  const items = [];
  let carryChapter = null;
  let alertedFallback = false; // only notify admins once per call, not once per chunk

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;

    let result;
    try {
      await usageTracker.checkAndIncrement(1);
      const prompt = buildExtractionPrompt(chunk, carryChapter);
      result = await gemini.generateJSON(prompt, {
        responseSchema: EXTRACTION_SCHEMA,
        models: [env.GEMINI_EXTRACTION_MODEL],
        maxOutputTokens: 8192,
      });
    } catch (err) {
      console.error('AI question extraction failed for a chunk, falling back to plain line-splitting for it:', err.message);
      if (!alertedFallback && env.ADMIN_CHAT_IDS.length > 0) {
        alertedFallback = true;
        Promise.all(
          env.ADMIN_CHAT_IDS.map((id) =>
            telegram
              .sendMessage(
                id,
                `⚠️ AI question extraction (GEMINI_EXTRACTION_MODEL=${env.GEMINI_EXTRACTION_MODEL}) failed and fell back to plain line-splitting — chapters won't be tagged and wrapped lines won't be merged until this is fixed.\n\nError: ${err.message}`
              )
              .catch(() => {})
          )
        ).catch(() => {});
      }
      fallbackLineSplit(chunk).forEach((q) => items.push({ question: q, chapter: carryChapter }));
      continue;
    }

    const rawItems = Array.isArray(result?.items) ? result.items : [];
    rawItems.forEach((it) => {
      const question = String(it?.question || '').trim();
      if (question.length <= 3) return; // drop empty/near-empty
      const chapter = it?.chapter && String(it.chapter).trim() ? String(it.chapter).trim() : null;
      items.push({ question, chapter });
    });

    const lastTagged = [...rawItems].reverse().find((it) => it?.chapter && String(it.chapter).trim());
    if (lastTagged) carryChapter = String(lastTagged.chapter).trim();
  }

  return items;
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
