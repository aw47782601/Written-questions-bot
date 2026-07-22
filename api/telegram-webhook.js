const env = require('../lib/env');
const telegram = require('../lib/telegram');
const books = require('../lib/books');
const gemini = require('../lib/gemini');
const { keywordSearchChunks, debugRetrieve } = require('../lib/rag');
const {
  MAX_QUESTIONS,
  extractQuestionsFromPdfBuffer,
  extractQuestionsFromPlainTextBuffer,
  extractQuestionsFromText,
} = require('../lib/questionExtractor');
const { answerQuestions } = require('../lib/batchAnswer');
const pdfDesigns = require('../lib/pdfDesigns');
const pdfAccess = require('../lib/pdfAccess');
const pdfColors = require('../lib/pdfColors');
const { DailyLimitReachedError } = require('../lib/usageTracker');
const botConfig = require('../lib/botConfig');
const users = require('../lib/users');
const pendingBatches = require('../lib/pendingBatches');
const userApiKeys = require('../lib/userApiKeys');
const telegramUpdates = require('../lib/telegramUpdates');
const cairoTime = require('../lib/cairoTime');

// Hobby plan's default/max duration is 300s (5 min) with fluid compute
// enabled (default on new projects) — see vercel.json.
module.exports.config = { maxDuration: 300 };

// Minimum number of the user's OWN validated Gemini keys before they get
// pooled in on top of the bot's shared keys. Mirrors MIN_USER_KEYS_FOR_GENERATE
// from the source admin bot, adapted here to gate a quota boost rather than
// an entire feature (this bot doesn't have an extract/generate mode split).
const MIN_USER_KEYS_FOR_BOOST = 2;
const APPROX_ANALYSES_PER_KEY = 20;

function isAdmin(chatId) {
  return env.ADMIN_CHAT_IDS.includes(String(chatId));
}

// Sends a message to every configured admin (best-effort, doesn't throw
// on individual failures — e.g. an admin who blocked the bot).
async function notifyAdmins(text, extra = {}) {
  await Promise.all(
    env.ADMIN_CHAT_IDS.map((id) =>
      telegram.sendMessage(id, text, extra).catch((err) => console.error(`notifyAdmins failed for ${id}:`, err.message))
    )
  );
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =========================================================
// 📚 Book Q&A (existing behavior, unchanged)
// =========================================================

function formatResults(results) {
  return results
    .map((r, i) => {
      const pageNote = r.page ? ` _(صفحة ${r.page})_` : '';
      return `*${i + 1}.* ${r.question}\n${r.answer}${pageNote}`;
    })
    .join('\n\n');
}

function bookNameFromFileName(fileName) {
  return fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'كتاب بدون اسم';
}

// =========================================================
// 📝📄🎨 Per-batch answer format + PDF color — every time a user sends
// questions, they're asked (via inline buttons) whether they want the
// answers as plain Telegram text, a generated PDF styled like the
// reference book (see lib/pdfGenerator.js / lib/pdfDesigns.js), or both.
// If they picked pdf/both, they're then asked (also via inline buttons,
// every single time) which main color they want THAT PDF in. Nothing is
// persisted across batches — this replaces both the old /format command
// (standing users.answer_format preference) and the old /pdfcolor command
// (standing users.pdf_color preference). See lib/users.js for the history
// of both.
//
// The PDF/Both buttons are hidden entirely for a user the admin hasn't
// given access to ANY PDF design (see lib/pdfAccess.js + the button-driven
// "🎨 صلاحيات تصاميم الـ PDF" admin panel below), so they're never even
// offered the option; the ansfmt_ callback re-checks access before moving
// on to the color step, in case access was revoked between the buttons
// being shown and tapped.
// =========================================================

const FORMAT_LABELS = {
  text: '📝 نص فقط',
  pdf: '📄 PDF فقط',
  both: '📝📄 نص + PDF',
};
const VALID_ANSWER_FORMATS = Object.keys(FORMAT_LABELS);

function buildFormatKeyboard(token, pdfAllowed) {
  const values = pdfAllowed ? VALID_ANSWER_FORMATS : ['text'];
  const buttons = values.map((value) => [{ text: FORMAT_LABELS[value], callback_data: `ansfmt_${value}_${token}` }]);
  return { inline_keyboard: buttons };
}

// Shown after the user picks pdf/both — one button per PDF design they
// currently have access to (see lib/pdfDesigns.js / lib/pdfAccess.js).
// Comes BEFORE the color step (see buildColorKeyboard below) so the design
// choice is always asked explicitly instead of silently auto-picking, since
// more designs are expected to be registered later.
function buildDesignKeyboard(token, accessibleDesigns) {
  const buttons = accessibleDesigns.map((d) => [
    { text: `🖼️ ${d.label}`, callback_data: `ansdsg_${d.id}_${token}` },
  ]);
  return { inline_keyboard: buttons };
}

// Shown after the user picks a design, so they choose a color for THIS
// PDF only (nothing persisted — see the block comment above).
function buildColorKeyboard(token) {
  const buttons = pdfColors.listPdfColors().map((c) => [
    { text: `${c.emoji} ${c.label}`, callback_data: `ansclr_${c.key}_${token}` },
  ]);
  return { inline_keyboard: buttons };
}

// Called only when the admin explicitly started the "➕ إضافة كتاب جديد"
// button flow and already typed the book's name (staged in
// addbookbuf_<adminId> — see handleAddBookStart). A PDF from the admin
// with no such pending name is treated as a normal question document
// instead (see the document dispatch in the main webhook handler).
async function handleBookUpload(chatId, adminId, fileId, fileName, caption) {
  const pending = await botConfig.getConfig(`addbookbuf_${adminId}`);
  if (pending?.name) await botConfig.deleteConfig(`addbookbuf_${adminId}`);
  const bookName = pending?.name || (caption && caption.trim()) || bookNameFromFileName(fileName);

  await telegram.sendMessage(chatId, `📚 استلمت الكتاب "${bookName}"، جاري المعالجة...`);
  try {
    const buffer = await telegram.downloadFileBuffer(fileId);
    const summary = await books.ingestNewBook(buffer, fileName, bookName, (msg) =>
      telegram.sendMessage(chatId, msg)
    );
    await telegram.sendMessage(
      chatId,
      `✅ تم تجهيز الكتاب "${bookName}" بنجاح (ID: ${summary.id}).\n` +
        `عدد الصفحات: ${summary.pages}\nعدد الأجزاء القابلة للبحث: ${summary.chunks}\n\n` +
        `المستخدمين هيقدروا يختاروه عبر /mybook.`
    );
  } catch (err) {
    console.error('Book ingestion failed:', err);
    await telegram.sendMessage(chatId, `❌ فشلت معالجة الكتاب "${bookName}":\n${err.message}`);
  }
}

// Resolves which book to answer against for this user. Auto-selects and
// persists when there's exactly one ready book (so solo-book deployments
// need zero extra steps from users). When there are 0 or 2+ ready books,
// returns null and the caller tells the user what to do.
async function resolveBookForUser(fromUser) {
  const readyBooks = await books.listReadyBooks();
  if (readyBooks.length === 0) return { readyBooks, book: null };

  const selectedId = fromUser ? await users.getSelectedBookId(fromUser.id) : null;
  if (selectedId) {
    const stillReady = readyBooks.find((b) => b.id === selectedId);
    if (stillReady) return { readyBooks, book: stillReady };
    // Previously-selected book was deleted or is no longer ready — fall
    // through to re-resolve below.
  }

  if (readyBooks.length === 1) {
    if (fromUser) await users.setSelectedBookId(fromUser.id, readyBooks[0].id);
    return { readyBooks, book: readyBooks[0] };
  }

  return { readyBooks, book: null };
}

// Groups the raw generationCalls/embeddingCalls collected during a
// request into one readable admin report: which key(s)/model(s)
// succeeded, whether any fallback attempts happened along the way, and
// which questions ultimately failed — all as a single message instead of
// one notification per Gemini call.
function buildUsageReportLines(usage) {
  const lines = [];

  const successfulGen = usage.generationCalls.filter((g) => !g.failed);
  if (successfulGen.length > 0) {
    const counts = {};
    successfulGen.forEach((g) => {
      const label = `${g.keyLabel} · ${g.model}`;
      counts[label] = (counts[label] || 0) + 1;
    });
    const keyLines = Object.entries(counts)
      .map(([label, n]) => `• ${label}${n > 1 ? ` (×${n})` : ''}`)
      .join('\n');
    lines.push(`🔑 <b>المفتاح/الموديل اللي نجح:</b>\n${keyLines}`);
  }

  if (usage.embeddingCalls.length > 0) {
    const embedLabels = [...new Set(usage.embeddingCalls.map((e) => e.keyLabel))];
    lines.push(`🔎 <b>مفتاح الـ embedding:</b> ${embedLabels.join('، ')}`);
  }

  const fallbackAttempts = usage.generationCalls.flatMap((g) => g.attempts || []);
  if (fallbackAttempts.length > 0) {
    lines.push(
      `⚠️ <b>حصل fallback (${fallbackAttempts.length} محاولة فشلت قبل النجاح):</b>\n${gemini.formatAttemptLog(fallbackAttempts)}`
    );
  }

  if (usage.failures.length > 0) {
    const shown = usage.failures.slice(0, 10);
    const failLines = shown
      .map((f, i) => {
        const trimmed = f.errMessage.length > 300 ? `${f.errMessage.slice(0, 300)}…` : f.errMessage;
        return `${i + 1}. ${escapeHtml(f.question)}\nالسبب: <code>${escapeHtml(trimmed)}</code>`;
      })
      .join('\n\n');
    const more = usage.failures.length > shown.length ? `\n\n(+${usage.failures.length - shown.length} سؤال تاني فشل)` : '';
    lines.push(`🟠 <b>أسئلة فشلت نهائياً بعد كل المحاولات (${usage.failures.length}):</b>\n${failLines}${more}`);
  }

  return lines;
}

// fromUser (optional): the Telegram `from` object of whoever sent the
// questions. When provided: (1) their own validated Gemini keys (if they
// have MIN_USER_KEYS_FOR_BOOST or more) are pooled in for this request
// only, giving them extra headroom beyond the shared bot quota, and (2)
// admins get ONE consolidated report at the end covering the user, the
// success rate, which key(s)/model(s) were used, any fallback attempts,
// and any questions that ultimately failed.
// Entry point for every incoming batch of questions (typed or from a
// document). Resolves the book and validates the questions same as
// before, then — instead of immediately answering — stages the batch and
// asks the user which format they want THIS batch delivered in. The
// actual Gemini call + delivery happens in processBatchWithFormat, once
// they tap a button (see the ansfmt_ callback handler).
async function handleQuestionsBatch(chatId, questions, fromUser = null) {
  const { readyBooks, book } = await resolveBookForUser(fromUser);

  if (readyBooks.length === 0) {
    await telegram.sendMessage(
      chatId,
      '⚠️ لسه مفيش أي كتاب جاهز للبحث فيه. لازم الأدمن يرفع كتاب الأول.'
    );
    return;
  }

  if (!book) {
    await telegram.sendMessage(
      chatId,
      `📚 فيه أكتر من كتاب متاح (${readyBooks.length}). اختار الكتاب اللي عايز تدور فيه الأول عبر /mybook.`
    );
    return;
  }

  if (questions.length === 0) {
    await telegram.sendMessage(chatId, '⚠️ مقدرتش ألاقي أي أسئلة في الرسالة/الملف ده.');
    return;
  }

  // fromUser is null only for odd edge cases (no `from` on the update) —
  // there's no one to key a pending-batch/callback flow to, so just fall
  // back to answering directly as plain text like before.
  if (!fromUser) {
    await processBatchWithFormat(chatId, questions, book, null, 'text');
    return;
  }

  const token = await pendingBatches.stageBatch(fromUser.id, { questions, bookId: book.id });
  const pdfAllowed = (await pdfAccess.getAccessibleDesigns(fromUser.id, isAdmin)).length > 0;
  const countLine =
    questions.length > 1
      ? `🔎 استلمت ${questions.length} سؤال من "${book.name}".`
      : `🔎 استلمت سؤالك من "${book.name}".`;
  await telegram.sendMessage(chatId, `${countLine}\n\n📝📄 عايز تستلم الإجابة/الإجابات إزاي؟`, {
    reply_markup: buildFormatKeyboard(token, pdfAllowed),
  });
}

// Does the actual Gemini answering + delivery in the chosen format, plus
// the admin usage report. Called once the user has picked a format (and,
// if it includes PDF, a design + color) for this specific batch — or
// immediately with the defaults, for the fromUser === null edge case (see
// handleQuestionsBatch).
async function processBatchWithFormat(chatId, questions, book, fromUser, format, designId, colorKey) {
  const userLabel = fromUser
    ? `${escapeHtml(fromUser.first_name || '')}${fromUser.username ? ' (@' + escapeHtml(fromUser.username) + ')' : ''} — <code>${fromUser.id}</code>`
    : `<code>${chatId}</code>`;

  // Collects "which key/model was used" + "which questions ultimately
  // failed" across every Gemini call made for this request, so exactly
  // ONE admin report gets sent at the end instead of one per call.
  const usage = { embeddingCalls: [], generationCalls: [], failures: [] };

  try {
    let extraKeys = [];
    if (fromUser) {
      const ownKeys = await userApiKeys.getUserApiKeysList(fromUser.id);
      if (ownKeys.length >= MIN_USER_KEYS_FOR_BOOST) {
        extraKeys = ownKeys.map((k) => k.api_key);
      }
    }
    const results = await answerQuestions(questions, book.id, extraKeys, usage);

    const wantsText = format === 'text' || format === 'both';
    const wantsPdf = format === 'pdf' || format === 'both';

    if (wantsText) {
      await telegram.sendLongMessage(chatId, formatResults(results));
    }
    let pdfSent = false;
    if (wantsPdf) {
      const effectiveDesignId = designId || pdfDesigns.DEFAULT_DESIGN_ID;
      const pdfAllowed = fromUser ? await pdfAccess.isDesignAllowed(effectiveDesignId, fromUser.id, isAdmin) : true;
      if (!pdfAllowed) {
        // Access was revoked between the design/color buttons being shown
        // and this batch actually running — fall back to text so the
        // user isn't left with nothing.
        await telegram.sendMessage(chatId, '⚠️ صيغة الـ PDF مش متاحة لحسابك حالياً.');
        if (!wantsText) await telegram.sendLongMessage(chatId, formatResults(results));
      } else {
        try {
          const pdfBuffer = await pdfDesigns.renderPdf(effectiveDesignId, results, {
            title: 'Question Answers',
            bookName: book.name,
            colorKey: colorKey || pdfColors.DEFAULT_PDF_COLOR,
          });
          await telegram.sendDocument(chatId, pdfBuffer, `answers_${Date.now()}.pdf`, {
            caption: `📄 إجاباتك على ${results.length} سؤال من "${book.name}"`,
          });
          pdfSent = true;
        } catch (pdfErr) {
          console.error('PDF generation/send failed:', pdfErr);
          await telegram.sendMessage(chatId, '⚠️ حصل خطأ أثناء تجهيز ملف الـ PDF، بس الإجابات وصلتك كنص لو كان مطلوب.');
          if (!wantsText) {
            // PDF was the only requested format and it failed — make sure
            // the user isn't left with nothing.
            await telegram.sendLongMessage(chatId, formatResults(results));
          }
        }
      }
    }

    // A question counts as "successfully answered" when Gemini matched
    // it to real book content (page !== null) and it wasn't a transient
    // error. Questions the book genuinely doesn't cover come back with
    // page: null and don't count toward the success rate.
    const total = results.length;
    const success = results.filter((r) => !r.isError && r.page !== null).length;

    const formatLine = `📨 <b>صيغة الاستلام:</b> ${FORMAT_LABELS[format]}${wantsPdf && !pdfSent ? ' (⚠️ فشل إرسال الـ PDF)' : ''}`;
    const reportLines = [
      `📊 <b>تقرير معالجة أسئلة</b>`,
      `👤 ${userLabel}`,
      `📖 ${escapeHtml(book.name)}`,
      formatLine,
      `✅ <b>${success}/${total}</b> سؤال اتجاوب عليه من الكتاب.`,
      ...buildUsageReportLines(usage),
    ];
    await notifyAdmins(reportLines.join('\n\n'), { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Answering failed:', err);
    if (err instanceof DailyLimitReachedError) {
      await telegram.sendMessage(chatId, `⏳ ${err.message}`);
    } else {
      await telegram.sendMessage(chatId, `❌ حصل خطأ أثناء البحث عن الإجابات:\n${err.message}`);
    }
    const reportLines = [
      `🛑 <b>فشلت معالجة أسئلة</b>`,
      `👤 ${userLabel}`,
      `📄 عدد الأسئلة: <code>${questions.length}</code>`,
      `السبب: <code>${escapeHtml(err.message)}</code>`,
      ...buildUsageReportLines(usage),
    ];
    await notifyAdmins(reportLines.join('\n\n'), { parse_mode: 'HTML' });
  }
}

// Builds the text + inline keyboard for the admin book list/management
// screen. Shared by the /books /status commands (new message) and the
// "🔙 رجوع" callback (edits the existing message back to this view).
async function buildBooksOverview() {
  const allBooks = await books.listBooks();
  if (allBooks.length === 0) {
    return {
      text: 'لسه مفيش أي كتاب مضاف. اضغط الزر تحت عشان تضيف كتاب.',
      reply_markup: { inline_keyboard: [[{ text: '➕ إضافة كتاب جديد', callback_data: 'cmd_addbooknew' }]] },
    };
  }
  const lines = allBooks.map((b) => {
    const parts = [
      `📖 <b>${escapeHtml(b.name)}</b> (ID: <code>${b.id}</code>)`,
      `الحالة: ${b.status}`,
      b.file_name ? `الملف: ${escapeHtml(b.file_name)}` : null,
      b.total_pages ? `عدد الصفحات: ${b.total_pages}` : null,
      b.total_chunks ? `عدد الأجزاء: ${b.total_chunks}` : null,
      b.error_message ? `آخر خطأ: ${escapeHtml(b.error_message)}` : null,
    ].filter(Boolean);
    return parts.join('\n');
  });
  lines.push(`موديل الـ embedding الحالي: ${env.GEMINI_EMBEDDING_MODEL}`);
  lines.push('اختار كتاب تحت عشان تغيّر اسمه أو تحذفه:');

  const buttons = allBooks.map((b) => [{ text: `⚙️ ${b.name}`, callback_data: `cmd_bookmenu_${b.id}` }]);
  buttons.push([{ text: '➕ إضافة كتاب جديد', callback_data: 'cmd_addbooknew' }]);

  return { text: lines.join('\n\n'), reply_markup: { inline_keyboard: buttons } };
}

async function handleStatusCommand(chatId) {
  const { text, reply_markup } = await buildBooksOverview();
  await telegram.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
}

async function handleBooksList(chatId) {
  return handleStatusCommand(chatId);
}

// Edits an existing admin message back to the book overview (used by the
// "🔙 رجوع" button so browsing books/renaming/deleting stays in one
// message instead of spamming new ones).
async function handleBooksBackButton(chatId, messageId) {
  const { text, reply_markup } = await buildBooksOverview();
  await telegram.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup });
}

// Per-book management submenu: rename / delete / back. Reached by
// tapping a book in the overview list (⚙️ <name>).
async function handleBookMenuButton(chatId, messageId, bookId) {
  const book = await books.getBook(bookId);
  if (!book) {
    await telegram.editMessageText(chatId, messageId, '❌ الكتاب ده اتحذف بالفعل.');
    return;
  }
  const text =
    `📖 <b>${escapeHtml(book.name)}</b> (ID: <code>${book.id}</code>)\n` +
    `الحالة: ${book.status}${book.total_pages ? `\nعدد الصفحات: ${book.total_pages}` : ''}\n\n` +
    `اختار إجراء:`;
  await telegram.editMessageText(chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ تغيير الاسم', callback_data: `cmd_bookrename_${book.id}` }],
        [{ text: '🗑 حذف الكتاب', callback_data: `cmd_bookdelete_${book.id}` }],
        [{ text: '🔙 رجوع', callback_data: 'cmd_booksback' }],
      ],
    },
  });
}

