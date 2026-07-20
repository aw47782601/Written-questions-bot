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

If the excerpts attached to a given question don't contain a clear answer, return answer: "الإجابة مش واضحة في الأجزاء اللي تم البحث فيها من الكتاب" and page: null for that question only (leave this exact fallback message as-is, in Arabic — it's a fixed system message, not part of the book's content), and continue normally with the rest of the questions.

FORMATTING — very important: inside the "answer" text itself, wrap important words or terms (key concepts, numbers, definitions) with a single asterisk on each side, like *important word*, so they render bold when sent on Telegram. Do not use double asterisks **, underscores _, or any other formatting — use single asterisks only, and only around words that are actually important (not the whole sentence).

Return the result as a JSON array only (no extra text or markdown fences), in the same order as the questions, each item in exactly this shape:
{"question": "the question text", "answer": "the answer", "page": page_number_or_null}

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
      answer: { type: 'string' },
      page: { type: 'integer', nullable: true },
    },
    required: ['question', 'answer', 'page'],
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
  const maxOutputTokens = Math.min(32768, Math.max(4096, items.length * 1500));

  try {
    const result = await gemini.generateJSON(prompt, { maxOutputTokens, responseSchema: BATCH_RESPONSE_SCHEMA, extraKeys, collector });
    if (!Array.isArray(result) || result.length !== items.length) {
      throw new Error('Mismatched batch response length');
    }
    return result.map((r, i) => ({
      question: items[i].question,
      answer: r.answer || 'لم يتم توليد إجابة',
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
          answer: 'حصل خطأ في معالجة السؤال ده، جرب تبعته لوحده تاني.',
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
  return results;
}

module.exports = { answerQuestions };
