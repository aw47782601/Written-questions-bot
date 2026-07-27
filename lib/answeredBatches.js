const gemini = require('./gemini');
const { retrieveChunks, getImagePagesMap } = require('./rag');
const usageTracker = require('./usageTracker');
const env = require('./env');
const botConfig = require('./botConfig');

// No expiry — a delivered batch stays editable indefinitely (add/delete/
// answer/reword) until the user sends an actual NEW set of questions
// (a PDF/TXT document, or a fresh /text batch), which overwrites this
// entry with saveBatch below. Previously capped at 30 minutes, but the
// user should be able to come back and edit a batch anytime, not just
// within a short window after it was delivered.
const ANSWERED_TTL_MS = null;

function answeredKeyFor(userId) {
  return `answeredbatch_${userId}`;
}

function makeAnsweredToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Stages the just-delivered batch (results + the format/design/color/
// spoiler settings used to deliver them) and returns a token to embed in
// the follow-up buttons' callback_data. Called again after every
// retry/reword so the buttons keep working on the updated result set —
// each call simply overwrites the previous staged batch for this user.
async function saveBatch(userId, data) {
  const token = makeAnsweredToken();
  await botConfig.setConfig(answeredKeyFor(userId), {
    ...data,
    token,
    createdAt: Date.now(),
  });
  return token;
}

// Read-only lookup, validated against the token (so a stale/replaced
// batch's old buttons can't act on the wrong data) and the TTL above.
// Non-destructive (unlike lib/pendingBatches.js's takeBatch) because the
// same staged batch may be read multiple times: once for 🔁 retry, again
// for ✏️ reword, and the reword flow itself peeks it once to show the
// instructions and again once the user replies with their edit lines.
async function peekBatch(userId, token) {
  const pending = await botConfig.getConfig(answeredKeyFor(userId));
  if (!pending) return null;
  if (token && pending.token && pending.token !== token) return null;
  if (ANSWERED_TTL_MS !== null && Date.now() - (pending.createdAt || 0) > ANSWERED_TTL_MS) return null;
  return pending;
}

function buildBatchPrompt(items) {
  // items: [{ question, chunks: [{content, page_number}] }]
  const blocks = items
    .map((item, i) => {
      const excerpts = item.chunks
        .map((c) => `[page ${c.page_number}] ${c.content}`)
        .join('\n---\n');
      return `Question ${i + 1}: ${item.question}\nRelated excerpts from the book:\n${excerpts}`;
    })
    .join('\n\n====================\n\n');

  return `You are an educational assistant answering students' questions based ONLY on the attached excerpts from their curriculum book. Do not use any information from outside these excerpts.

LANGUAGE — very important: write the "answer" text in the same language as the attached excerpts (i.e. the language the book itself is written in) — it does NOT need to be Arabic. So if the excerpts are in English, answer in English; if French, answer in French; and so on — always match the book's own language. If the excerpts for a given question mix languages, use whichever language dominates those excerpts.

If a given question has no direct, explicitly-stated answer in its excerpts, do NOT immediately give up — first try to derive/infer the answer indirectly from those same excerpts (e.g. combining two related facts, generalizing from an example the excerpts do give, reasoning from a definition or mechanism the excerpts describe, etc.). Still base this reasoning ONLY on the attached excerpts, never on outside knowledge — you're connecting dots that are already in the text, not adding new facts from elsewhere. If you do this, answer normally and set page to the page_number of whichever excerpt you drew the inference from.

Only if the excerpts truly give no basis at all for even an indirect answer, return answer: "الإجابة مش واضحة في الأجزاء اللي تم البحث فيها من الكتاب" and page: null for that question only (leave this exact fallback message as-is, in Arabic — it's a fixed system message, not part of the book's content), and continue normally with the rest of the questions.

FORMATTING — very important: inside the "answer" text itself, wrap important words or terms (key concepts, numbers, definitions) with a single asterisk on each side, like *important word*, so they render bold when sent on Telegram. Do not use double asterisks **, underscores _, or any other formatting — use single asterisks only, and only around words that are actually important (not the whole sentence).

STRUCTURE — very important: never write a multi-point answer as one run-on paragraph.
- If the answer is genuinely a single short fact/sentence, write it as one plain line — no dash needed.
- If the answer naturally breaks into multiple distinct points, steps, types, causes, examples, or characteristics, put EACH point on its own line: separate every point with a newline character (\n) and start each of those lines with "- ". A short lead-in sentence (definition/overview) may come first as its own plain line before the bulleted lines start.
  Example answer value: "*Herd immunity* happens when enough of a population is immune that disease spread is contained.\n- Reduces the chance of *susceptible individuals* being exposed.\n- Protects those who cannot be vaccinated (e.g. *immunocompromised* patients).\n- Requires a *threshold proportion* of immune individuals that varies by disease."

COMPARISON QUESTIONS — very important: if a question explicitly or implicitly asks to compare, differentiate, or contrast two or more things (wording like "compare", "difference between", "differentiate", "X vs Y", "contrast"), answer it as a TABLE instead of prose:
- Set "isComparison" to true for that question.
- Set "answer" to a short one-line intro sentence (or an empty string "" if no intro is needed) — do NOT restate the comparison points in "answer".
- Fill "comparisonTable" with:
  - "columns": an array of strings — the first entry is a neutral label such as "Feature" (or the book's own aspect label if it uses one), followed by exactly one column per compared item, using each item's name as the column header.
  - "rows": an array of arrays of strings — each inner array is one row, one aspect being compared. The first cell of every row is the *aspect name itself wrapped in asterisks* (e.g. "*Onset*"), and every following cell is that compared item's value for that aspect, in the same order as "columns". Every row must have exactly as many cells as "columns".
  - HIGHLIGHTING INSIDE THE CELLS — very important, same asterisk convention as FORMATTING above: don't stop at bolding the aspect name in the first cell. Inside every OTHER cell's own text (the actual comparison value for that item), also wrap the specific word(s) that carry the real distinction for that row — the number, term, or defining detail that makes this item's value different from the other item(s) in the same row — with single asterisks, e.g. "*Slow*, over several days" vs "*Immediate*". Highlight only the 1-3 key word(s) per cell that matter, not the whole cell text.
- For every question that is NOT a comparison, set "isComparison" to false and "comparisonTable" to null, and answer normally following the STRUCTURE rules above.

Return the result as a JSON array only (no extra text or markdown fences), in the same order as the questions, each item in exactly this shape:
{"question": "the question text", "isComparison": false, "answer": "the answer", "comparisonTable": null, "page": page_number_or_null}

For a comparison question, comparisonTable looks like this instead of null — notice the aspect name in the first cell is bolded AND the key distinguishing word within each value cell ("*infection*"/"*vaccination*", "*Slow*"/"*Immediate*") is bolded too, not just the row label:
{"question": "...", "isComparison": true, "answer": "", "comparisonTable": {"columns": ["Feature", "Active Immunity", "Passive Immunity"], "rows": [["*Induction*", "By natural *infection* or *vaccination*", "By transfer of *antibodies* from another source"], ["*Onset*", "*Slow* — takes days to weeks", "*Immediate* protection"]]}, "page": 42}

Questions:

${blocks}`;
}

// Explicit schema for the batch response — forces Gemini's structured
// JSON encoder (rather than just asking for JSON via responseMimeType),
// which reliably escapes newlines/control characters inside "answer"
// even for long, multi-line (numbered-step) answers.
const BATCH_RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      isComparison: { type: 'boolean' },
      answer: { type: 'string' },
      comparisonTable: {
        type: 'object',
        nullable: true,
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
      },
      page: { type: 'integer', nullable: true },
    },
    required: ['question', 'isComparison', 'answer', 'comparisonTable', 'page'],
  },
};