// Puts the admin into "waiting to type the new name" mode for a book.
async function handleBookRenameStart(chatId, messageId, adminId, bookId) {
  const book = await books.getBook(bookId);
  if (!book) {
    await telegram.editMessageText(chatId, messageId, '❌ الكتاب ده اتحذف بالفعل.');
    return;
  }
  await botConfig.setConfig(`renamebook_${adminId}`, { bookId });
  await telegram.editMessageText(
    chatId,
    messageId,
    `✏️ ابعت الاسم الجديد لكتاب "${escapeHtml(book.name)}" دلوقت كرسالة نصية.`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: `cmd_bookmenu_${bookId}` }]] },
    }
  );
}

// Called when a plain-text message arrives while the admin is in
// "waiting to type a new book name" mode (set by handleBookRenameStart).
// Returns true if it handled the message.
async function tryHandleBookRenamePaste(chatId, adminId, text) {
  const state = await botConfig.getConfig(`renamebook_${adminId}`);
  if (!state || !state.bookId) return false;

  await botConfig.deleteConfig(`renamebook_${adminId}`);
  const newName = text.trim();
  if (!newName) {
    await telegram.sendMessage(chatId, '⚠️ الاسم فاضي، اتلغت العملية. استخدم /books تاني لو عايز تحاول.');
    return true;
  }
  const book = await books.getBook(state.bookId);
  if (!book) {
    await telegram.sendMessage(chatId, '❌ الكتاب ده اتحذف بالفعل.');
    return true;
  }
  await books.renameBook(state.bookId, newName);
  await telegram.sendMessage(chatId, `✅ تم تغيير اسم الكتاب من "${escapeHtml(book.name)}" إلى "${escapeHtml(newName)}".`, {
    parse_mode: 'HTML',
  });
  return true;
}

