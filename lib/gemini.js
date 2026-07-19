const env = require('./env');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Embeds up to ~100 texts in a single request. Returns an array of
// number[] vectors in the same order as the input.
async function embedTexts(texts) {
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