// Calls Gemini for one batch, with a fallback that halves the batch
// and retries if the model returns malformed/mismatched JSON.
// collector (optional): a shared { embeddingCalls, generationCalls,
// failures } object. generateJSON pushes its own "which key/model
// succeeded" entries into it; on a question's final failure (after all
// retries/splits), this pushes { question, errMessage } into
// collector.failures so the caller can report everything in ONE
// consolidated admin message instead of a live message per event.
async function answerBatch(items, extraKeys = [], collector = null) {
  if (items.length === 0) return [];

  await usageTracker.checkAndIncrement(1);
  const prompt = buildBatchPrompt(items);
  // Give each question room for a fairly detailed answer, scaling with
  // batch size, capped at the model's max.
  // Ceiling kept a bit under the real ~65,536-token model limit (Gemini
  // 3.5 Flash / 3 Flash Preview / lite all support up to ~65k output
  // tokens) as safety margin, rather than the old, much lower 32768 cap
  // that used to disable the MAX_TOKENS auto-retry below (see gemini.js)
  // well before batches got anywhere near the model's actual capacity.
  const maxOutputTokens = Math.min(60000, Math.max(4096, items.length * 1500));

  try {
    const result = await gemini.generateJSON(prompt, { maxOutputTokens, responseSchema: BATCH_RESPONSE_SCHEMA, extraKeys, collector });
    if (!Array.isArray(result) || result.length !== items.length) {
      throw new Error('Mismatched batch response length');
    }
    return result.map((r, i) => ({
      question: items[i].question,
      isComparison: !!r.isComparison && !!r.comparisonTable,
      answer: r.answer || (r.isComparison ? '' : 'لم يتم توليد إجابة'),
      comparisonTable: r.isComparison ? r.comparisonTable || null : null,
      page: r.page ?? null,
      isError: false,
    }));
  } catch (err) {
    if (items.length === 1) {
      // Last resort for a single question: return a safe fallback
      // instead of failing the whole batch.
      console.error(`answerBatch failed for "${items[0].question}":`, err.message);
      if (collector) collector.failures.push({ question: items[0].question, errMessage: err.message });
      return [
        {
          question: items[0].question,
          isComparison: false,
          answer: 'حصل خطأ في معالجة السؤال ده، جرب تبعته لوحده تاني.',
          comparisonTable: null,
          page: null,
          isError: true,
        },
      ];
    }
    const mid = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      answerBatch(items.slice(0, mid), extraKeys, collector),
      answerBatch(items.slice(mid), extraKeys, collector),
    ]);
    return [...left, ...right];
  }
}

