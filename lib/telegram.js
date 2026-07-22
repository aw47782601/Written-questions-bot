const env = require('./env');

const API_BASE = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
const FILE_BASE = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}`;

async function callApi(method, body) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram API error on ${method}:`, data);
  }
  return data;
}

async function sendMessage(chatId, text, extra = {}) {
  const data = await callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...extra,
  });

  // Markdown parsing can fail on raw error text (unescaped _, *, [, `, etc).
  // Retry once as plain text so the message still gets through.
  if (!data.ok && data.description?.includes("can't parse entities")) {
    return callApi('sendMessage', {
      chat_id: chatId,
      text,
      ...extra,
    });
  }

  return data;
}

// Telegram messages are capped at 4096 chars — split long answer
// lists into multiple messages on paragraph boundaries.
// extra (optional): forwarded to every part's sendMessage call — e.g.
// { parse_mode: 'HTML' } for the 🙈 spoiler answer format (see
// formatResultsSpoiler in api/telegram-webhook.js). Note: splitting can in
// theory cut an HTML entity like <tg-spoiler> across two parts if a single
// answer is long enough to force a hard cut instead of landing on a
// paragraph boundary — sendMessage already falls back to plain text on a
// "can't parse entities" error, so that just loses the spoiler/bold
// styling for that one message instead of failing to send it.
async function sendLongMessage(chatId, text, extra = {}) {
  const LIMIT = 3500;
  if (text.length <= LIMIT) {
    return sendMessage(chatId, text, extra);
  }
  const parts = [];
  let remaining = text;
  while (remaining.length > LIMIT) {
    let cutAt = remaining.lastIndexOf('\n\n', LIMIT);
    if (cutAt <= 0) cutAt = LIMIT;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  if (remaining.trim()) parts.push(remaining);

  for (const part of parts) {
    await sendMessage(chatId, part, extra);
  }
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  const data = await callApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    ...extra,
  });

  if (!data.ok && data.description?.includes("can't parse entities")) {
    return callApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...extra,
    });
  }

  return data;
}

async function answerCallbackQuery(callbackQueryId, extra = {}) {
  return callApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...extra,
  });
}

// Uploads a Buffer (e.g. a generated PDF) as a Telegram document. Uses the
// runtime's global FormData/Blob (available in Node 18+, same runtime that
// already gives us global fetch) instead of a extra dependency — Telegram's
// multipart upload just needs a Blob part named "document".
async function sendDocument(chatId, buffer, filename, extra = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (extra.caption) form.append('caption', extra.caption);
  if (extra.parse_mode) form.append('parse_mode', extra.parse_mode);
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);

  const res = await fetch(`${API_BASE}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram API error on sendDocument:', data);
  }
  return data;
}

async function getFileDownloadUrl(fileId) {
  const data = await callApi('getFile', { file_id: fileId });
  if (!data.ok) throw new Error('Failed to resolve Telegram file');
  return `${FILE_BASE}/${data.result.file_path}`;
}

async function downloadFileBuffer(fileId) {
  const url = await getFileDownloadUrl(fileId);
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  sendMessage,
  sendLongMessage,
  sendDocument,
  editMessageText,
  answerCallbackQuery,
  downloadFileBuffer,
};
