const env = require('./env');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_ROUNDS = 3; // how many times to cycle through all keys before giving up

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickKey(excludeKeys) {
  const pool = env.GEMINI_API_KEYS.filter((k) => !excludeKeys.has(k));
  const from = pool.length > 0 ? pool : env.GEMINI_API_KEYS;
  return from[Math.floor(Math.random() * from.length)];
}

// Pulls the "retry in Xs" hint out of a 429 error body, if present.
function parseRetryDelayMs(errText) {
  try {
    const parsed = JSON.parse(errText);
    const detail = parsed?.error?.details?.find(
      (d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
    );
    const raw = detail?.retryDelay; // e.g. "23s"
    if (raw) {
      const secs = parseFloat(raw.replace('s', ''));
      if (!Number.isNaN(secs)) return secs * 1000;
    }
  } catch (_) {
    // fall through to default backoff
  }
  return null;
}

// Embeds up to ~100 texts in a single request. Returns an array of
// number[] vectors in the same order as the input.
// Picks a random key from GEMINI_API_KEYS per call. On 429, rotates to a
// different key immediately (no wait) — only backs off once every key
// has hit its limit in the current round.
async function embedTexts(texts, triedKeysThisRound = new Set(), round = 1) {
  const key = pickKey(triedKeysThisRound);
  const url = `${BASE}/models/${env.GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${key}`;
  const body = {
    requests: texts.map((t) => ({
      model: `models/${env.GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text: t }] },
      outputDimensionality: 768,
    })),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();

    if (res.status === 429) {
      const newTried = new Set(triedKeysThisRound).add(key);

      // Still have untried keys this round — rotate immediately, no wait.
      if (newTried.size < env.GEMINI_API_KEYS.length) {
        return embedTexts(texts, newTried, round);
      }

      // Every key hit its limit this round — back off, then start a fresh round.
      if (round < MAX_ROUNDS) {
        const suggested = parseRetryDelayMs(errText);
        const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
        await sleep(waitMs + 500);
        return embedTexts(texts, new Set(), round + 1);
      }
    }

    throw new Error(`Gemini embedding error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

async function embedOne(text) {
  const [vec] = await embedTexts([text]);
  return vec;
}

// Calls generateContent asking for strict JSON output, retries once
// on malformed JSON before giving up. Also rotates across GEMINI_API_KEYS
// on 429, same as embedTexts.
async function generateJSON(prompt, { maxOutputTokens = 8192 } = {}, triedKeysThisRound = new Set(), round = 1) {
  const key = pickKey(triedKeysThisRound);
  const url = `${BASE}/models/${env.GEMINI_GENERATION_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens,
      // This task is straight extraction/QA from provided context, not
      // multi-step reasoning — thinking tokens would just eat into the
      // same output budget as the actual answer and risk truncating it.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();

    if (res.status === 429) {
      const newTried = new Set(triedKeysThisRound).add(key);

      if (newTried.size < env.GEMINI_API_KEYS.length) {
        return generateJSON(prompt, { maxOutputTokens }, newTried, round);
      }

      if (round < MAX_ROUNDS) {
        const suggested = parseRetryDelayMs(errText);
        const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
        await sleep(waitMs + 500);
        return generateJSON(prompt, { maxOutputTokens }, new Set(), round + 1);
      }
    }

    // Transient server-side errors (overload, timeouts) — brief retry.
    // Not for 404 (bad/retired model name) or 400 (bad request), which
    // won't be fixed by retrying.
    if ((res.status === 500 || res.status === 503) && round < MAX_ROUNDS) {
      await sleep(1500 * round);
      return generateJSON(prompt, { maxOutputTokens }, new Set(), round + 1);
    }

    throw new Error(`Gemini generation error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text;

  // Output got cut off before finishing — give it more room once rather
  // than surfacing a confusing "unexpected end of JSON" parse error.
  if (candidate?.finishReason === 'MAX_TOKENS' && maxOutputTokens < 32768) {
    return generateJSON(prompt, { maxOutputTokens: maxOutputTokens * 2 }, triedKeysThisRound, round);
  }

  if (!rawText) throw new Error('Gemini returned no content');

  try {
    return JSON.parse(rawText);
  } catch (err) {
    // Fallback: model sometimes wraps JSON in ```json fences despite instructions
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  }
}

module.exports = { embedTexts, embedOne, generateJSON };