async function handleBookDeleteConfirmPrompt(chatId, messageId, bookId) {
  const book = await books.getBook(bookId);
  if (!book) {
    await telegram.editMessageText(chatId, messageId, '❌ الكتاب ده اتحذف بالفعل.');
    return;
  }
  await telegram.editMessageText(
    chatId,
    messageId,
    `⚠️ متأكد إنك عايز تحذف الكتاب "${escapeHtml(book.name)}"؟ الإجراء ده نهائي.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ نعم، احذف', callback_data: `cmd_bookdeleteconfirm_${bookId}` }],
          [{ text: '❌ إلغاء', callback_data: `cmd_bookmenu_${bookId}` }],
        ],
      },
    }
  );
}

async function handleBookDeleteConfirmed(chatId, messageId, bookId) {
  const book = await books.getBook(bookId);
  if (!book) {
    await telegram.editMessageText(chatId, messageId, '❌ الكتاب ده اتحذف بالفعل.');
    return;
  }
  await books.deleteBook(bookId);
  await telegram.editMessageText(chatId, messageId, `✅ تم حذف الكتاب "${escapeHtml(book.name)}" (ID: ${bookId}).`, {
    parse_mode: 'HTML',
  });
}

// Puts the admin into "waiting to type a name for the new book" mode
// (button-driven equivalent of typing /addbook <name>).
async function handleAddBookNewPrompt(chatId, messageId, adminId) {
  await botConfig.setConfig(`addbook_waitname_${adminId}`, { active: true });
  await telegram.editMessageText(chatId, messageId, '📚 ابعت اسم الكتاب الجديد دلوقت كرسالة نصية.', {
    reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cmd_booksback' }]] },
  });
}

// Stages the given name for the admin's very next PDF upload (only
// reached via the "➕ إضافة كتاب جديد" button flow — see
// tryHandleAddBookNamePaste below).
async function handleAddBookStart(chatId, adminId, name) {
  if (!name) return;
  await botConfig.setConfig(`addbookbuf_${adminId}`, { name });
  await telegram.sendMessage(
    chatId,
    `✅ تمام، دلوقت ابعت ملف الـ PDF الخاص بكتاب "${name}".`
  );
}

// Called when a plain-text message arrives while the admin is in
// "waiting to type a new book's name" mode (set by handleAddBookNewPrompt,
// the button flow). Delegates to the existing handleAddBookStart so the
// following-PDF-upload step stages the book's name the same way.
async function tryHandleAddBookNamePaste(chatId, adminId, text) {
  const state = await botConfig.getConfig(`addbook_waitname_${adminId}`);
  if (!state || !state.active) return false;

  await botConfig.deleteConfig(`addbook_waitname_${adminId}`);
  const name = text.trim();
  if (!name) {
    await telegram.sendMessage(chatId, '⚠️ الاسم فاضي، اتلغت العملية. اضغط "➕ إضافة كتاب جديد" تاني لو عايز تحاول.');
    return true;
  }
  await handleAddBookStart(chatId, adminId, name);
  return true;
}

// =========================================================
// 📖 /mybook — every user (not just admins) picks which book their
// questions get answered against, and can change it any time.
// =========================================================

async function handleMyBookCommand(chatId, userId) {
  const readyBooks = await books.listReadyBooks();
  if (readyBooks.length === 0) {
    await telegram.sendMessage(chatId, '⚠️ لسه مفيش أي كتاب جاهز. لازم الأدمن يرفع كتاب الأول.');
    return;
  }

  const selectedId = await users.getSelectedBookId(userId);
  const buttons = readyBooks.map((b) => [
    {
      text: `${b.id === selectedId ? '✅ ' : ''}${b.name}`,
      callback_data: `cmd_selectbook_${b.id}`,
    },
  ]);
  await telegram.sendMessage(chatId, '📚 اختار الكتاب اللي عايز تدور فيه:', {
    reply_markup: { inline_keyboard: buttons },
  });
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

// =========================================================
// 👮 Admin panel (ported from the admin bot)
// =========================================================

async function handleAdminHelp(chatId) {
  const helpMsg =
    `🛠️ <b>لوحة التحكم والأوامر الإدارية:</b>\n\n` +
    `📊 <b>الإحصائيات:</b>\n` +
    `• <code>/stats</code> — إحصائيات عامة (مستخدمين، إجابات محفوظة).\n` +
    `• <code>/user USER_ID</code> — تقرير عن مستخدم معين.\n\n` +
    `📚 <b>إدارة الكتب:</b>\n` +
    `• <code>/books</code> أو <code>/status</code> — عرض كل الكتب مع أزرار لكل كتاب (تغيير الاسم / حذف) وزر لإضافة كتاب جديد.\n` +
    `• إضافة/تغيير اسم/حذف كتاب بيتم بالأزرار بس (مفيش أوامر نصية للحاجات دي). لو بعتّ PDF من غير ما تدوس "➕ إضافة كتاب جديد" الأول، هيتعامل معاه كملف أسئلة عادي زي أي مستخدم.\n` +
    `• <code>/search كلمة</code> و <code>/debug سؤال</code> — أدوات تشخيصية على كل الكتب.\n\n` +
    `⚙️ <b>الإعدادات العامة:</b>\n` +
    `• <code>/setwelcome النص</code> — تغيير رسالة الترحيب عند /start.\n` +
    `• <code>/setalert النص</code> — تنبيه عام يظهر لكل مستخدم مرة واحدة.\n\n` +
    `📢 <b>البرودكاست:</b>\n` +
    `• <code>/broadcast النص</code> — رسالة فورية لكل المستخدمين المسجلين (بعد تأكيد).\n\n` +
    `🔧 <b>وضع الصيانة:</b>\n` +
    `• <code>/repairon</code> — يمنع كل المستخدمين عدا الأدمن من استخدام البوت.\n` +
    `• <code>/repairoff</code> — إيقاف الصيانة.\n\n` +
    `🚫 <b>حظر المستخدمين:</b>\n` +
    `• <code>/ban USER_ID</code>, <code>/unban USER_ID</code>, <code>/banlist</code>\n\n` +
    `🎨 <b>صلاحيات تصاميم الـ PDF:</b>\n` +
    `• <code>/pdfaccess</code> — يفتح لوحة أزرار: قايمة كل تصاميم الـ PDF المسجّلة، ادوس على أي تصميم عشان تشوف/تغيّر وضعه (متاح للكل ⇄ مقيّد على مجموعة)، ولو مقيّد تقدر تضيف/تشيل مستخدمين من مجموعته بالأزرار (بتكتب الـ USER_ID لما يتطلب منك ده بس).\n` +
    `• الوضع الافتراضي لأي تصميم جديد هو \"متاح للكل\".\n\n` +
    `⏳ <b>فترات إغلاق مجدولة (زي الامتحانات):</b>\n` +
    `• <code>/addblock</code> — يفتح لك تقويم وأزرار لاختيار تاريخ ووقت البداية والنهاية (12 ساعة + صباحاً/مساءً)، من غير ما تكتب حاجة يدوي. يقفل البوت لكل حد غير الأدمن في الفترة دي (بتوقيت القاهرة).\n` +
    `• <code>/addblock 2026-06-01 08:00 AM | 2026-06-15 08:00 PM | امتحانات نصف العام</code> — طريقة الكتابة اليدوية القديمة لسه شغالة لو حبيت (بتقبل صباحاً/مساءً أو نظام الـ24 ساعة، السبب اختياري).\n` +
    `• <code>/blocklist</code> — عرض كل الفترات المجدولة وحالتها (شغالة/لسه/انتهت).\n` +
    `• <code>/removeblock</code> — يديك قايمة أزرار لكل فترة مع 🗑 تحذفها منها مباشرة.\n` +
    `• <code>/removeblock ID</code> — حذف فترة بكتابة رقمها يدوي (الرقم من /blocklist)، لسه شغالة لو حبيت.\n\n` +
    `🔑 <b>مفاتيح API الخاصة بالمستخدمين:</b>\n` +
    `• <code>/mykeys</code>, <code>/addkey</code>, <code>/removekey</code> — تعمل للأدمن أيضاً على مفاتيحه.\n` +
    ` مفتاحين أو أكتر يمنحوا المستخدم أولوية إضافية في حصة Gemini اليومية.\n\n` +
    `📝📄🎨 <b>صيغة استلام الإجابات ولون الـ PDF:</b>\n` +
    `• كل ما مستخدم يبعت سؤال أو أسئلة، البوت بيسأله بأزرار: نص، PDF منسّق زي الكتاب، أو الاثنين — لكل دفعة أسئلة على حدة (مفيش تفضيل ثابت محفوظ).\n` +
    `• لو اختار PDF أو الاثنين، هيتسأل بعدها بأزرار كمان يعايز أي لون أساسي للـ PDF ده تحديداً — في كل مرة من جديد (مفيش لون ثابت محفوظ).\n` +
    `• زر الـ PDF أصلاً بيظهر بس لو المستخدم عنده صلاحية لتصميم PDF واحد على الأقل (شوف \"صلاحيات تصاميم الـ PDF\" فوق).\n` +
    `• بتلاقي الصيغة اللي اختارها مذكورة في تقرير كل دفعة أسئلة بيوصلك.`;
  await telegram.sendMessage(chatId, helpMsg, { parse_mode: 'HTML' });
}

async function handleStats(chatId) {
  await telegram.sendMessage(chatId, '⏳ جاري التحليل...');
  const s = await users.getGlobalStats();
  const report =
    `📊 <b>الإحصائيات:</b>\n\n` +
    `👥 <b>المستخدمين:</b>\n` +
    `• الإجمالي: <code>${s.users.total}</code>\n` +
    `• النشطين اليوم: <code>${s.users.active}</code>\n\n` +
    `💾 <b>نداءات Gemini اليوم:</b> <code>${s.geminiCallsToday}</code>`;
  await telegram.sendMessage(chatId, report, { parse_mode: 'HTML' });
}

async function handleUserReport(chatId, targetId) {
  if (!targetId) {
    await telegram.sendMessage(chatId, '⚠️ استخدم: <code>/user USER_ID</code>', { parse_mode: 'HTML' });
    return;
  }
  const u = await users.getUserStats(targetId);
  if (!u) {
    await telegram.sendMessage(chatId, '❌ المستخدم غير موجود.');
    return;
  }
  const keys = await userApiKeys.getUserApiKeysList(targetId);
  await telegram.sendMessage(
    chatId,
    `👤 <b>تقرير مستخدم:</b>\n` +
      `🆔 <code>${u.user_id}</code>\n` +
      `📛 ${escapeHtml(u.first_name || '—')}${u.username ? ' (@' + escapeHtml(u.username) + ')' : ''}\n` +
      `🕐 آخر نشاط: ${u.last_active}\n` +
      `🔑 مفاتيحه الخاصة: <code>${keys.length}</code>`,
    { parse_mode: 'HTML' }
  );
}

async function handleSetWelcome(chatId, newText) {
  if (!newText) {
    await telegram.sendMessage(chatId, '⚠️ اكتب النص بعد الأمر.');
    return;
  }
  await botConfig.setConfig('welcome_msg', { text: newText });
  await telegram.sendMessage(chatId, '✅ تم تحديث رسالة الترحيب.');
}

async function handleSetAlert(chatId, newText) {
  if (!newText) {
    await telegram.sendMessage(chatId, '⚠️ اكتب النص بعد الأمر.');
    return;
  }
  const alertId = `alert_${Date.now()}`;
  await botConfig.setConfig('global_alert', { text: newText, id: alertId });
  await telegram.sendMessage(chatId, `✅ تم نشر التنبيه (ID: ${alertId}).`);
}

async function handleBroadcastPreview(chatId, adminId, broadcastText) {
  if (!broadcastText) {
    await telegram.sendMessage(chatId, '⚠️ اكتب نص الرسالة بعد الأمر.\nمثال: <code>/broadcast مرحباً بالجميع! 🎉</code>', {
      parse_mode: 'HTML',
    });
    return;
  }
  await botConfig.setConfig(`broadcast_pending_${adminId}`, { text: broadcastText });
  const preview =
    `📢 <b>معاينة رسالة البرودكاست:</b>\n\n` +
    `➖➖➖➖➖➖➖➖➖➖\n${escapeHtml(broadcastText)}\n➖➖➖➖➖➖➖➖➖➖\n\n` +
    `⚠️ <b>سيتم إرسال هذه الرسالة فوراً لكل المستخدمين المسجلين.</b> هل أنت متأكد؟`;
  await telegram.sendMessage(chatId, preview, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ تأكيد الإرسال للجميع', callback_data: 'cmd_broadcast_confirm' }],
        [{ text: '❌ إلغاء', callback_data: 'cmd_broadcast_cancel' }],
      ],
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sends the confirmed broadcast synchronously within this request
// (Vercel maxDuration is already 300s — see vercel.json). For very large
// user bases this may not finish in one request; it stops with a partial
// report if it runs low on time rather than timing out mid-send.
async function runBroadcast(adminChatId, text) {
  const userIds = await users.getAllUserIds();
  if (userIds.length === 0) {
    await telegram.sendMessage(adminChatId, '⚠️ لا يوجد مستخدمين مسجلين للإرسال إليهم.');
    return;
  }

  const startTime = Date.now();
  const TIME_LIMIT_MS = 260 * 1000;
  let successCount = 0;
  let failCount = 0;
  let stoppedEarly = false;

  for (let i = 0; i < userIds.length; i++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      stoppedEarly = true;
      break;
    }
    const result = await telegram.sendMessage(userIds[i], text);
    if (result && result.ok) successCount++;
    else failCount++;
    await sleep(40); // ~25 msgs/sec, under Telegram's global rate limit
  }

  const summary =
    `🏁 <b>${stoppedEarly ? 'توقف البرودكاست مؤقتاً (انتهى الوقت المتاح للطلب)' : 'تم الانتهاء من البرودكاست'}</b>\n\n` +
    `✅ نجح: <code>${successCount}</code>\n` +
    `❌ فشل: <code>${failCount}</code>\n` +
    `📊 الإجمالي: <code>${userIds.length}</code>` +
    (stoppedEarly ? `\n\n⚠️ أعد تشغيل /broadcast لباقي المستخدمين لو محتاج.` : '');
  await telegram.sendMessage(adminChatId, summary, { parse_mode: 'HTML' });
}

async function handleRepairOn(chatId) {
  await botConfig.setMaintenanceMode(true);
  await telegram.sendMessage(chatId, '🛠️ <b>تم تفعيل وضع الصيانة.</b>\nكل المستخدمين (عدا الأدمن) لن يتمكنوا من استخدام البوت الآن.', {
    parse_mode: 'HTML',
  });
}

async function handleRepairOff(chatId) {
  await botConfig.setMaintenanceMode(false);
  await telegram.sendMessage(chatId, '✅ <b>تم إيقاف وضع الصيانة.</b>\nالبوت يعمل الآن بشكل طبيعي.', { parse_mode: 'HTML' });
}

async function handleBan(chatId, targetId) {
  if (!targetId || !/^\d+$/.test(targetId)) {
    await telegram.sendMessage(chatId, '⚠️ استخدم: <code>/ban USER_ID</code>', { parse_mode: 'HTML' });
    return;
  }
  if (isAdmin(targetId)) {
    await telegram.sendMessage(chatId, '⚠️ لا يمكنك حظر أدمن آخر.');
    return;
  }
  const banned = await botConfig.getBannedUsers();
  if (banned.includes(targetId)) {
    await telegram.sendMessage(chatId, `⚠️ المستخدم <code>${targetId}</code> محظور بالفعل.`, { parse_mode: 'HTML' });
    return;
  }
  banned.push(targetId);
  await botConfig.setBannedUsers(banned);
  await telegram.sendMessage(chatId, `✅ تم حظر المستخدم <code>${targetId}</code>.`, { parse_mode: 'HTML' });
}

async function handleUnban(chatId, targetId) {
  if (!targetId || !/^\d+$/.test(targetId)) {
    await telegram.sendMessage(chatId, '⚠️ استخدم: <code>/unban USER_ID</code>', { parse_mode: 'HTML' });
    return;
  }
  let banned = await botConfig.getBannedUsers();
  if (!banned.includes(targetId)) {
    await telegram.sendMessage(chatId, `⚠️ المستخدم <code>${targetId}</code> غير محظور أصلاً.`, { parse_mode: 'HTML' });
    return;
  }
  banned = banned.filter((id) => id !== targetId);
  await botConfig.setBannedUsers(banned);
  await telegram.sendMessage(chatId, `✅ تم رفع الحظر عن المستخدم <code>${targetId}</code>.`, { parse_mode: 'HTML' });
}

async function handleBanList(chatId) {
  const banned = await botConfig.getBannedUsers();
  if (banned.length === 0) {
    await telegram.sendMessage(chatId, '📭 لا يوجد أي مستخدم محظور حالياً.');
    return;
  }
  const list = banned.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n');
  await telegram.sendMessage(chatId, `🚫 <b>المستخدمون المحظورون (${banned.length}):</b>\n\n${list}`, { parse_mode: 'HTML' });
}

// =========================================================
// 🎨 PDF design access control — fully button-driven admin panel. For
// EACH registered PDF design (see lib/pdfDesigns.js) the admin can toggle
// it between "available to everyone" and "restricted to a group", and
// manage that group (add/remove by user id) — all via inline buttons.
// The only typing involved is pasting a USER_ID when adding someone to a
// group, exactly like the existing book-rename button flow (see
// tryHandleBookRenamePaste) — there's no way to pick an arbitrary
// Telegram user id from a button, so that one step stays text-based.
// See lib/pdfAccess.js for the underlying per-design storage.
// =========================================================

// Top-level screen: one button per registered design. Reached via
// /pdfaccess or the 'pda_back' callback.
async function buildPdfAccessOverview() {
  const designs = pdfDesigns.listDesigns();
  const buttons = designs.map((d) => [{ text: `🎨 ${d.label}`, callback_data: `pda_design_${d.id}` }]);
  return {
    text: `🎨 <b>صلاحيات تصاميم الـ PDF</b>\n\nاختار تصميم عشان تشوف/تغيّر وضعه:`,
    reply_markup: { inline_keyboard: buttons },
  };
}

async function handlePdfAccessPanel(chatId) {
  const { text, reply_markup } = await buildPdfAccessOverview();
  await telegram.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
}

async function handlePdfAccessBackButton(chatId, messageId) {
  const { text, reply_markup } = await buildPdfAccessOverview();
  await telegram.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup });
}