// Main entry point: takes questions (plain strings, or { question, chapter }
// items from lib/questionExtractor.js's AI extraction), returns
// [{ question, answer, page, isError, chapter }] in the same order as input.
// No persistent caching — every call hits Gemini fresh (the old
// qa_cache table/scheme was dropped as not useful).
// extraKeys (optional): the calling user's own validated Gemini keys
// (see lib/userApiKeys.js) — pooled in on top of the shared
// GEMINI_API_KEYS for this call only, so users who've added their own
// free keys get more headroom/parallelism for their own requests.
// collector (optional): see answerBatch above.
async function answerQuestions(questions, bookId, extraKeys = [], collector = null) {
  // `questions` items can be either plain strings (older callers) or
  // { question, chapter } objects — the shape produced by
  // lib/questionExtractor.js's AI-based extraction, which is what
  // /text collect-mode and PDF/TXT uploads pass in now. Normalize to a
  // consistent { question, chapter } shape up front so `chapter` can ride
  // along through embedding/retrieval/answering and land on each final
  // result (r.chapter below), which is what lib/pdfGenerator.js reads to
  // draw a chapter banner before that group's questions.
  const normalized = questions
    .map((q) =>
      typeof q === 'string'
        ? { question: q, chapter: null }
        : { question: String(q?.question || ''), chapter: q?.chapter || null }
    )
    .filter((it) => it.question && it.question.trim().length > 0);
  if (normalized.length === 0) return [];

  // 1 embedding call covers the whole set of questions.
  await usageTracker.checkAndIncrement(1);
  const embeddings = await gemini.embedTexts(
    normalized.map((it) => it.question),
    'RETRIEVAL_QUERY',
    extraKeys,
    collector
  );

  // Retrieval is pure DB work — safe to parallelize. Scoped to the one
  // book the asking user has selected (see users.selected_book_id /
  // /mybook), so answers only ever come from that book's chunks.
  const withChunks = await Promise.all(
    normalized.map(async (it, idx) => ({
      question: it.question,
      chapter: it.chapter,
      chunks: await retrieveChunks(embeddings[idx], bookId),
    }))
  );

  // Batches run in parallel rather than one-after-another. With several
  // batches each retrying/rotating/backing off on 429s, a sequential loop
  // can easily blow past Vercel's 300s function timeout (maxDuration in
  // vercel.json) well before all questions are answered — the whole
  // request then dies with no response and no notification at all. Running
  // batches concurrently keeps total wall-clock time close to the single
  // slowest batch instead of the sum of all of them.
  const batches = [];
  for (let i = 0; i < withChunks.length; i += env.BATCH_SIZE) {
    batches.push(withChunks.slice(i, i + env.BATCH_SIZE));
  }

  const batchResultsList = await Promise.all(
    batches.map((batch) =>
      answerBatch(
        batch.map((b) => ({ question: b.question, chunks: b.chunks })),
        extraKeys,
        collector
      )
    )
  );

  const results = [];
  batchResultsList.forEach((batchResults) => results.push(...batchResults));

  // batchResultsList is built from `batches`, which is `withChunks` sliced
  // in order and never reordered — including inside answerBatch's
  // split-on-failure recursion (slice(0, mid) / slice(mid) partitions the
  // original order, and the two halves' results are concatenated back in
  // that same order). So `results[i]` always corresponds to
  // `withChunks[i]`, meaning `results[i].page` can be safely matched
  // against that same question's own retrieved chunks below.
  // Attach the actual page image (if one was ingested for the cited page)
  // via a direct book_chunks lookup — NOT by searching the chunks
  // retrieveChunks() already returned. match_book_chunks (the RPC behind
  // retrieveChunks) only ever returns { id, content, page_number,
  // similarity } (see lib/rag.js), so a chunk_type/image_base64 check
  // against those rows can never match. One batched lookup covers every
  // cited page across the whole result set.
  const citedPages = results.filter((r) => r.page != null).map((r) => r.page);
  const imagePagesMap = await getImagePagesMap(bookId, citedPages);

  results.forEach((r, i) => {
    // Chapter/section tag (from AI extraction, see the comment above) —
    // carried over here rather than through answerBatch/Gemini, since it
    // has nothing to do with the answer itself. lib/pdfGenerator.js reads
    // r.chapter to draw a banner before the first question of each group.
    r.chapter = withChunks[i]?.chapter ?? null;

    if (r.page == null) return;
    if (imagePagesMap.has(r.page)) {
      r.imageBase64 = imagePagesMap.get(r.page);
    }
  });

  return results;
}

