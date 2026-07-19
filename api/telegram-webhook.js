const env = require('../lib/env');
const telegram = require('../lib/telegram');
const { ingestBook, getBookStatus, IngestionInProgressError } = require('../lib/ingestBook');
const { keywordSearchChunks, debugRetrieve } = require('../lib/rag');
const {
  MAX_QUESTIONS,
  extractQuestionsFromPdfBuffer,
  extractQuestionsFromPlainTextBuffer,
  extractQuestionsFromText,
} = require('../lib/questionExtractor');
const { answerQuestions } = require('../lib/batchAnswer');
const { DailyLimitReachedError } = require('../lib/usageTracker');

// Hobby plan's default/max duration is 300s (5 min) with fluid compute
// enabled (default on new projects) — see vercel.json.
module.exports.config = { maxDuration: 300 };

function formatResults(results) {
  return results
    .map((r, i) => {
      const pageNote = r.page ? ` _(صفحة ${r.page})_` : '';
      return `*${i + 1}.* ${r.question}\n${r.answer}${pageNote}`;
    })
    .join('\n\n');
}

async function handleBookUpload(chatId, fileId, fileName) {
  await telegram.sendMessage(chatId, '📚 استلمت الكتاب، جاري المعالجة...');
  try {
    const buffer = await telegram.downloadFileBuffer(fileId);
    const summary = await ingestBook(buffer, fileName, (msg) =>
      telegram.sendMessage(chatId, msg)
    );
    await telegram.sendMessage(
      chatId,
      `✅ تم تجهيز الكتاب بنجاح.\nعدد الصفحات: ${summary.pages}\nعدد الأجزاء القابلة للبحث: ${summary.chunks}\n\nالبوت جاهز يستقبل أسئلة دلوقت.`
    );
  } catch (err) {
    if (err instanceof IngestionInProgressError) {
      await telegram.sendMessage(chatId, `⏳ ${err.message}`);
      return;
    }
    console.error('Book ingestion failed:', err);
    await telegram.sendMessage(chatId, `❌ فشلت معالجة الكتاب:\n${err.message}`);
  }
}

async function handleQuestionsBatch(chatId, questions) {
  const bookStatus = await getBookStatus();
  if (bookStatus.status !== 'ready') {
    await telegram.sendMessage(
      chatId,
      '⚠️ لسه مفيش كتاب جاهز للبحث فيه. لازم الأدمن يرفع الكتاب الأول.'
    );
    return;
  }

  if (questions.length === 0) {
    await telegram.sendMessage(chatId, '⚠️ مقدرتش ألاقي أي أسئلة في الرسالة/الملف ده.');
    return;
  }

  if (questions.length > 1) {
    await telegram.sendMessage(chatId, `🔎 استلمت ${questions.length} سؤال، جاري البحث في الكتاب...`);
  }

  try {
    const results = await answerQuestions(questions);
    await telegram.sendLongMessage(chatId, formatResults(results));
  } catch (err) {
    console.error('Answering failed:', err);
    if (err instanceof DailyLimitReachedError) {
      await telegram.sendMessage(chatId, `⏳ ${err.message}`);
    } else {
      await telegram.sendMessage(chatId, `❌ حصل خطأ أثناء البحث عن الإجابات:\n${err.message}`);
    }
  }
}

async function handleStatusCommand(chatId) {
  const status = await getBookStatus();
  const lines = [
    `الحالة: ${status.status}`,
    status.file_name ? `الملف: ${status.file_name}` : null,
    status.total_pages ? `عدد الصفحات: ${status.total_pages}` : null,
    status.total_chunks ? `عدد الأجزاء: ${status.total_chunks}` : null,
    status.error_message ? `آخر خطأ: ${status.error_message}` : null,
    `موديل الـ embedding الحالي: ${env.GEMINI_EMBEDDING_MODEL}`,
  ].filter(Boolean);
  await telegram.sendMessage(chatId, lines.join('\n'));
}