// Per-design menu: current mode + toggle + manage-group + back.
async function handlePdfDesignMenu(chatId, messageId, designId) {
  const design = pdfDesigns.DESIGNS[designId];
  if (!design) {
    await telegram.editMessageText(chatId, messageId, '❌ التصميم ده مش موجود.');
    return;
  }
  const mode = await pdfAccess.getAccessMode(designId);
  const ids = await pdfAccess.getWhitelist(designId);
  const modeLine =
    mode === 'all'
      ? '✅ متاح لكل المستخدمين حالياً.'
      : `🔒 مقيّد حالياً — متاح بس للأدمن + ${ids.length} مستخدم في مجموعته.`;
  const text = `🎨 <b>${design.label}</b>\n\n${modeLine}\n\nاختار إجراء:`;
  await telegram.editMessageText(chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: mode === 'all' ? '🔒 قيّد على مجموعة محددة' : '✅ إتاحة للكل',
            callback_data: `pda_togglemode_${designId}`,
          },
        ],
        [{ text: `👥 إدارة المجموعة (${ids.length})`, callback_data: `pda_managelist_${designId}` }],
        [{ text: '🔙 رجوع', callback_data: 'pda_back' }],
      ],
    },
  });
}

async function handlePdfToggleMode(chatId, messageId, designId) {
  const current = await pdfAccess.getAccessMode(designId);
  await pdfAccess.setAccessMode(designId, current === 'all' ? 'whitelist' : 'all');
  await handlePdfDesignMenu(chatId, messageId, designId);
}

// Whitelist management screen: every user in the group gets a ❌ button
// to remove them directly, plus an "add" button and a back button. The
// group is kept (and stays editable) even while mode is "all", so
// switching a design back to "restricted" later doesn't lose it.
async function handlePdfManageList(chatId, messageId, designId) {
  const design = pdfDesigns.DESIGNS[designId];
  if (!design) {
    await telegram.editMessageText(chatId, messageId, '❌ التصميم ده مش موجود.');
    return;
  }
  const ids = await pdfAccess.getWhitelist(designId);
  const listLine = ids.length > 0 ? '' : '\n\n📭 المجموعة فاضية حالياً.';
  const removeButtons = ids.map((id) => [{ text: `❌ ${id}`, callback_data: `pda_removeuser_${designId}_${id}` }]);
  await telegram.editMessageText(
    chatId,
    messageId,
    `👥 <b>مجموعة "${design.label}"</b>${listLine}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...removeButtons,
          [{ text: '➕ إضافة مستخدم', callback_data: `pda_adduser_${designId}` }],
          [{ text: '🔙 رجوع', callback_data: `pda_design_${designId}` }],
        ],
      },
    }
  );
}

async function handlePdfRemoveUser(chatId, messageId, designId, targetId) {
  await pdfAccess.removeFromWhitelist(designId, targetId);
  await handlePdfManageList(chatId, messageId, designId);
}

// Puts the admin into "waiting to type a USER_ID to add" mode for this
// design (button-driven equivalent of the old /pdfallow USER_ID).
async function handlePdfAddUserPrompt(chatId, messageId, adminId, designId) {
  const design = pdfDesigns.DESIGNS[designId];
  if (!design) {
    await telegram.editMessageText(chatId, messageId, '❌ التصميم ده مش موجود.');
    return;
  }
  await botConfig.setConfig(`pdfadduser_${adminId}`, { designId });
  await telegram.editMessageText(
    chatId,
    messageId,
    `➕ ابعت الآن USER_ID المستخدم اللي عايز تضيفه لمجموعة "${design.label}" كرسالة نصية.`,
    { reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: `pda_managelist_${designId}` }]] } }
  );
}

// Called when a plain-text message arrives while the admin is in
// "waiting to type a USER_ID to add" mode (set by handlePdfAddUserPrompt).
// Returns true if it handled the message.
async function tryHandlePdfAddUserPaste(chatId, adminId, text) {
  const state = await botConfig.getConfig(`pdfadduser_${adminId}`);
  if (!state || !state.designId) return false;

  await botConfig.deleteConfig(`pdfadduser_${adminId}`);
  const targetId = text.trim();
  const design = pdfDesigns.DESIGNS[state.designId];
  if (!design) {
    await telegram.sendMessage(chatId, '❌ التصميم ده مبقاش موجود.');
    return true;
  }
  if (!/^\d+$/.test(targetId)) {
    await telegram.sendMessage(chatId, '⚠️ ده مش USER_ID صحيح (لازم يكون رقم). اتلغت العملية، استخدم /pdfaccess تاني لو عايز تحاول.');
    return true;
  }
  await pdfAccess.addToWhitelist(state.designId, targetId);
  await telegram.sendMessage(chatId, `✅ المستخدم <code>${targetId}</code> بقى معاه إتاحة لتصميم "${design.label}".`, {
    parse_mode: 'HTML',
  });
  return true;
}

// =========================================================
// ⏳ Scheduled block periods (e.g. exam times)
// =========================================================
// Lets an admin schedule one or more time windows (Cairo local time) during
// which the bot stops responding to anyone except admins — same effect as
// maintenance mode, but on a schedule instead of a manual on/off switch.
// Multiple periods can be active/queued at once (e.g. one per exam).

function describeBlockedPeriod(p, nowMs) {
  const startMs = Date.parse(p.startAt);
  const endMs = Date.parse(p.endAt);
  const status = nowMs >= startMs && nowMs < endMs ? '🔴 شغالة دلوقتي' : nowMs >= endMs ? '⚪ انتهت' : '🟡 لسه ما بدأتش';
  const label = p.label ? `\nالسبب: ${escapeHtml(p.label)}` : '';
  return (
    `#${p.id} — ${status}\n` +
    `من ${cairoTime.formatUtcIsoAsCairo(p.startAt)} لحد ${cairoTime.formatUtcIsoAsCairo(p.endAt)} (بتوقيت القاهرة)` +
    label
  );
}

