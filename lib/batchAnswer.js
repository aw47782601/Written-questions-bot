const gemini = require('./gemini');
const { retrieveChunks } = require('./rag');
const usageTracker = require('./usageTracker');
const env = require('./env');

// Matches a trailing "{table}" tag (optionally preceded by whitespace) on a
// question's text — the user's/extraction's marker asking for a forced
// generic table answer even though the question isn't a comparison. Strips
// it off before the text is ever used for embedding/RAG/display; the flag
// itself rides alongside `chapter` through answerQuestions -> answerBatch.
const FORCE_TABLE_TAG_RE = /\s*\{table\}\s*$/i;

function extractForceTable(question) {
  const raw = String(question || '');
  const forceTable = FORCE_TABLE_TAG_RE.test(raw);
  return { question: forceTable ? raw.replace(FORCE_TABLE_TAG_RE, '').trim() : raw, forceTable };
}

function buildBatchPrompt(items) {
  // items: [{ question, chunks: [{content, page_number}], forceTable }]
  const forceTableNumbers = items
    .map((item, i) => (item.forceTable ? i + 1 : null))
    .filter((n) => n !== null);
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
${forceTableNumbers.length > 0 ? `
FORCED TABLE QUESTIONS — very important: question number(s) ${forceTableNumbers.join(', ')} must ALSO be answered as a TABLE, exactly like the COMPARISON QUESTIONS rules above (same "isComparison"/"comparisonTable" shape, same asterisk highlighting), even though the question itself is NOT a comparison. For these questions only:
- Use a generic aspect/detail layout instead of one-column-per-compared-item: "columns" should be exactly two strings — a label for the point/aspect name (e.g. "Aspect", "Type", "Feature" — whichever fits the question best) and a label for its detail (e.g. "Detail", "Description", "Explanation") — always in English, even when the question/excerpts/answer are in Arabic or any other language. "rows" should be one row per distinct point/type/example/characteristic that answers the question, with the point's name/aspect bolded in the first cell and the key detail bolded in the second cell.
- This applies only to the listed question number(s) — every other question keeps following the COMPARISON QUESTIONS rule (table only if it's an actual comparison) and the STRUCTURE rule otherwise.` : ''}

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
    return result.map((r, i) => {
      // forceTable items must render as a table even if Gemini's own
      // isComparison call came back false for them (it isn't a real
      // comparison, so it may reasonably say so) — as long as it did
      // fill in a usable comparisonTable, which the FORCED TABLE
      // instruction above asks it to.
      const isComparison = (!!r.isComparison || !!items[i].forceTable) && !!r.comparisonTable;
      return {
        question: items[i].question,
        isComparison,
        answer: r.answer || (isComparison ? '' : 'لم يتم توليد إجابة'),
        comparisonTable: isComparison ? r.comparisonTable || null : null,
        page: r.page ?? null,
        isError: false,
      };
    });
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
    .map((q) => {
      const base =
        typeof q === 'string'
          ? { question: q, chapter: null, forceTable: undefined }
          : { question: String(q?.question || ''), chapter: q?.chapter || null, forceTable: q?.forceTable };
      // Callers that already know forceTable (e.g. api/telegram-webhook.js
      // retrying a previously-failed question via its stored result, whose
      // question text has the {table} tag already stripped and the flag
      // carried separately as r.forceTable) pass it explicitly — respect
      // that instead of re-detecting from text that no longer has the tag.
      // Otherwise, detect + strip a trailing {table} tag here, up front, so
      // the stripped text (never the raw "{table}"-suffixed text) is what
      // gets embedded/retrieved/shown from this point on.
      if (typeof base.forceTable === 'boolean') {
        return { question: base.question, chapter: base.chapter, forceTable: base.forceTable };
      }
      const { question, forceTable } = extractForceTable(base.question);
      return { question, chapter: base.chapter, forceTable };
    })
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
      forceTable: it.forceTable,
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
        batch.map((b) => ({ question: b.question, chunks: b.chunks, forceTable: b.forceTable })),
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
    // Chapter/section tag (from AI extraction, see the comment above) —
    // carried over here rather than through answerBatch/Gemini, since it
    // has nothing to do with the answer itself. lib/pdfGenerator.js reads
    // r.chapter to draw a banner before the first question of each group.
    r.chapter = withChunks[i]?.chapter ?? null;
    // forceTable ({table} tag) — also carried over onto the final result
    // (like chapter) so it survives being re-staged across edit rounds in
    // api/telegram-webhook.js (see buildEditedResults/toAnswer there).
    r.forceTable = withChunks[i]?.forceTable ?? false;
  });

  return results;
}

module.exports = { answerQuestions };