// DIAGNOSTIC (admin only): /search <كلمة> — raw text search on book_chunks,
// bypassing embeddings entirely. Confirms whether content actually made
// it into the DB, independent of the retrieval/embedding pipeline.
async function handleSearchCommand(chatId, keyword) {
  if (!keyword) {
    await telegram.sendMessage(chatId, 'استخدم: /search كلمة_مفتاحية');
    return;
  }
  try {
    const rows = await keywordSearchChunks(keyword);
    if (rows.length === 0) {
      await telegram.sendMessage(
        chatId,
        `⚠️ مفيش أي chunk فيه "${keyword}" حرفيًا في book_chunks.\nمعنى كده إما الكلمة مش موجودة بالظبط بالنص ده، أو المحتوى أصلاً مترفعش صح وقت المعالجة.`
      );
      return;
    }
    const preview = rows
      .map((r, i) => `${i + 1}. [صفحة ${r.page_number}] ${r.content.slice(0, 200)}...`)
      .join('\n\n');
    await telegram.sendMessage(chatId, `✅ لقيت ${rows.length} chunk فيهم "${keyword}":\n\n${preview}`);
  } catch (err) {
    await telegram.sendMessage(chatId, `❌ ${err.message}`);
  }
}

// DIAGNOSTIC (admin only): /debug <سؤال> — runs the real embed+retrieve
// pipeline and shows the matched chunks with similarity scores, without
// calling the LLM. Low similarity across the board on a known topic
// points to an embedding-model mismatch between ingestion and now.
async function handleDebugCommand(chatId, question) {
  if (!question) {
    await telegram.sendMessage(chatId, 'استخدم: /debug سؤال تجريبي');
    return;
  }
  try {
    const chunks = await debugRetrieve(question);
    if (!chunks || chunks.length === 0) {
      await telegram.sendMessage(chatId, '⚠️ الـ retrieval رجع صفر chunks خالص.');
      return;
    }
    const preview = chunks
      .map(
        (c, i) =>
          `${i + 1}. [صفحة ${c.page_number}] similarity: ${c.similarity?.toFixed(3) ?? 'N/A'}\n${c.content.slice(0, 150)}...`
      )
      .join('\n\n');
    await telegram.sendMessage(chatId, `نتيجة الـ retrieval لـ "${question}":\n\n${preview}`);
  } catch (err) {
    await telegram.sendMessage(chatId, `❌ ${err.message}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const update = req.body;
    const message = update.message;
    if (!message) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;
    const isAdmin = env.ADMIN_CHAT_IDS.includes(String(chatId));

    if (message.document) {
      const fileName = message.document.file_name || '';
      const isPdf = fileName.toLowerCase().endsWith('.pdf');
      const isText = fileName.toLowerCase().endsWith('.txt');

      if (isAdmin && isPdf) {
        // Admin sending a PDF = replace the active curriculum book.
        await handleBookUpload(chatId, message.document.file_id, fileName);
      } else if (isPdf || isText) {
        // Anyone else sending a document = a batch of questions.
        const buffer = await telegram.downloadFileBuffer(message.document.file_id);
        const questions = isPdf
          ? await extractQuestionsFromPdfBuffer(buffer)
          : await extractQuestionsFromPlainTextBuffer(buffer);
        await handleQuestionsBatch(chatId, questions);
      } else {
        await telegram.sendMessage(chatId, '⚠️ الصيغة دي مش مدعومة، ابعت PDF أو TXT.');
      }
    } else if (message.text) {
      const text = message.text.trim();

      if (text === '/status' && isAdmin) {
        await handleStatusCommand(chatId);
      } else if (text.startsWith('/search ') && isAdmin) {
        await handleSearchCommand(chatId, text.slice('/search '.length).trim());
      } else if (text.startsWith('/debug ') && isAdmin) {
        await handleDebugCommand(chatId, text.slice('/debug '.length).trim());
      } else if (text.startsWith('/')) {
        await telegram.sendMessage(chatId, 'ابعتلي سؤال أو أكتر (سؤال في كل سطر) وهدور عليهم في الكتاب.');
      } else {
        const questions = extractQuestionsFromText(text).slice(0, MAX_QUESTIONS);
        await handleQuestionsBatch(chatId, questions);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    // Always 200 so Telegram doesn't retry-storm us on internal errors.
    res.status(200).json({ ok: true });
  }
};
