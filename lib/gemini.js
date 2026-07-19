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
// taskType should be 'RETRIEVAL_DOCUMENT' when embedding book chunks to
// store, or 'RETRIEVAL_QUERY' when embedding a user's question to search
// with — Gemini optimizes each side of the pair differently, which
// meaningfully improves whether the right chunk ranks at the top.
// Picks a random key from GEMINI_API_KEYS per call. On 429, rotates to a
// different key immediately (no wait) — only backs off once every key
// has hit its limit in the current round.
async function embedTexts(texts, taskType = 'RETRIEVAL_DOCUMENT', triedKeysThisRound = new Set(), round = 1) {
  const key = pickKey(triedKeysThisRound);
  const url = `${BASE}/models/${env.GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${key}`;
  const body = {
    requests: texts.map((t) => ({
      model: `models/${env.GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text: t }] },
      outputDimensionality: 768,
      taskType,
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
        return embedTexts(texts, taskType, newTried, round);
      }

      // Every key hit its limit this round — back off, then start a fresh round.
      if (round < MAX_ROUNDS) {
        const suggested = parseRetryDelayMs(errText);
        const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
        await sleep(waitMs + 500);
        return embedTexts(texts, taskType, new Set(), round + 1);
      }
    }

    throw new Error(`Gemini embedding error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

async function embedOne(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const [vec] = await embedTexts([text], taskType);
  return vec;
}

// Calls generateContent asking for strict JSON output, retries once
// on malformed JSON before giving up. Also rotates across GEMINI_API_KEYS
// on 429, same as embedTexts.
async function generateJSON(prompt, { maxOutputTokens = 8192, responseSchema = null } = {}, triedKeysThisRound = new Set(), round = 1) {
  const key = pickKey(triedKeysThisRound);
  const url = `${BASE}/models/${env.GEMINI_GENERATION_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // responseMimeType alone just tells Gemini to *wrap* the output as
      // JSON text — it doesn't force the structured-output encoder, so
      // long/multi-line answers can come back with a raw, unescaped
      // newline inside a string value and break JSON.parse. Passing an
      // explicit schema forces the structured encoder, which escapes
      // control characters correctly.
      ...(responseSchema ? { responseSchema } : {}),
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
        return generateJSON(prompt, { maxOutputTokens, responseSchema }, newTried, round);
      }

      if (round < MAX_ROUNDS) {
        const suggested = parseRetryDelayMs(errText);
        const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
        await sleep(waitMs + 500);
        return generateJSON(prompt, { maxOutputTokens, responseSchema }, new Set(), round + 1);
      }
    }

    // Transient server-side errors (overload, timeouts) — brief retry.
    // Not for 404 (bad/retired model name) or 400 (bad request), which
    // won't be fixed by retrying.
    if ((res.status === 500 || res.status === 503) && round < MAX_ROUNDS) {
      await sleep(1500 * round);
      return generateJSON(prompt, { maxOutputTokens, responseSchema }, new Set(), round + 1);
    }

    throw new Error(`Gemini generation error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text;

  // Output got cut off before finishing — give it more room once rather
  // than surfacing a confusing "unexpected end of JSON" parse error.
  if (candidate?.finishReason === 'MAX_TOKENS' && maxOutputTokens < 32768) {
    return generateJSON(prompt, { maxOutputTokens: maxOutputTokens * 2, responseSchema }, triedKeysThisRound, round);
  }

  if (!rawText) throw new Error('Gemini returned no content');

  try {
    return JSON.parse(rawText);
  } catch (err) {
    // Fallback 1: model sometimes wraps JSON in ```json fences despite instructions
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (err2) {
      // Fallback 2: a raw, unescaped control character (literal newline/tab)
      // landed inside a JSON string value — this is what responseSchema
      // is meant to prevent, but belt-and-suspenders in case it still
      // happens. Escape stray control chars that occur *inside* quoted
      // strings only, leaving structural whitespace between tokens alone.
      let out = '';
      let inString = false;
      let escaped = false;
      for (const ch of cleaned) {
        if (inString) {
          if (escaped) {
            out += ch;
            escaped = false;
          } else if (ch === '\\') {
            out += ch;
            escaped = true;
          } else if (ch === '"') {
            out += ch;
            inString = false;
          } else if (ch === '\n') {
            out += '\\n';
          } else if (ch === '\r') {
            out += '\\r';
          } else if (ch === '\t') {
            out += '\\t';
          } else {
            out += ch;
          }
        } else {
          out += ch;
          if (ch === '"') inString = true;
        }
      }
      return JSON.parse(out);
    }
  }
}

module.exports = { embedTexts, embedOne, generateJSON };
