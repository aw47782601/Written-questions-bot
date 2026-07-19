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
async function sendLongMessage(chatId, text) {
  const LIMIT = 3500;
  if (text.length <= LIMIT) {
    return sendMessage(chatId, text);
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
    await sendMessage(chatId, part);
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
  editMessageText,
  answerCallbackQuery,
  downloadFileBuffer,
};