async function handleAddBlock(chatId, argsText) {
  const parts = argsText.split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await telegram.sendMessage(
      chatId,
      '⚠️ الصيغة غلط. استخدم:\n<code>/addblock 2026-06-01 08:00 AM | 2026-06-15 08:00 PM | امتحانات نصف العام</code>\n\n' +
        'الليبل (السبب) اختياري. الوقت المتوقع هو <b>توقيت القاهرة المحلي</b>، وممكن تكتبه بصيغة 12 ساعة زي <code>08:00 AM</code>/<code>08:00 PM</code> أو 24 ساعة زي <code>20:00</code>.\n\n' +
        'أو ببساطة ابعت <code>/addblock</code> من غير أي حاجة تانية وهيديك تقويم وأزرار تختار منها.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const [startRaw, endRaw, label] = parts;
  const startAt = cairoTime.parseCairoLocalToUtcIso(startRaw);
  const endAt = cairoTime.parseCairoLocalToUtcIso(endRaw);

  if (!startAt || !endAt) {
    await telegram.sendMessage(
      chatId,
      '⚠️ التاريخ/الوقت مش بالصيغة الصح. لازم يكون بالشكل ده: <code>2026-06-01 08:00 AM</code> أو <code>2026-06-01 20:00</code> (بتوقيت القاهرة).',
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    await telegram.sendMessage(chatId, '⚠️ وقت النهاية لازم يكون بعد وقت البداية.');
    return;
  }

  const id = await botConfig.addBlockedPeriod(startAt, endAt, label || null);
  const labelLine = label ? `\nالسبب: ${escapeHtml(label)}` : '';
  await telegram.sendMessage(
    chatId,
    `✅ اتضافت فترة إغلاق رقم <code>#${id}</code>:\n` +
      `من ${cairoTime.formatUtcIsoAsCairo(startAt)} لحد ${cairoTime.formatUtcIsoAsCairo(endAt)} (بتوقيت القاهرة)${labelLine}\n\n` +
      `في الفترة دي، البوت هيقف عن الرد لأي حد غير الأدمن.`,
    { parse_mode: 'HTML' }
  );
}

async function handleBlockList(chatId) {
  const periods = await botConfig.getBlockedPeriods();
  if (periods.length === 0) {
    await telegram.sendMessage(chatId, '📭 مفيش أي فترات إغلاق مجدولة حالياً.');
    return;
  }
  const nowMs = Date.now();
  const lines = [...periods]
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
    .map((p) => describeBlockedPeriod(p, nowMs));
  await telegram.sendMessage(chatId, `⏳ <b>فترات الإغلاق المجدولة (${periods.length}):</b>\n\n${lines.join('\n\n')}`, {
    parse_mode: 'HTML',
  });
}

async function handleRemoveBlock(chatId, idText) {
  const id = parseInt(idText, 10);
  if (Number.isNaN(id)) {
    await telegram.sendMessage(chatId, '⚠️ استخدم: <code>/removeblock ID</code> (شوف الأرقام عبر /blocklist).', {
      parse_mode: 'HTML',
    });
    return;
  }
  const removed = await botConfig.removeBlockedPeriod(id);
  await telegram.sendMessage(chatId, removed ? `✅ اتشالت فترة الإغلاق #${id}.` : `⚠️ مفيش فترة إغلاق بالرقم #${id}.`);
}

// Button-based alternative to typing /removeblock ID: lists every
// scheduled period with its status and a 🗑 button to delete it directly.
async function handleRemoveBlockPrompt(chatId) {
  const periods = await botConfig.getBlockedPeriods();
  if (periods.length === 0) {
    await telegram.sendMessage(chatId, '📭 مفيش أي فترات إغلاق مجدولة حالياً.');
    return;
  }
  const nowMs = Date.now();
  const sorted = [...periods].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const buttons = sorted.map((p) => {
    const startMs = Date.parse(p.startAt);
    const endMs = Date.parse(p.endAt);
    const status = nowMs >= startMs && nowMs < endMs ? '🔴' : nowMs >= endMs ? '⚪' : '🟡';
    const labelPart = p.label ? ` — ${p.label}` : '';
    const text = `🗑 #${p.id} ${status} ${cairoTime.formatUtcIsoAsCairo(p.startAt)}${labelPart}`;
    return [{ text: text.length > 64 ? `${text.slice(0, 61)}...` : text, callback_data: `blk_remove_${p.id}` }];
  });
  buttons.push([{ text: '❌ إلغاء', callback_data: 'blk_removeblock_cancel' }]);
  await telegram.sendMessage(chatId, '🗑 اختر فترة الإغلاق اللي عايز تشيلها:', {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleRemoveBlockConfirmed(chatId, messageId, id) {
  const removed = await botConfig.removeBlockedPeriod(id);
  await telegram.editMessageText(
    chatId,
    messageId,
    removed ? `✅ اتشالت فترة الإغلاق #${id}.` : `⚠️ مفيش فترة إغلاق بالرقم #${id}.`
  );
}

// =========================================================
// 📅 /addblock button-based picker
// =========================================================
// Walks the admin through picking start/end dates from an inline-keyboard
// calendar and a 12-hour AM/PM time picker, instead of typing the whole
// "/addblock yyyy-MM-dd HH:mm | ..." command by hand. State for the
// in-progress wizard is kept in bot_config per admin (same pattern as the
// /addkey paste buffer), so it survives across the separate webhook
// invocations that handle each button tap.

function addBlockStateKey(adminId) {
  return `addblockbuf_${adminId}`;
}

function buildCalendarButtons(side, year, month) {
  const daysInMonth = cairoTime.daysInCairoMonth(year, month);
  const startIdx = cairoTime.firstWeekdaySunIndex(year, month);
  const dayNames = ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س'];
  const rows = [dayNames.map((d) => ({ text: d, callback_data: 'blk_noop' }))];

  let row = [];
  for (let i = 0; i < startIdx; i++) row.push({ text: ' ', callback_data: 'blk_noop' });
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    row.push({ text: String(day), callback_data: `blk_date_${side}_${ds}` });
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push({ text: ' ', callback_data: 'blk_noop' });
    rows.push(row);
  }

  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  rows.push([
    { text: '« السابق', callback_data: `blk_navcal_${side}_${prev.y}-${prev.m}` },
    { text: `${cairoTime.arabicMonthName(month)} ${year}`, callback_data: 'blk_noop' },
    { text: 'التالي »', callback_data: `blk_navcal_${side}_${next.y}-${next.m}` },
  ]);
  rows.push([{ text: '❌ إلغاء', callback_data: 'blk_cancel' }]);
  return rows;
}

function buildHourButtons(side) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 1; c <= 4; c++) {
      const h = r * 4 + c;
      row.push({ text: String(h), callback_data: `blk_hour_${side}_${h}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '❌ إلغاء', callback_data: 'blk_cancel' }]);
  return rows;
}

function buildMinuteButtons(side) {
  const minutes = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];
  const rows = [];
  for (let i = 0; i < minutes.length; i += 4) {
    rows.push(minutes.slice(i, i + 4).map((m) => ({ text: `:${m}`, callback_data: `blk_min_${side}_${m}` })));
  }
  rows.push([{ text: '✏️ اكتب رقم تاني', callback_data: `blk_mincustom_${side}` }]);
  rows.push([{ text: '❌ إلغاء', callback_data: 'blk_cancel' }]);
  return rows;
}

function buildAmPmButtons(side) {
  return [
    [
      { text: '🌅 صباحاً AM', callback_data: `blk_ampm_${side}_AM` },
      { text: '🌙 مساءً PM', callback_data: `blk_ampm_${side}_PM` },
    ],
    [{ text: '❌ إلغاء', callback_data: 'blk_cancel' }],
  ];
}

async function handleAddBlockStart(chatId, adminId) {
  const { year, month } = cairoTime.nowCairoYearMonth();
  const state = { stage: 'start_date', calYear: year, calMonth: month };
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  await telegram.sendMessage(
    chatId,
    `⏳ <b>إضافة فترة إغلاق مجدولة</b>\n\nاختار تاريخ <b>بداية</b> الفترة (بتوقيت القاهرة):`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: buildCalendarButtons('start', year, month) } }
  );
}

async function handleAddBlockCalendarNav(chatId, messageId, adminId, side, year, month) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state) return;
  state.calYear = year;
  state.calMonth = month;
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  const label = side === 'start' ? 'بداية' : 'نهاية';
  await telegram.editMessageText(chatId, messageId, `⏳ اختار تاريخ <b>${label}</b> الفترة (بتوقيت القاهرة):`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildCalendarButtons(side, year, month) },
  });
}

async function handleAddBlockDatePicked(chatId, messageId, adminId, side, dateStr) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state) return;
  const [y, m, d] = dateStr.split('-').map(Number);
  state[`${side}Year`] = y;
  state[`${side}Month`] = m;
  state[`${side}Day`] = d;
  state.stage = `${side}_hour`;
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  const label = side === 'start' ? 'بداية' : 'نهاية';
  await telegram.editMessageText(chatId, messageId, `🕐 اختار <b>ساعة ${label}</b> الفترة:`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildHourButtons(side) },
  });
}

async function handleAddBlockHourPicked(chatId, messageId, adminId, side, hour) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state) return;
  state[`${side}Hour12`] = hour;
  state.stage = `${side}_minute`;
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  const label = side === 'start' ? 'بداية' : 'نهاية';
  await telegram.editMessageText(chatId, messageId, `🕐 اختار <b>دقيقة ${label}</b> الفترة:`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildMinuteButtons(side) },
  });
}

async function handleAddBlockMinutePicked(chatId, messageId, adminId, side, minute) {
  await advanceFromMinute(chatId, adminId, side, minute, { messageId });
}

// Switches the minute step from the :00/:05/.../:55 grid into "type any
// number 0-59" mode.
async function handleAddBlockMinuteCustomPrompt(chatId, messageId, adminId, side) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state) return;
  state.stage = `${side}_minute_custom`;
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  const label = side === 'start' ? 'بداية' : 'نهاية';
  await telegram.editMessageText(
    chatId,
    messageId,
    `✏️ اكتب رقم الدقيقة (من 0 لـ 59) لـ <b>${label}</b> الفترة كرسالة نصية:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'blk_cancel' }]] } }
  );
}

// Shared step after a minute value is known (from either the quick-pick
// grid or a typed number), advancing the wizard to the AM/PM step. Edits
// the existing picker message when messageId is given (button tap);
// otherwise sends a new message (typed-number path, which has no
// message of its own to edit).
async function advanceFromMinute(chatId, adminId, side, minute, { messageId = null } = {}) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state) return;
  state[`${side}Minute`] = minute;
  state.stage = `${side}_ampm`;
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  const label = side === 'start' ? 'بداية' : 'نهاية';
  const text = `🕐 صباحاً ولا مساءً — <b>${label}</b> الفترة؟`;
  const extra = { parse_mode: 'HTML', reply_markup: { inline_keyboard: buildAmPmButtons(side) } };
  if (messageId) {
    await telegram.editMessageText(chatId, messageId, text, extra);
  } else {
    await telegram.sendMessage(chatId, text, extra);
  }
}

// Called from the plain-text message handler while a /addblock wizard is
// waiting on a typed custom minute (0-59). Returns true if it handled the
// message.
async function tryHandleAddBlockMinutePaste(chatId, adminId, text) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state || !state.stage || !state.stage.endsWith('_minute_custom')) return false;
  const side = state.stage.replace('_minute_custom', '');
  const num = parseInt(text.trim(), 10);
  if (Number.isNaN(num) || num < 0 || num > 59) {
    await telegram.sendMessage(chatId, '⚠️ اكتب رقم صحيح من 0 لـ 59.');
    return true;
  }
  await advanceFromMinute(chatId, adminId, side, String(num).padStart(2, '0'));
  return true;
}

function buildConfirmSummary(state) {
  const labelLine = state.label ? `\nالسبب: ${escapeHtml(state.label)}` : '';
  return (
    `⏳ <b>تأكيد فترة الإغلاق</b>\n\n` +
    `من: <code>${cairoTime.formatUtcIsoAsCairo(state.startAt)}</code>\n` +
    `لحد: <code>${cairoTime.formatUtcIsoAsCairo(state.endAt)}</code> (بتوقيت القاهرة)${labelLine}\n\n` +
    `في الفترة دي، البوت هيقف عن الرد لأي حد غير الأدمن.`
  );
}

async function handleAddBlockAmPmPicked(chatId, messageId, adminId, side, ampm) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state) return;
  const hour12 = state[`${side}Hour12`];
  let hour24 = hour12 % 12;
  if (ampm === 'PM') hour24 += 12;
  const utcIso = cairoTime.cairoPartsToUtcIso(
    state[`${side}Year`],
    state[`${side}Month`],
    state[`${side}Day`],
    hour24,
    Number(state[`${side}Minute`])
  );
  state[`${side}At`] = utcIso;
  state[`${side}AmPm`] = ampm;

  if (side === 'start') {
    // Move on to picking the end date, defaulting the calendar view to
    // the same month the admin just picked the start date from.
    state.stage = 'end_date';
    state.calYear = state.startYear;
    state.calMonth = state.startMonth;
    await botConfig.setConfig(addBlockStateKey(adminId), state);
    await telegram.editMessageText(
      chatId,
      messageId,
      `✅ بداية الفترة: <code>${cairoTime.formatUtcIsoAsCairo(state.startAt)}</code>\n\nدلوقتي اختار تاريخ <b>نهاية</b> الفترة:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buildCalendarButtons('end', state.calYear, state.calMonth) } }
    );
    return;
  }

  // End time picked — validate ordering before moving to the label step.
  if (Date.parse(state.endAt) <= Date.parse(state.startAt)) {
    await botConfig.setConfig(addBlockStateKey(adminId), state);
    await telegram.editMessageText(
      chatId,
      messageId,
      `⚠️ وقت النهاية لازم يكون بعد وقت البداية (<code>${cairoTime.formatUtcIsoAsCairo(state.startAt)}</code>).\nاختار تاريخ نهاية تاني:`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buildCalendarButtons('end', state.endYear, state.endMonth) },
      }
    );
    return;
  }

  state.stage = 'label';
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  await telegram.editMessageText(
    chatId,
    messageId,
    `✅ بداية: <code>${cairoTime.formatUtcIsoAsCairo(state.startAt)}</code>\n` +
      `✅ نهاية: <code>${cairoTime.formatUtcIsoAsCairo(state.endAt)}</code>\n\n` +
      `📝 ابعت السبب/الليبل (اختياري) كرسالة نصية دلوقتي، أو دوس "تخطي".`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '⏭ تخطي', callback_data: 'blk_label_skip' }], [{ text: '❌ إلغاء', callback_data: 'blk_cancel' }]],
      },
    }
  );
}

async function handleAddBlockLabelSkip(chatId, messageId, adminId) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state) return;
  state.label = null;
  state.stage = 'confirm';
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  await telegram.editMessageText(chatId, messageId, buildConfirmSummary(state), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '✅ تأكيد', callback_data: 'blk_confirm' }, { text: '❌ إلغاء', callback_data: 'blk_cancel' }]],
    },
  });
}

// Called from the plain-text message handler while a /addblock wizard is
// waiting on the optional label. Returns true if it handled the message
// (so the caller doesn't also try to treat it as a book action or
// question batch).
async function tryHandleAddBlockLabelPaste(chatId, adminId, text) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state || state.stage !== 'label') return false;
  state.label = text.trim().slice(0, 200) || null;
  state.stage = 'confirm';
  await botConfig.setConfig(addBlockStateKey(adminId), state);
  await telegram.sendMessage(chatId, buildConfirmSummary(state), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '✅ تأكيد', callback_data: 'blk_confirm' }, { text: '❌ إلغاء', callback_data: 'blk_cancel' }]],
    },
  });
  return true;
}

async function handleAddBlockConfirm(chatId, messageId, adminId) {
  const state = await botConfig.getConfig(addBlockStateKey(adminId));
  if (!state || !state.startAt || !state.endAt) {
    await telegram.editMessageText(chatId, messageId, '⚠️ الجلسة انتهت، ابدأ تاني بـ /addblock.');
    return;
  }
  await botConfig.deleteConfig(addBlockStateKey(adminId));
  const id = await botConfig.addBlockedPeriod(state.startAt, state.endAt, state.label || null);
  const labelLine = state.label ? `\nالسبب: ${escapeHtml(state.label)}` : '';
  await telegram.editMessageText(
    chatId,
    messageId,
    `✅ اتضافت فترة إغلاق رقم <code>#${id}</code>:\n` +
      `من ${cairoTime.formatUtcIsoAsCairo(state.startAt)} لحد ${cairoTime.formatUtcIsoAsCairo(state.endAt)} (بتوقيت القاهرة)${labelLine}\n\n` +
      `في الفترة دي، البوت هيقف عن الرد لأي حد غير الأدمن.`,
    { parse_mode: 'HTML' }
  );
}

