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
const botConfig = require('../lib/botConfig');
const users = require('../lib/users');
const userApiKeys = require('../lib/userApiKeys');

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

// userId (optional): when provided, the user's own validated Gemini keys
// (if they have MIN_USER_KEYS_FOR_BOOST or more) are pooled in for this
// request only, giving them extra headroom beyond the shared bot quota.
async function handleQuestionsBatch(chatId, questions, userId = null) {
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
    let extraKeys = [];
    if (userId) {
      const ownKeys = await userApiKeys.getUserApiKeysList(userId);
      if (ownKeys.length >= MIN_USER_KEYS_FOR_BOOST) {
        extraKeys = ownKeys.map((k) => k.api_key);
      }
    }
    const results = await answerQuestions(questions, extraKeys);
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

// =========================================================
// 👮 Admin panel (ported from the admin bot)
// =========================================================

async function handleAdminHelp(chatId) {
  const helpMsg =
    `🛠️ <b>لوحة التحكم والأوامر الإدارية:</b>\n\n` +
    `📊 <b>الإحصائيات:</b>\n` +
    `• <code>/stats</code> — إحصائيات عامة (مستخدمين، إجابات محفوظة).\n` +
    `• <code>/user USER_ID</code> — تقرير عن مستخدم معين.\n\n` +
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
    `🔑 <b>مفاتيح API الخاصة بالمستخدمين:</b>\n` +
    `• <code>/mykeys</code>, <code>/addkey</code>, <code>/removekey</code> — تعمل للأدمن أيضاً على مفاتيحه.\n` +
    ` مفتاحين أو أكتر يمنحوا المستخدم أولوية إضافية في حصة Gemini اليومية.`;
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
    `💾 <b>الإجابات المحفوظة في الكاش:</b> <code>${s.cachedAnswers}</code>`;
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
    const message = update.message;
    const cb = update.callback_query;

    if (!message && !cb) {
      res.status(200).json({ ok: true });
      return;
    }

    const fromUser = message ? message.from : cb.from;
    const chatId = message ? message.chat.id : cb.message.chat.id;
    const admin = isAdmin(chatId);

    // Track the user (for /stats, /user, /broadcast) on every interaction.
    if (fromUser) await users.upsertUser(fromUser);

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
        // Admin sending a PDF = replace the active curriculum book.
        await handleBookUpload(chatId, message.document.file_id, fileName);
      } else if (isPdf || isText) {
        // Anyone else sending a document = a batch of questions.
        const buffer = await telegram.downloadFileBuffer(message.document.file_id);
        const questions = isPdf
          ? await extractQuestionsFromPdfBuffer(buffer)
          : await extractQuestionsFromPlainTextBuffer(buffer);
        await handleQuestionsBatch(chatId, questions, fromUser.id);
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
            `🔑 عايز أولوية إضافية في حصة الاستخدام اليومية؟ أضف مفتاح Gemini API الخاص بك (مجاني) عبر /addkey.`;
        await telegram.sendMessage(chatId, welcomeText);
        await users.checkAndSendAlert(chatId, fromUser, telegram.sendMessage);
      } else if (text === '/status' && admin) {
        await handleStatusCommand(chatId);
      } else if (text.startsWith('/search ') && admin) {
        await handleSearchCommand(chatId, text.slice('/search '.length).trim());
      } else if (text.startsWith('/debug ') && admin) {
        await handleDebugCommand(chatId, text.slice('/debug '.length).trim());
      } else if (text.startsWith('/addkey')) {
        await handleAddKeyStart(chatId, fromUser.id);
      } else if (text.startsWith('/mykeys')) {
        await handleMyKeys(chatId, fromUser.id);
      } else if (text.startsWith('/removekey')) {
        await handleRemoveKeyPrompt(chatId, fromUser.id);
      } else if (text.startsWith('/')) {
        await telegram.sendMessage(chatId, 'ابعتلي سؤال أو أكتر (سؤال في كل سطر) وهدور عليهم في الكتاب.');
      } else {
        // Plain text: could be a Gemini key being pasted (if /addkey is
        // pending), otherwise treat it as a batch of questions.
        const handledAsKeyPaste = await tryHandleAddKeyPaste(chatId, fromUser.id, text);
        if (!handledAsKeyPaste) {
          const questions = extractQuestionsFromText(text).slice(0, MAX_QUESTIONS);
          await handleQuestionsBatch(chatId, questions, fromUser.id);
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
