const crypto = require('crypto');
const supabase = require('./supabaseClient');
const gemini = require('./gemini');
const { retrieveChunks } = require('./rag');
const usageTracker = require('./usageTracker');
const env = require('./env');

function normalizeQuestion(q) {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashQuestion(q) {
  return crypto.createHash('sha256').update(normalizeQuestion(q)).digest('hex');
}

async function getCachedAnswers(hashes) {
  if (hashes.length === 0) return new Map();
  const { data, error } = await supabase
    .from('qa_cache')
    .select('question_hash, answer_text, page_number')
    .in('question_hash', hashes);
  if (error) throw new Error(`Cache lookup error: ${error.message}`);

  const map = new Map();
  for (const row of data) {
    map.set(row.question_hash, { answer: row.answer_text, page: row.page_number });
  }
  return map;
}

async function saveToCache(entries) {
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({
    question_hash: e.hash,
    question_text: e.question,
    answer_text: e.answer,
    page_number: e.page,
  }));
  // upsert to tolerate re-processing the same question concurrently
  const { error } = await supabase.from('qa_cache').upsert(rows, { onConflict: 'question_hash' });
  if (error) console.error('Cache save error:', error.message);
}

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

// Calls Gemini for one batch, with a fallback that halves the batch
// and retries if the model returns malformed/mismatched JSON.
async function answerBatch(items) {
  if (items.length === 0) return [];

  await usageTracker.checkAndIncrement(1);
  const prompt = buildBatchPrompt(items);

  try {
    const result = await gemini.generateJSON(prompt);
    if (!Array.isArray(result) || result.length !== items.length) {
      throw new Error('Mismatched batch response length');
    }
    return result.map((r, i) => ({
      question: items[i].question,
      answer: r.answer || 'لم يتم توليد إجابة',
      page: r.page ?? null,
    }));
  } catch (err) {
    if (items.length === 1) {
      // Last resort for a single question: return a safe fallback
      // instead of failing the whole batch.
      return [
        {
          question: items[0].question,
          answer: 'حصل خطأ في معالجة السؤال ده، جرب تبعته لوحده تاني.',
          page: null,
        },
      ];
    }
    const mid = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      answerBatch(items.slice(0, mid)),
      answerBatch(items.slice(mid)),
    ]);
    return [...left, ...right];
  }
}

// Main entry point: takes raw question strings, returns
// [{ question, answer, page }] in the same order as input.
async function answerQuestions(questions) {
  const uniqueQuestions = questions.filter((q) => q && q.trim().length > 0);
  const hashes = uniqueQuestions.map(hashQuestion);

  const cache = await getCachedAnswers(hashes);

  const toProcess = []; // { question, hash, originalIndex }
  const results = new Array(uniqueQuestions.length);

  uniqueQuestions.forEach((q, i) => {
    const hash = hashes[i];
    if (cache.has(hash)) {
      const cached = cache.get(hash);
      results[i] = { question: q, answer: cached.answer, page: cached.page };
    } else {
      toProcess.push({ question: q, hash, originalIndex: i });
    }
  });

  if (toProcess.length > 0) {
    // 1 embedding call covers the whole set of new questions.
    await usageTracker.checkAndIncrement(1);
    const embeddings = await gemini.embedTexts(toProcess.map((t) => t.question));

    // Retrieval is pure DB work — safe to parallelize.
    const withChunks = await Promise.all(
      toProcess.map(async (t, idx) => ({
        ...t,
        chunks: await retrieveChunks(embeddings[idx]),
      }))
    );

    const newAnswers = [];
    for (let i = 0; i < withChunks.length; i += env.BATCH_SIZE) {
      const batch = withChunks.slice(i, i + env.BATCH_SIZE);
      const batchResults = await answerBatch(
        batch.map((b) => ({ question: b.question, chunks: b.chunks }))
      );
      batchResults.forEach((r, j) => {
        const originalIndex = batch[j].originalIndex;
        results[originalIndex] = r;
        newAnswers.push({ hash: batch[j].hash, question: r.question, answer: r.answer, page: r.page });
      });
    }

    await saveToCache(newAnswers);
  }

  return results;
}

module.exports = { answerQuestions };