async function handleAddBlockCancel(chatId, messageId, adminId) {
  await botConfig.deleteConfig(addBlockStateKey(adminId));
  await telegram.editMessageText(chatId, messageId, '❌ اتلغت إضافة فترة الإغلاق.');
}

// =========================================================
// 🔑 User API keys / BYOK (ported from the admin bot)
// =========================================================

async function handleAddKeyStart(chatId, userId) {
  await botConfig.setConfig(`addkeybuf_${userId}`, { active: true });
  const instructions =
    `🔑 <b>أضف مفتاح Gemini API الخاص بك (مجاني)</b>\n\n` +
    `مفتاحك الخاص هيتضاف لمجموعة مفاتيح البوت *لطلباتك أنت فقط*، وهيديك أولوية إضافية في الحصة اليومية ` +
    `(محتاج ${MIN_USER_KEYS_FOR_BOOST} مفاتيح على الأقل عشان يتفعّل الدعم الإضافي، وكل مفتاح بيديك تقريباً ${APPROX_ANALYSES_PER_KEY} طلب إضافي يومياً).\n\n` +
    `<b>خطوات الحصول على المفتاح:</b>\n` +
    `1️⃣ افتح: https://aistudio.google.com/apikey\n` +
    `2️⃣ سجّل الدخول بحساب Google.\n` +
    `3️⃣ اضغط "Create API key".\n` +
    `4️⃣ اختر "Create API key in new project" (أو مشروع موجود).\n` +
    `5️⃣ انسخ المفتاح.\n` +
    `6️⃣ الصقه هنا كرسالة نصية.\n\n` +
    `⚠️ المفتاح مجاني بالكامل ضمن حصة Google المجانية. لا تشاركه مع أي حد. هنتحقق من صلاحيته فعلياً قبل حفظه.\n\n` +
    `📩 الآن الصق مفتاحك هنا:`;
  await telegram.sendMessage(chatId, instructions, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cmd_addkey_cancel' }]] },
  });
}

async function handleMyKeys(chatId, userId) {
  const keys = await userApiKeys.getUserApiKeysList(userId);
  if (keys.length === 0) {
    await telegram.sendMessage(
      chatId,
      `📭 لا تملك أي مفاتيح API مضافة حالياً.\nاستخدم /addkey لإضافة مفتاحك الخاص (مجاني).`
    );
    return;
  }
  const list = keys
    .map((k, i) => `${i + 1}. \`${userApiKeys.maskApiKey(k.api_key)}\` — ${new Date(k.added_at).toLocaleDateString('ar-EG')}`)
    .join('\n');
  const boostStatus =
    keys.length >= MIN_USER_KEYS_FOR_BOOST
      ? `✅ مفعّل لديك الدعم الإضافي في الحصة اليومية (${keys.length}/${MIN_USER_KEYS_FOR_BOOST}).`
      : `⚠️ تحتاج ${MIN_USER_KEYS_FOR_BOOST - keys.length} مفتاح إضافي على الأقل لتفعيل الدعم الإضافي (${keys.length}/${MIN_USER_KEYS_FOR_BOOST}).`;
  await telegram.sendMessage(
    chatId,
    `🔑 *مفاتيحك المضافة (${keys.length}):*\n\n${list}\n\n${boostStatus}\n\n➕ /addkey لإضافة مفتاح جديد\n🗑 /removekey لحذف مفتاح`
  );
}

async function handleRemoveKeyPrompt(chatId, userId) {
  const keys = await userApiKeys.getUserApiKeysList(userId);
  if (keys.length === 0) {
    await telegram.sendMessage(chatId, '📭 لا تملك أي مفاتيح لحذفها.');
    return;
  }
  const buttons = keys.map((k) => [{ text: `🗑 ${userApiKeys.maskApiKey(k.api_key)}`, callback_data: `cmd_removekey_${k.id}` }]);
  buttons.push([{ text: '❌ إلغاء', callback_data: 'cmd_removekey_cancel' }]);
  await telegram.sendMessage(chatId, '🗑 اختر المفتاح الذي تريد حذفه:', { reply_markup: { inline_keyboard: buttons } });
}

// Called when a plain-text message arrives while the user is in
// "waiting to paste a key" mode (set by /addkey). Returns true if it
// handled the message (so the caller shouldn't also treat it as a
// question).
async function tryHandleAddKeyPaste(chatId, userId, text) {
  const state = await botConfig.getConfig(`addkeybuf_${userId}`);
  if (!state || !state.active) return false;

  const candidateKey = text.trim();
  await botConfig.deleteConfig(`addkeybuf_${userId}`);

  const waitMsg = await telegram.sendMessage(chatId, '⏳ جاري التحقق من المفتاح...');
  const waitMsgId = waitMsg?.result?.message_id;

  const existingKeys = await userApiKeys.getUserApiKeysList(userId);
  if (existingKeys.some((k) => k.api_key === candidateKey)) {
    await telegram.editMessageText(chatId, waitMsgId, '⚠️ هذا المفتاح مضاف بالفعل ضمن مفاتيحك.');
    return true;
  }

  const validation = await userApiKeys.validateGeminiApiKey(candidateKey);
  if (!validation.valid) {
    await telegram.editMessageText(
      chatId,
      waitMsgId,
      `❌ *المفتاح غير صالح.*\nالسبب: \`${validation.reason || 'unknown'}\`\n\nتأكد من نسخ المفتاح كاملاً من aistudio.google.com/apikey، ثم أعد المحاولة عبر /addkey.`
    );
    return true;
  }

  const saved = await userApiKeys.addUserApiKeyToDb(userId, candidateKey);
  if (!saved) {
    await telegram.editMessageText(chatId, waitMsgId, '❌ حدث خطأ أثناء حفظ المفتاح. حاول لاحقاً.');
    return true;
  }

  const newCount = existingKeys.length + 1;
  const boostNote =
    newCount >= MIN_USER_KEYS_FOR_BOOST
      ? `\n\n🚀 الدعم الإضافي في الحصة اليومية أصبح مفعّلاً لك الآن (${newCount}/${MIN_USER_KEYS_FOR_BOOST}).`
      : `\n\n⚠️ تحتاج ${MIN_USER_KEYS_FOR_BOOST - newCount} مفتاح إضافي على الأقل لتفعيل الدعم الإضافي (${newCount}/${MIN_USER_KEYS_FOR_BOOST}).`;
  await telegram.editMessageText(
    chatId,
    waitMsgId,
    `✅ *تم إضافة مفتاحك بنجاح!* (\`${userApiKeys.maskApiKey(candidateKey)}\`)\nلديك الآن ${newCount} مفتاح.${boostNote}`
  );
  return true;
}

// =========================================================
// 🔀 Callback query (inline button) router
// =========================================================

