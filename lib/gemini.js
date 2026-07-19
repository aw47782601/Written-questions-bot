const env = require('./env');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_EMBED_RETRIES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// Retries on 429 (rate limit), honoring Google's suggested retry delay
// when available, otherwise falling back to exponential backoff.
async function embedTexts(texts, attempt = 1) {
  const url = `${BASE}/models/${env.GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${env.GEMINI_API_KEY}`;
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

    if (res.status === 429 && attempt <= MAX_EMBED_RETRIES) {
      const suggested = parseRetryDelayMs(errText);
      const waitMs = suggested ?? Math.min(2 ** attempt * 1000, 30000);
      await sleep(waitMs + 500); // small buffer on top of Google's suggestion
      return embedTexts(texts, attempt + 1);
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
// on malformed JSON before giving up.
async function generateJSON(prompt) {
  const url = `${BASE}/models/${env.GEMINI_GENERATION_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini generation error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
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