// Builds the prompt for "answer <رقم>: ..." edits (see parseEditLines /
// buildEditedResults in api/telegram-webhook.js). Unlike buildBatchPrompt
// above, this NEVER re-derives, fact-checks, or adds/removes information —
// it only reformats text the user already wrote themselves. No book
// excerpts are attached and no RAG/embedding call happens for this path.
function buildFormatPrompt(items) {
  // items: [{ question, rawAnswer }]
  const blocks = items
    .map((item, i) => `Question ${i + 1}: ${item.question}\nStudent-provided answer ${i + 1} (format this EXACTLY as written, do not add or remove facts):\n${item.rawAnswer}`)
    .join('\n\n====================\n\n');

  return `You are a formatting assistant. For each item below, a student has already written their OWN answer to their own question. Your ONLY job is to reformat that answer for readability — you must NOT rewrite its meaning, add facts, remove facts, correct/fact-check it, or translate it. Preserve the exact language the student wrote in and every fact/claim they made, word for word in substance.

FORMATTING — very important: inside the "answer" text, wrap important words or terms (key concepts, numbers, definitions) with a single asterisk on each side, like *important word*, so they render bold when sent on Telegram. Do not use double asterisks **, underscores _, or any other formatting — use single asterisks only, and only around words that are already present in the student's own text (never invent a new term).

STRUCTURE — very important: never leave a multi-point answer as one run-on paragraph.
- If the student's answer is genuinely a single short fact/sentence, write it as one plain line — no dash needed.
- If the student's answer naturally breaks into multiple distinct points, steps, types, causes, or examples (even if they wrote it as one paragraph), split it into separate lines: one point per line, each starting with "- ", separated by newline characters (\n). A short lead-in sentence may stay as its own plain line before the bulleted lines start. Do not merge or drop any point the student wrote — only re-lay-out the existing content.

COMPARISON ANSWERS — very important: if the student's own answer is comparing, differentiating, or contrasting two or more things, reformat it as a TABLE instead of prose:
- Set "isComparison" to true for that item.
- Set "answer" to a short one-line intro sentence taken from the student's own text (or an empty string "" if there isn't one) — do NOT restate the comparison points in "answer".
- Fill "comparisonTable" with:
  - "columns": an array of strings — the first entry is a neutral label such as "Feature" (or whatever aspect label fits the student's own wording), followed by exactly one column per compared item, using each item's name (as the student wrote it) as the column header.
  - "rows": an array of arrays of strings — each inner array is one row (one aspect the student compared). The first cell of every row is the *aspect name itself wrapped in asterisks*, and every following cell is that compared item's value for that aspect, taken only from what the student wrote. Every row must have exactly as many cells as "columns".
  - HIGHLIGHTING INSIDE THE CELLS — same asterisk convention as above: inside every OTHER cell's text, wrap the specific word(s) that carry the real distinction for that row with single asterisks. Highlight only the 1-3 key word(s) per cell that matter.
- If the student didn't give enough detail to fill a cell, leave that cell as an empty string "" rather than inventing content.
- For every item that is NOT a comparison, set "isComparison" to false and "comparisonTable" to null, and answer normally following the STRUCTURE rules above.

Return the result as a JSON array only (no extra text or markdown fences), in the same order as the items, each item in exactly this shape:
{"question": "the question text", "isComparison": false, "answer": "the reformatted answer", "comparisonTable": null}

Items:

${blocks}`;
}