async function handleCallbackQuery(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const userId = cb.from.id;
  const data = cb.data;

  if (data === 'cmd_addkey_cancel') {
    await botConfig.deleteConfig(`addkeybuf_${userId}`);
    await telegram.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
    await telegram.editMessageText(chatId, messageId, '❌ تم إلغاء إضافة المفتاح.');
    return;
  }

  // ⏳ /addblock button-based date & AM/PM time picker — admin-only.
  if (data.startsWith('blk_')) {
    if (!isAdmin(userId)) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }

    if (data === 'blk_removeblock_cancel') {
      await telegram.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
      await telegram.editMessageText(chatId, messageId, '❌ تم الإلغاء.');
      return;
    }

    if (data.startsWith('blk_remove_')) {
      const id = parseInt(data.replace('blk_remove_', ''), 10);
      await telegram.answerCallbackQuery(cb.id, { text: '✅ تم الحذف.' });
      await handleRemoveBlockConfirmed(chatId, messageId, id);
      return;
    }

    if (data === 'blk_noop') {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }

    if (data === 'blk_cancel') {
      await telegram.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
      await handleAddBlockCancel(chatId, messageId, userId);
      return;
    }

    if (data.startsWith('blk_navcal_')) {
      const rest = data.replace('blk_navcal_', ''); // "<side>_<year>-<month>"
      const [side, ym] = rest.split('_');
      const [year, month] = ym.split('-').map(Number);
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBlockCalendarNav(chatId, messageId, userId, side, year, month);
      return;
    }

    if (data.startsWith('blk_date_')) {
      const rest = data.replace('blk_date_', ''); // "<side>_<yyyy-MM-dd>"
      const [side, dateStr] = [rest.split('_')[0], rest.slice(rest.indexOf('_') + 1)];
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBlockDatePicked(chatId, messageId, userId, side, dateStr);
      return;
    }

    if (data.startsWith('blk_hour_')) {
      const rest = data.replace('blk_hour_', ''); // "<side>_<h>"
      const [side, hour] = rest.split('_');
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBlockHourPicked(chatId, messageId, userId, side, Number(hour));
      return;
    }

    if (data.startsWith('blk_mincustom_')) {
      const side = data.replace('blk_mincustom_', '');
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBlockMinuteCustomPrompt(chatId, messageId, userId, side);
      return;
    }

    if (data.startsWith('blk_min_')) {
      const rest = data.replace('blk_min_', ''); // "<side>_<mm>"
      const [side, minute] = rest.split('_');
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBlockMinutePicked(chatId, messageId, userId, side, minute);
      return;
    }

    if (data.startsWith('blk_ampm_')) {
      const rest = data.replace('blk_ampm_', ''); // "<side>_AM|PM"
      const [side, ampm] = rest.split('_');
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBlockAmPmPicked(chatId, messageId, userId, side, ampm);
      return;
    }

    if (data === 'blk_label_skip') {
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBlockLabelSkip(chatId, messageId, userId);
      return;
    }

    if (data === 'blk_confirm') {
      await telegram.answerCallbackQuery(cb.id, { text: '✅ تم الحفظ.' });
      await handleAddBlockConfirm(chatId, messageId, userId);
      return;
    }

    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (data === 'cmd_removekey_cancel') {
    await telegram.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
    await telegram.editMessageText(chatId, messageId, '❌ تم الإلغاء.');
    return;
  }

  if (data.startsWith('cmd_removekey_')) {
    const keyId = data.replace('cmd_removekey_', '');
    const removed = await userApiKeys.removeUserApiKeyFromDb(keyId, userId);
    if (removed) {
      await telegram.answerCallbackQuery(cb.id, { text: '✅ تم الحذف.' });
      await telegram.editMessageText(chatId, messageId, '✅ تم حذف المفتاح بنجاح.');
    } else {
      await telegram.answerCallbackQuery(cb.id, { text: '❌ فشل الحذف.', show_alert: true });
    }
    return;
  }

  // 📚 Admin book management buttons (all admin-only; silently ack for
  // anyone else since these callback_data values only ever get sent to
  // admins in the first place).
  if (data.startsWith('cmd_book') || data === 'cmd_addbooknew' || data === 'cmd_booksback') {
    if (!isAdmin(userId)) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }

    if (data === 'cmd_booksback') {
      await telegram.answerCallbackQuery(cb.id);
      await handleBooksBackButton(chatId, messageId);
      return;
    }
    if (data === 'cmd_addbooknew') {
      await telegram.answerCallbackQuery(cb.id);
      await handleAddBookNewPrompt(chatId, messageId, userId);
      return;
    }
    if (data.startsWith('cmd_bookmenu_')) {
      const bookId = Number(data.replace('cmd_bookmenu_', ''));
      await telegram.answerCallbackQuery(cb.id);
      await handleBookMenuButton(chatId, messageId, bookId);
      return;
    }
    if (data.startsWith('cmd_bookrename_')) {
      const bookId = Number(data.replace('cmd_bookrename_', ''));
      await telegram.answerCallbackQuery(cb.id);
      await handleBookRenameStart(chatId, messageId, userId, bookId);
      return;
    }
    if (data.startsWith('cmd_bookdeleteconfirm_')) {
      const bookId = Number(data.replace('cmd_bookdeleteconfirm_', ''));
      await telegram.answerCallbackQuery(cb.id, { text: '✅ تم الحذف.' });
      await handleBookDeleteConfirmed(chatId, messageId, bookId);
      return;
    }
    if (data.startsWith('cmd_bookdelete_')) {
      const bookId = Number(data.replace('cmd_bookdelete_', ''));
      await telegram.answerCallbackQuery(cb.id);
      await handleBookDeleteConfirmPrompt(chatId, messageId, bookId);
      return;
    }
  }

  // 📝📄 Per-batch format choice — data is "ansfmt_<format>_<token>".
  // token ties this button press back to the specific batch that was
  // staged when the buttons were shown (see pendingBatches.stageBatch),
  // so an old prompt from an earlier batch can't accidentally get
  // actioned against a newer one, and a batch can only be answered once.
  // 'text' answers immediately (consuming the batch); 'pdf'/'both' go on
  // to a color-picker step instead (see ansclr_ below) — the batch stays
  // staged (via pendingBatches.updateBatch, not takeBatch) until then.
  if (data.startsWith('ansfmt_')) {
    const rest = data.slice('ansfmt_'.length);
    const sepIdx = rest.indexOf('_');
    const format = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
    const token = sepIdx === -1 ? '' : rest.slice(sepIdx + 1);

    if (!VALID_ANSWER_FORMATS.includes(format)) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }

    if (format === 'pdf' || format === 'both') {
      const accessible = await pdfAccess.getAccessibleDesigns(userId, isAdmin);
      if (accessible.length === 0) {
        await telegram.answerCallbackQuery(cb.id, {
          text: '⚠️ صيغة الـ PDF مش متاحة لحسابك حالياً.',
          show_alert: true,
        });
        return;
      }

      const updated = await pendingBatches.updateBatch(userId, token, { format });
      if (!updated) {
        await telegram.answerCallbackQuery(cb.id, {
          text: '⚠️ الطلب ده قديم أو اتلغى. ابعت الأسئلة تاني.',
          show_alert: true,
        });
        return;
      }

      await telegram.answerCallbackQuery(cb.id, { text: `✅ ${FORMAT_LABELS[format]}` });
      await telegram.editMessageText(chatId, messageId, `🖼️ اختار تصميم ملف الـ PDF:`, {
        reply_markup: buildDesignKeyboard(token, accessible),
      });
      return;
    }

    // format === 'text' — answer right away, no design/color needed.
    const pending = await pendingBatches.takeBatch(userId, token);
    if (!pending) {
      await telegram.answerCallbackQuery(cb.id, {
        text: '⚠️ الطلب ده قديم أو اتلغى. ابعت الأسئلة تاني.',
        show_alert: true,
      });
      return;
    }

    const book = await books.getBook(pending.bookId);
    if (!book || book.status !== 'ready') {
      await telegram.answerCallbackQuery(cb.id, {
        text: '⚠️ الكتاب ده مبقاش متاح. ابعت الأسئلة تاني.',
        show_alert: true,
      });
      await telegram.editMessageText(chatId, messageId, '⚠️ الكتاب ده مبقاش متاح. ابعت الأسئلة تاني.');
      return;
    }

    await telegram.answerCallbackQuery(cb.id, { text: `✅ ${FORMAT_LABELS[format]}` });
    await telegram.editMessageText(chatId, messageId, `⏳ تمام، جاري تجهيز الإجابة بصيغة: ${FORMAT_LABELS[format]}...`);
    await processBatchWithFormat(chatId, pending.questions, book, cb.from, format);
    return;
  }

  // 🖼️ Per-batch PDF design choice — data is "ansdsg_<designId>_<token>".
  // Shown right after ansfmt_ picked pdf/both (see buildDesignKeyboard
  // above). Stores the chosen design on the still-staged batch (same
  // "stage now, ask later" pattern the format step uses) and moves on to
  // the color step. Access is re-checked here too, in case it was
  // revoked between the buttons being shown and tapped.
  if (data.startsWith('ansdsg_')) {
    // Registered design ids (e.g. "design_1") contain an underscore
    // themselves, so a naive "split on the first underscore" (which works
    // fine for ansfmt_/ansclr_, whose values never contain one) would cut
    // "design_1_<token>" into designId="design" + token="1_<token>" — an
    // invalid id, so the button did nothing. Match against the known
    // design ids instead of guessing where the id ends.
    const rest = data.slice('ansdsg_'.length);
    const matchedDesign = pdfDesigns
      .listDesigns()
      .find((d) => rest === d.id || rest.startsWith(`${d.id}_`));
    const designId = matchedDesign ? matchedDesign.id : null;
    const token = matchedDesign ? rest.slice(matchedDesign.id.length + 1) : '';

    if (!designId) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }

    const accessibleForDesign = await pdfAccess.getAccessibleDesigns(userId, isAdmin);
    if (!accessibleForDesign.some((d) => d.id === designId)) {
      await telegram.answerCallbackQuery(cb.id, {
        text: '⚠️ التصميم ده مش متاح لحسابك حالياً.',
        show_alert: true,
      });
      return;
    }

    const updatedWithDesign = await pendingBatches.updateBatch(userId, token, { designId });
    if (!updatedWithDesign) {
      await telegram.answerCallbackQuery(cb.id, {
        text: '⚠️ الطلب ده قديم أو اتلغى. ابعت الأسئلة تاني.',
        show_alert: true,
      });
      return;
    }

    const chosenDesign = pdfDesigns.DESIGNS[designId];
    await telegram.answerCallbackQuery(cb.id, { text: `✅ ${chosenDesign.label}` });
    await telegram.editMessageText(chatId, messageId, `🎨 اختار لون ملف الـ PDF:`, {
      reply_markup: buildColorKeyboard(token),
    });
    return;
  }

  // 🎨 Per-batch PDF color choice — data is "ansclr_<colorKey>_<token>".
  // Final step after ansdsg_ picked a design: uses the designId staged on
  // the batch by that step, consumes the batch, and answers. Nothing here
  // is persisted — the next batch asks again from scratch.
  if (data.startsWith('ansclr_')) {
    const rest = data.slice('ansclr_'.length);
    const sepIdx = rest.indexOf('_');
    const colorKey = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
    const token = sepIdx === -1 ? '' : rest.slice(sepIdx + 1);

    if (!pdfColors.isValidPdfColor(colorKey)) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }

    const pending = await pendingBatches.takeBatch(userId, token);
    if (!pending || !pending.format || !pending.designId) {
      await telegram.answerCallbackQuery(cb.id, {
        text: '⚠️ الطلب ده قديم أو اتلغى. ابعت الأسئلة تاني.',
        show_alert: true,
      });
      return;
    }

    // Re-check design access in case it was revoked between the design
    // button being tapped and the color button being tapped.
    const accessibleAtColorStep = await pdfAccess.getAccessibleDesigns(userId, isAdmin);
    if (!accessibleAtColorStep.some((d) => d.id === pending.designId)) {
      await telegram.answerCallbackQuery(cb.id, {
        text: '⚠️ صيغة الـ PDF مش متاحة لحسابك حالياً.',
        show_alert: true,
      });
      return;
    }
    const designId = pending.designId;

    const book = await books.getBook(pending.bookId);
    if (!book || book.status !== 'ready') {
      await telegram.answerCallbackQuery(cb.id, {
        text: '⚠️ الكتاب ده مبقاش متاح. ابعت الأسئلة تاني.',
        show_alert: true,
      });
      await telegram.editMessageText(chatId, messageId, '⚠️ الكتاب ده مبقاش متاح. ابعت الأسئلة تاني.');
      return;
    }

    const preset = pdfColors.PDF_COLOR_PRESETS[colorKey];
    await telegram.answerCallbackQuery(cb.id, { text: `✅ ${preset.emoji} ${preset.label}` });
    await telegram.editMessageText(
      chatId,
      messageId,
      `⏳ تمام، جاري تجهيز الإجابة بصيغة: ${FORMAT_LABELS[pending.format]} (${preset.emoji} ${preset.label})...`
    );
    await processBatchWithFormat(chatId, pending.questions, book, cb.from, pending.format, designId, colorKey);
    return;
  }

  if (data.startsWith('cmd_selectbook_')) {
    const bookId = Number(data.replace('cmd_selectbook_', ''));
    const book = await books.getBook(bookId);
    if (!book || book.status !== 'ready') {
      await telegram.answerCallbackQuery(cb.id, { text: '❌ الكتاب ده مش متاح دلوقت.', show_alert: true });
      return;
    }
    await users.setSelectedBookId(userId, bookId);
    await telegram.answerCallbackQuery(cb.id, { text: `✅ تم اختيار "${book.name}".` });
    await telegram.editMessageText(chatId, messageId, `📖 هتدور دلوقت في: *${book.name}*\n\nممكن تغيّره في أي وقت عبر /mybook.`);
    return;
  }

  // 🎨 Admin PDF-design-access panel — all data starts with "pda_"
  // (admin-only; silently ack for anyone else, same as the book-management
  // buttons above, since these callback_data values only ever get sent to
  // admins in the first place).
  if (data.startsWith('pda_')) {
    if (!isAdmin(userId)) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }

    if (data === 'pda_back') {
      await telegram.answerCallbackQuery(cb.id);
      await handlePdfAccessBackButton(chatId, messageId);
      return;
    }
    if (data.startsWith('pda_design_')) {
      const designId = data.replace('pda_design_', '');
      await telegram.answerCallbackQuery(cb.id);
      await handlePdfDesignMenu(chatId, messageId, designId);
      return;
    }
    if (data.startsWith('pda_togglemode_')) {
      const designId = data.replace('pda_togglemode_', '');
      await telegram.answerCallbackQuery(cb.id, { text: '✅ تم التحديث.' });
      await handlePdfToggleMode(chatId, messageId, designId);
      return;
    }
    if (data.startsWith('pda_managelist_')) {
      const designId = data.replace('pda_managelist_', '');
      await telegram.answerCallbackQuery(cb.id);
      await handlePdfManageList(chatId, messageId, designId);
      return;
    }
    if (data.startsWith('pda_removeuser_')) {
      const rest = data.replace('pda_removeuser_', ''); // "<designId>_<userId>"
      const sepIdx = rest.lastIndexOf('_');
      const designId = rest.slice(0, sepIdx);
      const targetId = rest.slice(sepIdx + 1);
      await telegram.answerCallbackQuery(cb.id, { text: '✅ تم الحذف.' });
      await handlePdfRemoveUser(chatId, messageId, designId, targetId);
      return;
    }
    if (data.startsWith('pda_adduser_')) {
      const designId = data.replace('pda_adduser_', '');
      await telegram.answerCallbackQuery(cb.id);
      await handlePdfAddUserPrompt(chatId, messageId, userId, designId);
      return;
    }

    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (data === 'cmd_broadcast_confirm') {
    if (!isAdmin(userId)) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }
    const pending = await botConfig.getConfig(`broadcast_pending_${userId}`);
    if (!pending || !pending.text) {
      await telegram.answerCallbackQuery(cb.id, { text: '⚠️ لا توجد رسالة برودكاست معلقة.', show_alert: true });
      return;
    }
    await botConfig.deleteConfig(`broadcast_pending_${userId}`);
    await telegram.answerCallbackQuery(cb.id, { text: '🚀 جاري بدء الإرسال...' });
    await telegram.editMessageText(chatId, messageId, '🚀 تم بدء إرسال البرودكاست لكل المستخدمين...\nسيصلك تقرير بالنتيجة عند الانتهاء.');
    await runBroadcast(chatId, pending.text);
    return;
  }

  if (data === 'cmd_broadcast_cancel') {
    if (!isAdmin(userId)) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }
    await botConfig.deleteConfig(`broadcast_pending_${userId}`);
    await telegram.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
    await telegram.editMessageText(chatId, messageId, '❌ تم إلغاء عملية البرودكاست.');
    return;
  }

  // Unknown callback — just ack it so Telegram stops showing a spinner.
  await telegram.answerCallbackQuery(cb.id);
}

