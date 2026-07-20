const gemini = require('./gemini');
const { retrieveChunks } = require('./rag');
const usageTracker = require('./usageTracker');
const env = require('./env');

function buildBatchPrompt(items) {
  // items: [{ question, chunks: [{content, page_number}] }]
  const blocks = items
    .map((item, i) => {
      const excerpts = item.chunks
        .map((c) => `[صفحة ${c.page_number}] ${c.content}`)
        .join('\n---\n');
      return `سؤال رقم ${i + 1}: ${item.question}\nمقتطفات من الكتاب متعلقة بيه:\n${excerpts}`;
    })
    .join('\n\n====================\n\n');

  return `أنت مساعد تعليمي بيجاوب على أسئلة الطلبة بالاعتماد فقط على المقتطفات المرفقة من كتاب المنهج. متستخدمش أي معلومة من برة المقتطفات دي.

لو المقتطفات المرفقة لسؤال معين مفيهاش إجابة واضحة، رجّع answer: "الإجابة مش واضحة في الأجزاء اللي تم البحث فيها من الكتاب" وpage: null لنفس السؤال ده بس، وكمّل باقي الأسئلة عادي.

رجّع النتيجة كـ JSON array فقط (بدون أي نص إضافي أو markdown fences)، بنفس ترتيب الأسئلة، كل عنصر بالشكل ده بالظبط:
{"question": "نص السؤال", "answer": "الإجابة", "page": رقم_الصفحة_أو_null}

الأسئلة:

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
async function answerBatch(items, extraKeys = []) {
  if (items.length === 0) return [];

  await usageTracker.checkAndIncrement(1);
  const prompt = buildBatchPrompt(items);
  // Give each question room for a fairly detailed answer, scaling with
  // batch size, capped at the model's max.
  const maxOutputTokens = Math.min(32768, Math.max(4096, items.length * 1500));

  try {
    const result = await gemini.generateJSON(prompt, { maxOutputTokens, responseSchema: BATCH_RESPONSE_SCHEMA, extraKeys });
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
      answerBatch(items.slice(0, mid), extraKeys),
      answerBatch(items.slice(mid), extraKeys),
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
async function answerQuestions(questions, bookId, extraKeys = []) {
  const uniqueQuestions = questions.filter((q) => q && q.trim().length > 0);
  if (uniqueQuestions.length === 0) return [];

  // 1 embedding call covers the whole set of questions.
  await usageTracker.checkAndIncrement(1);
  const embeddings = await gemini.embedTexts(uniqueQuestions, 'RETRIEVAL_QUERY', extraKeys);

  // Retrieval is pure DB work — safe to parallelize. Scoped to the one
  // book the asking user has selected (see users.selected_book_id /
  // /mybook), so answers only ever come from that book's chunks.
  const withChunks = await Promise.all(
    uniqueQuestions.map(async (q, idx) => ({
      question: q,
      chunks: await retrieveChunks(embeddings[idx], bookId),
    }))
  );

  const results = new Array(uniqueQuestions.length);
  for (let i = 0; i < withChunks.length; i += env.BATCH_SIZE) {
    const batch = withChunks.slice(i, i + env.BATCH_SIZE);
    const batchResults = await answerBatch(
      batch.map((b) => ({ question: b.question, chunks: b.chunks })),
      extraKeys
    );
    batchResults.forEach((r, j) => {
      results[i + j] = r;
    });
  }

  return results;
}

module.exports = { answerQuestions };