const FORMAT_RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      isComparison: { type: 'boolean' },
      answer: { type: 'string' },
      comparisonTable: {
        type: 'object',
        nullable: true,
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    required: ['question', 'isComparison', 'answer', 'comparisonTable'],
  },
};

// Same split-and-retry-on-malformed-JSON shape as answerBatch, but for the
// format-only path: one Gemini generation call, no embedding/RAG call at
// all. Still costs 1 usageTracker "call" per batch, same as answerBatch,
// since it's still a real Gemini generation request.
async function formatBatch(items, extraKeys = [], collector = null) {
  if (items.length === 0) return [];

  await usageTracker.checkAndIncrement(1);
  const prompt = buildFormatPrompt(items);
  const maxOutputTokens = Math.min(60000, Math.max(2048, items.length * 1000));

  try {
    const result = await gemini.generateJSON(prompt, { maxOutputTokens, responseSchema: FORMAT_RESPONSE_SCHEMA, extraKeys, collector });
    if (!Array.isArray(result) || result.length !== items.length) {
      throw new Error('Mismatched format batch response length');
    }
    return result.map((r, i) => ({
      question: items[i].question,
      isComparison: !!r.isComparison && !!r.comparisonTable,
      answer: r.answer || (r.isComparison ? '' : items[i].rawAnswer),
      comparisonTable: r.isComparison ? r.comparisonTable || null : null,
      isError: false,
    }));
  } catch (err) {
    if (items.length === 1) {
      // Last resort: fall back to the student's raw text, unformatted,
      // rather than losing/blocking their answer entirely.
      console.error(`formatBatch failed for "${items[0].question}":`, err.message);
      if (collector) collector.failures.push({ question: items[0].question, errMessage: err.message });
      return [
        {
          question: items[0].question,
          isComparison: false,
          answer: items[0].rawAnswer,
          comparisonTable: null,
          isError: true,
        },
      ];
    }
    const mid = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      formatBatch(items.slice(0, mid), extraKeys, collector),
      formatBatch(items.slice(mid), extraKeys, collector),
    ]);
    return [...left, ...right];
  }
}

// Entry point for "answer <رقم>: ..." edits — see the big comment block
// above isEditCommandLine in api/telegram-webhook.js. Takes
// [{ question, rawAnswer }], returns
// [{ question, answer, isComparison, comparisonTable, isError }] in the
// same order as input. No embedding call, no retrieveChunks/RAG call —
// this never touches the book at all, it only asks Gemini to lay out text
// the user already wrote (split into points / build a comparison table /
// bold key terms).
async function formatUserAnswers(items, extraKeys = [], collector = null) {
  const normalized = (items || [])
    .map((it) => ({ question: String(it?.question || ''), rawAnswer: String(it?.rawAnswer || '').trim() }))
    .filter((it) => it.question && it.rawAnswer);
  if (normalized.length === 0) return [];

  const batches = [];
  for (let i = 0; i < normalized.length; i += env.BATCH_SIZE) {
    batches.push(normalized.slice(i, i + env.BATCH_SIZE));
  }

  const batchResultsList = await Promise.all(batches.map((batch) => formatBatch(batch, extraKeys, collector)));

  const results = [];
  batchResultsList.forEach((batchResults) => results.push(...batchResults));
  return results;
}

module.exports = { answerQuestions, formatUserAnswers, saveBatch, peekBatch };
