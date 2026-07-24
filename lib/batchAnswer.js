const gemini = require('./gemini');
const { retrieveChunks } = require('./rag');
const usageTracker = require('./usageTracker');
const env = require('./env');

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
- For every question that is NOT a comparison, set "isComparison" to false and "comparisonTable" to null, and answer normally following the STRUCTURE rules above.

Return the result as a JSON array only (no extra text or markdown fences), in the same order as the questions, each item in exactly this shape:
{"question": "the question text", "isComparison": false, "answer": "the answer", "comparisonTable": null, "page": page_number_or_null}

For a comparison question, comparisonTable looks like this instead of null:
{"question": "...", "isComparison": true, "answer": "", "comparisonTable": {"columns": ["Feature", "Active Immunity", "Passive Immunity"], "rows": [["*Induction*", "By infection or vaccination", "By transfer of antibodies"], ["*Onset*", "Slow", "Immediate"]]}, "page": 42}

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

// Main entry point: takes raw question strings, returns
// [{ question, answer, page, isError }] in the same order as input.
// No persistent caching — every call hits Gemini fresh (the old
// qa_cache table/scheme was dropped as not useful).
// extraKeys (optional): the calling user's own validated Gemini keys
// (see lib/userApiKeys.js) — pooled in on top of the shared
// GEMINI_API_KEYS for this call only, so users who've added their own
// free keys get more headroom/parallelism for their own requests.
// collector (optional): see answerBatch above.
async function answerQuestions(questions, bookId, extraKeys = [], collector = null) {
  const uniqueQuestions = questions.filter((q) => q && q.trim().length > 0);
  if (uniqueQuestions.length === 0) return [];

  // 1 embedding call covers the whole set of questions.
  await usageTracker.checkAndIncrement(1);
  const embeddings = await gemini.embedTexts(uniqueQuestions, 'RETRIEVAL_QUERY', extraKeys, collector);

  // Retrieval is pure DB work — safe to parallelize. Scoped to the one
  // book the asking user has selected (see users.selected_book_id /
  // /mybook), so answers only ever come from that book's chunks.
  const withChunks = await Promise.all(
    uniqueQuestions.map(async (q, idx) => ({
      question: q,
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
  results.forEach((r, i) => {
    if (r.page == null) return;
    const matchedImageChunk = withChunks[i]?.chunks.find(
      (c) => c.page_number === r.page && c.chunk_type === 'image' && c.image_base64
    );
    if (matchedImageChunk) {
      r.imageBase64 = matchedImageChunk.image_base64;
    }
  });

  return results;
}

module.exports = { answerQuestions };
