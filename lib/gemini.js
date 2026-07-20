const env = require('./env');
// telegram.js only depends on env.js, so requiring it here is safe —
// no circular dependency with api/telegram-webhook.js, which is the
// thing that requires gemini.js.
const telegram = require('./telegram');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_ROUNDS = 3; // how many times to cycle through the whole key×model sequence before giving up

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prefers the caller's own (extra) keys over the shared pool: as long as
// any untried user key remains this round, it's used before touching a
// public key at all. Only once every user key has been tried do we fall
// back to the shared GEMINI_API_KEYS pool.
function pickKey(excludeKeys, extraKeys = []) {
  const untriedExtra = extraKeys.filter((k) => !excludeKeys.has(k));
  if (untriedExtra.length > 0) {
    return untriedExtra[Math.floor(Math.random() * untriedExtra.length)];
  }
  const untriedBase = env.GEMINI_API_KEYS.filter((k) => !excludeKeys.has(k));
  if (untriedBase.length > 0) {
    return untriedBase[Math.floor(Math.random() * untriedBase.length)];
  }
  // Every key already tried this round — pickKey is only reached again
  // once the caller has confirmed there's an untried key left, but fall
  // back to the full pool defensively rather than returning undefined.
  const fullPool = [...env.GEMINI_API_KEYS, ...extraKeys];
  return fullPool[Math.floor(Math.random() * fullPool.length)];
}

// Fisher-Yates shuffle — used to randomize the *order* keys are tried in
// on every top-level call, while still trying every key exactly once per
// round (so "random" doesn't mean "might skip/repeat a key").
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Human-readable, non-secret label for a key so admin notifications and
// logs never leak the actual key value.
function labelForKey(key, baseKeys, extraKeys) {
  const idx = baseKeys.indexOf(key);
  if (idx !== -1) return `Key #${idx + 1}`;
  const eIdx = extraKeys.indexOf(key);
  if (eIdx !== -1) return `User key #${eIdx + 1}`;
  return 'Key #?';
}

// Best-effort admin notification — never lets a notify failure affect
// the actual Gemini call's result.
async function notifyAdmins(text) {
  if (env.ADMIN_CHAT_IDS.length === 0) return;
  await Promise.all(
    env.ADMIN_CHAT_IDS.map((id) =>
      telegram.sendMessage(id, text).catch((err) => console.error(`gemini notifyAdmins failed for ${id}:`, err.message))
    )
  );
}

function formatAttempt(a) {
  const shortErr = (a.errText || '').slice(0, 120).replace(/\s+/g, ' ');
  return `❌ ${a.keyLabel} · ${a.model} → ${a.status}: ${shortErr}`;
}

// Telegram messages are capped at 4096 chars — an exhausted run with many
// keys/models could produce a huge attempt log, so only show the tail.
function formatAttemptLog(attempts, limit = 15) {
  const shown = attempts.slice(-limit);
  const header = attempts.length > shown.length ? `(showing last ${shown.length} of ${attempts.length} failed attempts)\n` : '';
  return header + shown.map(formatAttempt).join('\n');
}

// Always tells the admin which key answered the request (public "Key #N"
// vs the caller's own "User key #N"), not just when a fallback happened.
// When there WAS a fallback (one or more failed attempts first), the
// fuller warning with the attempt log is sent instead of the plain note.
async function notifyKeyUsed(usedLabel, usedModel, attempts) {
  if (attempts.length === 0) {
    await notifyAdmins(`🔑 تم استخدام ${usedLabel} · ${usedModel}`);
    return;
  }
  await notifyAdmins(
    `⚠️ Gemini fallback used\n\n✅ Succeeded on ${usedLabel} · ${usedModel}\n\n${formatAttemptLog(attempts)}`
  );
}