// =========================================================
// 👮 Admin command dispatch. Returns true if `text` was an admin
// command and was handled (so the caller doesn't fall through to the
// normal question-answering flow).
// =========================================================
async function tryHandleAdminCommand(chatId, adminId, text) {
  if (text === '/adminhelp' || text === '/cmds') {
    await handleAdminHelp(chatId);
    return true;
  }
  if (text === '/stats') {
    await handleStats(chatId);
    return true;
  }
  if (text.startsWith('/user ')) {
    await handleUserReport(chatId, text.split(' ')[1]);
    return true;
  }
  if (text === '/books') {
    await handleBooksList(chatId);
    return true;
  }
  if (text.startsWith('/setwelcome ')) {
    await handleSetWelcome(chatId, text.replace('/setwelcome ', '').trim());
    return true;
  }
  if (text.startsWith('/setalert ')) {
    await handleSetAlert(chatId, text.replace('/setalert ', '').trim());
    return true;
  }
  if (text.startsWith('/broadcast ')) {
    await handleBroadcastPreview(chatId, adminId, text.replace('/broadcast ', '').trim());
    return true;
  }
  if (text === '/repairon') {
    await handleRepairOn(chatId);
    return true;
  }
  if (text === '/repairoff') {
    await handleRepairOff(chatId);
    return true;
  }
  if (text.startsWith('/ban ')) {
    await handleBan(chatId, text.replace('/ban ', '').trim());
    return true;
  }
  if (text.startsWith('/unban ')) {
    await handleUnban(chatId, text.replace('/unban ', '').trim());
    return true;
  }
  if (text === '/banlist') {
    await handleBanList(chatId);
    return true;
  }
  if (text === '/pdfaccess' || text.startsWith('/pdfaccess ')) {
    // Everything used to be a typed sub-command (/pdfaccess all,
    // /pdfallow USER_ID, ...) — now it's all buttons, so /pdfaccess just
    // opens the panel regardless of any trailing text.
    await handlePdfAccessPanel(chatId);
    return true;
  }
  if (text.startsWith('/addblock ')) {
    await handleAddBlock(chatId, text.replace('/addblock ', '').trim());
    return true;
  }
  if (text === '/addblock') {
    await handleAddBlockStart(chatId, adminId);
    return true;
  }
  if (text === '/blocklist') {
    await handleBlockList(chatId);
    return true;
  }
  if (text.startsWith('/removeblock ')) {
    await handleRemoveBlock(chatId, text.replace('/removeblock ', '').trim());
    return true;
  }
  if (text === '/removeblock') {
    await handleRemoveBlockPrompt(chatId);
    return true;
  }
  return false;
}

// =========================================================
// Main webhook handler
// =========================================================

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const update = req.body;

    // 🔁 Dedup: Telegram resends an update if it doesn't get a fast
    // response. Answering a big batch of questions can take a while, so
    // without this, a resend would kick off a second parallel search for
    // the same request. update_id is unique per update from Telegram, so
    // an atomic insert into telegram_updates tells us definitively
    // whether we've already started handling this one.
    if (await telegramUpdates.isDuplicateUpdate(update.update_id)) {
      res.status(200).json({ ok: true });
      return;
    }
    // Occasional best-effort cleanup of old dedup rows (not required for
    // correctness — just keeps the table small). Fire-and-forget, low
    // probability so it doesn't add latency to most requests.
    if (Math.random() < 0.01) {
      telegramUpdates.pruneOldUpdates().catch(() => {});
    }

    const message = update.message;
    const cb = update.callback_query;

    if (!message && !cb) {
      res.status(200).json({ ok: true });
      return;
    }

    const fromUser = message ? message.from : cb.from;
    const chatId = message ? message.chat.id : cb.message.chat.id;
    const admin = isAdmin(chatId);

    // Track the user (for /stats, /user, /broadcast) on every interaction,
    // and notify admins the first time we ever see this user.
    if (fromUser) {
      const isNewUser = await users.upsertUserAndCheckNew(fromUser);
      if (isNewUser && !admin) {
        const label = `${escapeHtml(fromUser.first_name || '')}${fromUser.username ? ' (@' + escapeHtml(fromUser.username) + ')' : ''} — <code>${fromUser.id}</code>`;
        const totalUsers = await users.getTotalUserCount();
        const totalLine = totalUsers !== null ? `\n👥 إجمالي المستخدمين الآن: <code>${totalUsers}</code>` : '';
        await notifyAdmins(`🆕 <b>مستخدم جديد:</b>\n${label}${totalLine}`, { parse_mode: 'HTML' });
      }
    }

    // 🚫 Ban check — applies to everyone except admins, before anything else.
    if (!admin && fromUser) {
      const banned = await botConfig.isUserBanned(fromUser.id);
      if (banned) {
        if (message) await telegram.sendMessage(chatId, '🚫 تم حظرك من استخدام هذا البوت.');
        else await telegram.answerCallbackQuery(cb.id, { text: '🚫 أنت محظور من استخدام البوت.', show_alert: true });
        res.status(200).json({ ok: true });
        return;
      }
    }

    // 🚧 Maintenance check — applies to everyone except admins.
    if (!admin) {
      const maintenanceOn = await botConfig.getMaintenanceMode();
      if (maintenanceOn) {
        if (message) await telegram.sendMessage(chatId, '⚠️ عذراً، البوت في وضع الصيانة حالياً. سنعود للعمل قريباً.');
        else await telegram.answerCallbackQuery(cb.id, { text: '⚠️ الصيانة مفعلة.', show_alert: true });
        res.status(200).json({ ok: true });
        return;
      }
    }

    // ⏳ Scheduled block periods (e.g. exam times) — applies to everyone
    // except admins. Checked against real wall-clock Cairo time, so it
    // stays correct whether the current date falls in DST (summer, UTC+3)
    // or standard time (winter, UTC+2) — see lib/cairoTime.js.
    if (!admin) {
      const activePeriod = await botConfig.getActiveBlockedPeriod();
      if (activePeriod) {
        const label = activePeriod.label ? ` (${activePeriod.label})` : '';
        const untilText = cairoTime.formatUtcIsoAsCairo(activePeriod.endAt);
        const blockedMsg = `⏳ البوت متوقف مؤقتاً حالياً${label}.\nهيرجع يشتغل تاني الساعة ${untilText} (بتوقيت القاهرة).`;
        if (message) await telegram.sendMessage(chatId, blockedMsg);
        else await telegram.answerCallbackQuery(cb.id, { text: '⏳ البوت متوقف مؤقتاً حالياً.', show_alert: true });
        res.status(200).json({ ok: true });
        return;
      }
    }

    // 🔀 Callback queries (inline buttons)
    if (cb) {
      await handleCallbackQuery(cb);
      res.status(200).json({ ok: true });
      return;
    }

    // 👮 Admin-only commands
    if (admin && message.text) {
      const handled = await tryHandleAdminCommand(chatId, chatId, message.text.trim());
      if (handled) {
        res.status(200).json({ ok: true });
        return;
      }
    }

    if (message.document) {
      const fileName = message.document.file_name || '';
      const isPdf = fileName.toLowerCase().endsWith('.pdf');
      const isText = fileName.toLowerCase().endsWith('.txt');

      if (admin && isPdf) {
        // Admin sending a PDF = add a new book (existing books untouched).
        await handleBookUpload(chatId, chatId, message.document.file_id, fileName, message.caption);
      } else if (isPdf || isText) {
        // Anyone else sending a document = a batch of questions.
        const buffer = await telegram.downloadFileBuffer(message.document.file_id);
        const questions = isPdf
          ? await extractQuestionsFromPdfBuffer(buffer)
          : await extractQuestionsFromPlainTextBuffer(buffer);
        await handleQuestionsBatch(chatId, questions, fromUser);
      } else {
        await telegram.sendMessage(chatId, '⚠️ الصيغة دي مش مدعومة، ابعت PDF أو TXT.');
      }
    } else if (message.text) {
      const text = message.text.trim();

      if (text.startsWith('/start')) {
        const welcomeCfg = await botConfig.getConfig('welcome_msg');
        const welcomeText =
          welcomeCfg?.text ||
          `مرحباً بك ${fromUser.first_name}! 👋\n\n` +
            `ابعتلي سؤال أو أكتر (سؤال في كل سطر)، أو ملف PDF/TXT فيه أسئلة، وهدور عليهم في الكتاب.\n\n` +
            `📚 لو فيه أكتر من كتاب متاح، اختار اللي عايزه عبر /mybook.\n\n` +
            `📝📄🎨 كل ما تبعت سؤال أو أسئلة، هسألك عايز تستلم الإجابة إزاي: نص، ملف PDF منسّق، أو الاثنين — ولو اخترت PDF هسألك كمان تعايز أي لون ليه، في كل مرة.\n\n` +
            `🔑 عايز أولوية إضافية في حصة الاستخدام اليومية؟ أضف مفتاح Gemini API الخاص بك (مجاني) عبر /addkey.`;
        await telegram.sendMessage(chatId, welcomeText);
        await users.checkAndSendAlert(chatId, fromUser, telegram.sendMessage);
      } else if ((text === '/status' || text === '/books') && admin) {
        await handleStatusCommand(chatId);
      } else if (text.startsWith('/search ') && admin) {
        await handleSearchCommand(chatId, text.slice('/search '.length).trim());
      } else if (text.startsWith('/debug ') && admin) {
        await handleDebugCommand(chatId, text.slice('/debug '.length).trim());
      } else if (text.startsWith('/mybook')) {
        await handleMyBookCommand(chatId, fromUser.id);
      } else if (text.startsWith('/addkey')) {
        await handleAddKeyStart(chatId, fromUser.id);
      } else if (text.startsWith('/mykeys')) {
        await handleMyKeys(chatId, fromUser.id);
      } else if (text.startsWith('/removekey')) {
        await handleRemoveKeyPrompt(chatId, fromUser.id);
      } else if (text.startsWith('/')) {
        await telegram.sendMessage(chatId, 'ابعتلي سؤال أو أكتر (سؤال في كل سطر) وهدور عليهم في الكتاب.');
      } else {
        // Plain text: could be a pending admin book action (rename / new
        // book name from the button flow), a Gemini key being pasted (if
        // /addkey is pending), otherwise treat it as a batch of questions.
        const handledAsBookRename = admin && (await tryHandleBookRenamePaste(chatId, fromUser.id, text));
        const handledAsNewBookName = !handledAsBookRename && admin && (await tryHandleAddBookNamePaste(chatId, fromUser.id, text));
        const handledAsAddBlockMinute =
          !handledAsBookRename &&
          !handledAsNewBookName &&
          admin &&
          (await tryHandleAddBlockMinutePaste(chatId, fromUser.id, text));
        const handledAsAddBlockLabel =
          !handledAsBookRename &&
          !handledAsNewBookName &&
          !handledAsAddBlockMinute &&
          admin &&
          (await tryHandleAddBlockLabelPaste(chatId, fromUser.id, text));
        const handledAsPdfAddUser =
          !handledAsBookRename &&
          !handledAsNewBookName &&
          !handledAsAddBlockMinute &&
          !handledAsAddBlockLabel &&
          admin &&
          (await tryHandlePdfAddUserPaste(chatId, fromUser.id, text));
        const handledAsKeyPaste =
          !handledAsBookRename &&
          !handledAsNewBookName &&
          !handledAsAddBlockMinute &&
          !handledAsAddBlockLabel &&
          !handledAsPdfAddUser &&
          (await tryHandleAddKeyPaste(chatId, fromUser.id, text));
        if (
          !handledAsBookRename &&
          !handledAsNewBookName &&
          !handledAsAddBlockMinute &&
          !handledAsAddBlockLabel &&
          !handledAsPdfAddUser &&
          !handledAsKeyPaste
        ) {
          const questions = extractQuestionsFromText(text).slice(0, MAX_QUESTIONS);
          await handleQuestionsBatch(chatId, questions, fromUser);
        }
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    // Always 200 so Telegram doesn't retry-storm us on internal errors.
    res.status(200).json({ ok: true });
  }
};