async function notifyAllFailed(attempts) {
  await notifyAdmins(`🚨 All Gemini keys/models failed\n\n${formatAttemptLog(attempts, 25)}`);
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
// collector (optional): a shared { embeddingCalls, generationCalls,
// failures } object (see batchAnswer.js). When provided, "which key was
// used" is recorded there instead of firing an admin notification for
// every single embedding call, so the caller can send ONE consolidated
// report at the end of the request.
async function embedTexts(texts, taskType = 'RETRIEVAL_DOCUMENT', extraKeys = [], collector = null, triedKeysThisRound = new Set(), round = 1) {
  const key = pickKey(triedKeysThisRound, extraKeys);
  const poolSize = env.GEMINI_API_KEYS.length + extraKeys.length;
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
      if (newTried.size < poolSize) {
        return embedTexts(texts, taskType, extraKeys, collector, newTried, round);
      }

      // Every key hit its limit this round — back off, then start a fresh round.
      if (round < MAX_ROUNDS) {
        const suggested = parseRetryDelayMs(errText);
        const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
        await sleep(waitMs + 500);
        return embedTexts(texts, taskType, extraKeys, collector, new Set(), round + 1);
      }
    }

    throw new Error(`Gemini embedding error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const keyLabel = labelForKey(key, env.GEMINI_API_KEYS, extraKeys);
  if (collector) {
    collector.embeddingCalls.push({ keyLabel });
  } else {
    await notifyAdmins(`🔑 تم استخدام ${keyLabel} (embedding)`);
  }
  return data.embeddings.map((e) => e.values);
}

async function embedOne(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const [vec] = await embedTexts([text], taskType);
  return vec;
}

function buildGenerationBody(prompt, maxOutputTokens, responseSchema, includeThinkingConfig) {
  return {
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
      // Omitted for the lite fallback model, which doesn't support
      // thinking at all and would 400 on an unrecognized thinkingConfig.
      ...(includeThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
}

// One single generateContent call against one specific model+key.
// Never throws for HTTP-level failures — returns a result object instead,
// so the caller can log the attempt and move on to the next model/key.
async function callGenerateContent(model, key, prompt, maxOutputTokens, responseSchema) {
  const url = `${BASE}/models/${model}:generateContent?key=${key}`;
  const body = buildGenerationBody(prompt, maxOutputTokens, responseSchema, model !== env.GEMINI_GENERATION_MODEL_LITE);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 'network', errText: err.message };
  }

  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, status: res.status, errText };
  }

  return { ok: true, data: await res.json() };
}

// Runs exactly one pass over every key, and for each key tries the three
// models in order — primary, then fallback, then lite — before moving to
// the next key. So: Key #1/3.5, Key #1/3, Key #1/lite, Key #2/3.5, Key
// #2/3, Key #2/lite, ... Key order is randomized per call.
// Returns { data, usedModel, usedKeyLabel, attempts } on success, or
// { attempts } (data undefined) if the whole sequence failed.
async function runFallbackSequence(prompt, maxOutputTokens, responseSchema, extraKeys) {
  const baseKeys = env.GEMINI_API_KEYS;
  // The user's own keys (if any) are tried first, in their own random
  // order, before falling back to the shared/public pool — also
  // shuffled among itself so no single public key is favored.
  const keys = extraKeys.length > 0 ? [...shuffled(extraKeys), ...shuffled(baseKeys)] : shuffled(baseKeys);
  const attempts = [];

  const models = [env.GEMINI_GENERATION_MODEL, env.GEMINI_GENERATION_MODEL_FALLBACK, env.GEMINI_GENERATION_MODEL_LITE];

  for (const key of keys) {
    const keyLabel = labelForKey(key, baseKeys, extraKeys);
    for (const model of models) {
      const result = await callGenerateContent(model, key, prompt, maxOutputTokens, responseSchema);
      if (result.ok) {
        return { data: result.data, usedModel: model, usedKeyLabel: keyLabel, attempts };
      }
      attempts.push({ keyLabel, model, status: result.status, errText: result.errText });
    }
  }

  return { attempts };
}

// Calls generateContent asking for strict JSON output. Retry sequence:
//   1. Keys are tried in random order. For each key, all three models are
//      tried in order — primary (3.5), fallback (3), then lite — before
//      moving to the next key.
//   2. If that whole sequence still fails and the failures look transient
//      (429/500/503), back off and repeat the entire sequence up to
//      MAX_ROUNDS times.
// Admins get a Telegram notification whenever a call only succeeded after
// at least one failed attempt (so they can see quota pressure as it
// happens), and a separate alert if every key/model combination failed.
async function generateJSON(prompt, { maxOutputTokens = 8192, responseSchema = null, extraKeys = [], collector = null } = {}, round = 1, priorAttempts = []) {
  const { data, usedModel, usedKeyLabel, attempts } = await runFallbackSequence(prompt, maxOutputTokens, responseSchema, extraKeys);
  const allAttempts = [...priorAttempts, ...attempts];

  if (!data) {
    const last = allAttempts[allAttempts.length - 1];
    const retryable = last && (last.status === 429 || last.status === 500 || last.status === 503);

    if (retryable && round < MAX_ROUNDS) {
      const last429 = [...allAttempts].reverse().find((a) => a.status === 429);
      const suggested = last429 ? parseRetryDelayMs(last429.errText) : null;
      const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
      await sleep(waitMs + 500);
      return generateJSON(prompt, { maxOutputTokens, responseSchema, extraKeys, collector }, round + 1, allAttempts);
    }

    if (collector) {
      collector.generationCalls.push({ failed: true, attempts: allAttempts });
    } else {
      await notifyAllFailed(allAttempts);
    }
    const lastStatus = last ? last.status : 'unknown';
    const lastErr = last ? last.errText : 'no attempts were made';
    throw new Error(`Gemini generation error (${lastStatus}): ${lastErr}`);
  }

  const candidate = data.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text;

  // Output got cut off before finishing — give it more room once rather
  // than surfacing a confusing "unexpected end of JSON" parse error.
  // Restarts the fallback sequence fresh (doubled token budget); prior
  // attempts are still carried along so the eventual admin notification
  // reflects the full picture.
  if (candidate?.finishReason === 'MAX_TOKENS' && maxOutputTokens < 32768) {
    return generateJSON(prompt, { maxOutputTokens: maxOutputTokens * 2, responseSchema, extraKeys, collector }, round, allAttempts);
  }

  if (!rawText) throw new Error('Gemini returned no content');

  if (collector) {
    collector.generationCalls.push({ failed: false, keyLabel: usedKeyLabel, model: usedModel, attempts: allAttempts });
  } else {
    await notifyKeyUsed(usedKeyLabel, usedModel, allAttempts);
  }

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

module.exports = { embedTexts, embedOne, generateJSON, formatAttemptLog };
