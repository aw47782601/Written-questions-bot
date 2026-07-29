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
//
// preferredKey (optional): lets a caller pin a specific key for the FIRST
// attempt instead of a random one. This is how books.js gives each
// concurrently-running worker its own distinct key up front (see
// runWithConcurrency's workerIndex) so N workers running in parallel
// don't randomly collide on the same key and burn its rate limit twice as
// fast. If the preferred key is unset, or already in excludeKeys (i.e.
// it already failed once this round), this falls through to the exact
// same random-from-untried behavior as before — retry/rotation logic is
// unchanged, only the FIRST pick per worker is no longer random.
function pickKey(excludeKeys, extraKeys = [], preferredKey = null) {
  if (preferredKey && !excludeKeys.has(preferredKey)) return preferredKey;

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
// logs never leak the actual key value. Always spells out whether the key
// came from the shared/public pool or from the requesting user's own BYOK
// keys, so admins never have to guess which one answered a request.
function labelForKey(key, baseKeys, extraKeys) {
  const idx = baseKeys.indexOf(key);
  if (idx !== -1) return `🔓 مفتاح عام #${idx + 1} (Public Key #${idx + 1})`;
  const eIdx = extraKeys.indexOf(key);
  if (eIdx !== -1) return `🔑 مفتاح المستخدم #${eIdx + 1} (User's own Key #${eIdx + 1})`;
  return '❓ مفتاح غير معروف (Unknown Key)';
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

// Gemini's batchEmbedContents endpoint caps a single call at 100 requests
// (HTTP 400 INVALID_ARGUMENT above that) — this is the max texts embedded
// in ONE call to the API below. The public embedTexts (further down)
// splits any larger input into chunks of this size.
const MAX_EMBED_BATCH = 100;

// gemini-embedding-2 (and any future gemini-embedding-* model) is Google's
// multimodal embedding model — it does NOT honor the `taskType` request
// field the older text-embedding-004 / gemini-embedding-001 models use.
// Instead, the task must be encoded as a literal text prefix on the
// content itself: "task: search_query | query: {text}" for a query being
// embedded to search with, and "task: search_document | title: none |
// text: {text}" for a document/chunk being embedded to store. Silently
// ignoring this (i.e. still passing taskType in the body, as before)
// means retrieval loses the asymmetric query/document optimization
// without ever throwing an error, so this check matters even though it
// fails "softly".
function isMultimodalEmbeddingModel(model) {
  return /^gemini-embedding/.test(model);
}

function applyTaskPrefix(text, taskType) {
  if (taskType === 'RETRIEVAL_QUERY') return `task: search_query | query: ${text}`;
  // Default / RETRIEVAL_DOCUMENT.
  return `task: search_document | title: none | text: ${text}`;
}

// Embeds up to MAX_EMBED_BATCH texts in a single request. Returns an array
// of number[] vectors in the same order as the input. Internal — callers
// should use embedTexts (below), which transparently chunks larger inputs.
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
async function embedTextsChunk(
  texts,
  taskType = 'RETRIEVAL_DOCUMENT',
  extraKeys = [],
  collector = null,
  triedKeysThisRound = new Set(),
  round = 1,
  preferredKey = null
) {
  const key = pickKey(triedKeysThisRound, extraKeys, preferredKey);
  const poolSize = env.GEMINI_API_KEYS.length + extraKeys.length;
  const multimodal = isMultimodalEmbeddingModel(env.GEMINI_EMBEDDING_MODEL);
  const url = `${BASE}/models/${env.GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${key}`;
  const body = {
    requests: texts.map((t) => ({
      model: `models/${env.GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text: multimodal ? applyTaskPrefix(t, taskType) : t }] },
      outputDimensionality: 768,
      // gemini-embedding-2 ignores this field (see applyTaskPrefix above)
      // but it's harmless to still send it, and keeps this code path
      // working unchanged if GEMINI_EMBEDDING_MODEL is ever pointed back
      // at a non-multimodal model like text-embedding-004.
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
        return embedTextsChunk(texts, taskType, extraKeys, collector, newTried, round, preferredKey);
      }

      // Every key hit its limit this round — back off, then start a fresh round.
      if (round < MAX_ROUNDS) {
        const suggested = parseRetryDelayMs(errText);
        const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
        await sleep(waitMs + 500);
        return embedTextsChunk(texts, taskType, extraKeys, collector, new Set(), round + 1, preferredKey);
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

// Embeds any number of texts, transparently splitting into chunks of at
// most MAX_EMBED_BATCH (100) — Gemini's batchEmbedContents hard limit per
// call — and running the chunks in parallel. Returns a single array of
// number[] vectors in the same order as the input, same as if it had all
// fit in one request. This is what lets a batch of e.g. 101+ questions
// (see lib/questionExtractor.js, which no longer caps question count) get
// embedded without hitting "at most 100 requests can be in one batch".
async function embedTexts(texts, taskType = 'RETRIEVAL_DOCUMENT', extraKeys = [], collector = null, preferredKey = null) {
  if (texts.length <= MAX_EMBED_BATCH) {
    return embedTextsChunk(texts, taskType, extraKeys, collector, new Set(), 1, preferredKey);
  }

  const chunks = [];
  for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH) {
    chunks.push(texts.slice(i, i + MAX_EMBED_BATCH));
  }
  const results = await Promise.all(
    chunks.map((chunk) => embedTextsChunk(chunk, taskType, extraKeys, collector, new Set(), 1, preferredKey))
  );
  return results.flat();
}

async function embedOne(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const [vec] = await embedTexts([text], taskType);
  return vec;
}

// Embeds up to MAX_EMBED_BATCH images in one batchEmbedContents call.
// images: [{ buffer: Buffer, mimeType: 'image/jpeg' }]. Only meaningful
// against a multimodal model (GEMINI_EMBEDDING_MODEL = gemini-embedding-2
// or later) — text-embedding-004 has no image support at all, so this
// throws early rather than sending a request that would just 400.
// Same taskType convention as embedTexts (RETRIEVAL_DOCUMENT when storing
// a page image, RETRIEVAL_QUERY would only apply if you ever embedded an
// image as the *query* side, which this bot doesn't do).
async function embedImagesChunk(
  images,
  taskType = 'RETRIEVAL_DOCUMENT',
  extraKeys = [],
  collector = null,
  triedKeysThisRound = new Set(),
  round = 1,
  preferredKey = null
) {
  if (!isMultimodalEmbeddingModel(env.GEMINI_EMBEDDING_MODEL)) {
    throw new Error(
      `GEMINI_EMBEDDING_MODEL (${env.GEMINI_EMBEDDING_MODEL}) has no image-embedding support — set it to gemini-embedding-2 (or later) to embed images.`
    );
  }

  const key = pickKey(triedKeysThisRound, extraKeys, preferredKey);
  const poolSize = env.GEMINI_API_KEYS.length + extraKeys.length;
  const url = `${BASE}/models/${env.GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${key}`;
  const body = {
    requests: images.map((img) => ({
      model: `models/${env.GEMINI_EMBEDDING_MODEL}`,
      content: {
        parts: [
          // No text-prefix trick here — that's a text-only convention
          // (see applyTaskPrefix). The task-type signal for an image part
          // is simply which side of the pair it is; images embedded here
          // are always the document/chunk side (a stored page), never
          // the query side, in this bot's flow.
          { inlineData: { mimeType: img.mimeType, data: img.buffer.toString('base64') } },
        ],
      },
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
      if (newTried.size < poolSize) {
        return embedImagesChunk(images, taskType, extraKeys, collector, newTried, round, preferredKey);
      }
      if (round < MAX_ROUNDS) {
        const suggested = parseRetryDelayMs(errText);
        const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
        await sleep(waitMs + 500);
        return embedImagesChunk(images, taskType, extraKeys, collector, new Set(), round + 1, preferredKey);
      }
    }

    throw new Error(`Gemini image embedding error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const keyLabel = labelForKey(key, env.GEMINI_API_KEYS, extraKeys);
  if (collector) {
    collector.embeddingCalls.push({ keyLabel });
  } else {
    await notifyAdmins(`🔑 تم استخدام ${keyLabel} (image embedding)`);
  }
  return data.embeddings.map((e) => e.values);
}

// Public entry point — transparently chunks into batches of MAX_EMBED_BATCH,
// same pattern as embedTexts.
async function embedImages(images, taskType = 'RETRIEVAL_DOCUMENT', extraKeys = [], collector = null, preferredKey = null) {
  if (images.length <= MAX_EMBED_BATCH) {
    return embedImagesChunk(images, taskType, extraKeys, collector, new Set(), 1, preferredKey);
  }
  const chunks = [];
  for (let i = 0; i < images.length; i += MAX_EMBED_BATCH) {
    chunks.push(images.slice(i, i + MAX_EMBED_BATCH));
  }
  const results = await Promise.all(
    chunks.map((chunk) => embedImagesChunk(chunk, taskType, extraKeys, collector, new Set(), 1, preferredKey))
  );
  return results.flat();
}

// Shared, per-book-ingestion-run state for captionImage's quota circuit
// breaker (see captionImage below). Callers create ONE of these per book
// upload (see lib/books.js ingestPageImages) and pass the SAME object to
// every captionImage() call for that book, so what one page's captioning
// learns about a dead key/model is instantly reused by every other page
// — instead of every single page independently re-discovering the exact
// same 34-keys × 3-models worth of 429s from scratch.
function createCaptionQuotaState() {
  return {
    deadCombos: new Set(), // "key::model" pairs confirmed exhausted for this run
    fullyExhausted: false, // every key×model combo is dead — stop calling the API entirely
    loggedExhausted: false,
    notifiedExhausted: false,
    lastGoodKey: null, // most recent key that successfully returned a caption this run
  };
}

// Hard cap on how many DISTINCT keys a single captionImage() call will
// try (each tried across up to 3 models, so real worst-case network
// calls per image = this × 3). Keeps one image's latency bounded and
// spreads "which keys are still alive" discovery across many images
// running concurrently instead of one image proving out the whole pool.
const MAX_KEYS_PER_CAPTION_CALL = 6;

// A 429 on Gemini's generateContent can mean two very different things:
//   1. A short per-minute rate limit — Google's response includes a
//      RetryInfo.retryDelay hint of a few/tens of seconds, and the SAME
//      key will likely work again shortly.
//   2. A hard daily/tier quota exhaustion ("You exceeded your current
//      quota, please check your plan and billing details") — no useful
//      retryDelay, and the key won't recover until the quota resets
//      (hours), which is far longer than a single book upload runs for.
// Only the second kind gets permanently blacklisted for the rest of this
// run; a transient per-minute limit is left alone so a later page can
// still try the same key again.
function isHardQuotaExhaustion(errText) {
  const delay = parseRetryDelayMs(errText);
  if (delay === null) return true;
  return delay > 60000;
}

// One single image-captioning generateContent call against one specific
// model+key. Mirrors callGenerateContent's never-throw contract (returns
// a result object instead) so the caller can log the attempt and move on
// to the next model/key.
async function callGenerateContentImage(model, key, buffer, mimeType, prompt) {
  const url = `${BASE}/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [
      {
        parts: [{ inlineData: { mimeType, data: buffer.toString('base64') } }, { text: prompt }],
      },
    ],
    generationConfig: { maxOutputTokens: 1024, thinkingConfig: getThinkingConfig(model) },
  };

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

// Auto-captions a rendered page image with the existing vision-capable
// generation models (GEMINI_GENERATION_MODEL etc. already accept image
// input via generateContent — no separate vision model needed). The
// caption is stored as book_chunks.content for image chunks, so the
// existing text-only prompt in lib/batchAnswer.js can use it exactly
// like a normal text chunk, with zero changes to that code path. This is
// deliberately a plain text call (not generateJSON) — a short prose
// description, not structured data.
async function captionImage(buffer, mimeType, pageNumber, extraKeys = [], preferredKey = null, quotaState = null) {
  // quotaState is the circuit breaker from createCaptionQuotaState() (see
  // above). If the caller doesn't pass one (e.g. a one-off call outside
  // a book ingestion run), fall back to a fresh, local-only state so this
  // function still behaves correctly — it just can't share what it
  // learns with any other call.
  const state = quotaState || createCaptionQuotaState();

  // Once every key×model combo has been confirmed exhausted anywhere in
  // this run, every subsequent page fails INSTANTLY with zero network
  // calls instead of re-running the full 34-keys×3-models sweep again.
  // This is what actually stops a single large book from hammering an
  // already-dead quota: previously, 300 pages each independently made up
  // to 102 doomed requests (30,000+ calls total, each one a genuine hit
  // against Google's rate limiter), even though the very first page had
  // already proven every key was out of quota.
  if (state.fullyExhausted) {
    if (!state.loggedExhausted) {
      state.loggedExhausted = true;
      console.error(
        `captionImage: every Gemini key/model is exhausted for this book — skipping all remaining page ` +
          `captions with no further API calls (confirmed at page ${pageNumber}).`
      );
    }
    throw new Error('Gemini quota exhausted across every key/model for this book — captioning skipped.');
  }

  const prompt =
    `This is page ${pageNumber} of a textbook. Describe, in the same language the page's own text is written in, ` +
    `everything a student would need in order to find/answer questions from this page: any diagrams, figures, ` +
    `tables, charts, or illustrations (describe their content and labels in detail), plus a brief summary of any ` +
    `body text visible. Be concrete and specific (numbers, labels, steps) rather than generic. Plain prose only, ` +
    `no markdown, no preamble like "This page shows" — just the description itself.`;

  // Image input needs its own request shape (inlineData), so this can't
  // reuse runFallbackSequence/callGenerateContent as-is — but it mirrors
  // the same key×model fallback: primary model first (GEMINI_GENERATION_
  // MODEL, e.g. gemini-3.6-flash), then GEMINI_GENERATION_MODEL_FALLBACK
  // (gemini-3.5-flash), then GEMINI_GENERATION_MODEL_LITE (gemini-3-
  // flash-preview), on every key, before giving up. This was previously a
  // single key/single model call with no fallback at all, which meant a
  // batch of 100+ pages captioned back-to-back burned through the free-
  // tier's daily generateContent quota on the primary model alone and
  // every subsequent page failed with 429 RESOURCE_EXHAUSTED. Falling
  // through to 3.5 and then the 3-preview model spreads the same batch
  // across three separate per-model quotas instead of hammering one.
  // Deliberately no sleep/backoff/round-repeat here (unlike generateJSON)
  // — this stays a best-effort, non-blocking step from the caller's
  // point of view. It DOES now throw on total failure (see below)
  // instead of silently returning a placeholder caption, so the caller
  // can no longer mistake a failed page for a real success.
  const models = [env.GEMINI_GENERATION_MODEL, env.GEMINI_GENERATION_MODEL_FALLBACK, env.GEMINI_GENERATION_MODEL_LITE];
  const baseKeys = env.GEMINI_API_KEYS;
  const fullKeys = extraKeys.length > 0 ? [...extraKeys, ...baseKeys] : baseKeys;
  // Constant regardless of how many keys THIS call actually tries below —
  // fullyExhausted must only flip once every combo across the ENTIRE key
  // pool is confirmed dead, even though (see MAX_KEYS_PER_CAPTION_CALL)
  // no single call tries the entire pool by itself anymore.
  const totalCombos = fullKeys.length * models.length;

  // Keys that still have at least one non-blacklisted model left. A key
  // fully dead across all 3 models is worth zero in the sample below —
  // filtering these out up front means the cap isn't wasted on keys
  // already proven useless.
  const aliveKeys = fullKeys.filter((k) => models.some((m) => !state.deadCombos.has(`${k}::${m}`)));

  if (aliveKeys.length === 0) {
    state.fullyExhausted = true;
    if (!state.notifiedExhausted) {
      state.notifiedExhausted = true;
      notifyAdmins(
        `🚨 كل مفاتيح/موديلات Gemini خلصت الكوتة أثناء توليد وصف الصور (بدأ من صفحة ${pageNumber}) — ` +
          `باقي صفحات الكتاب هتتحفظ بحالة "caption_failed" من غير ما نضرب الـ API تاني، لحد ما الكوتة ترجع أو تتضاف مفاتيح جديدة.`
      ).catch(() => {});
    }
    throw new Error('Gemini quota exhausted across every key/model for this book — captioning skipped.');
  }

  // Previously this tried EVERY key (up to 34) × 3 models — up to 102
  // sequential HTTP calls — before giving up on a single image. That's
  // thorough but expensive: it burns a large chunk of real quota just to
  // confirm what other pages may have already confirmed, and it makes
  // one image's worst-case latency huge. Instead: try the worker's own
  // pinned key first (no cross-worker key collisions), then whichever
  // key most recently proved it still has quota this run (recent success
  // is a much better predictor than a blind guess), then top up with a
  // small RANDOM sample of the remaining alive keys — capped at
  // MAX_KEYS_PER_CAPTION_CALL total keys (so at most MAX_KEYS_PER_
  // CAPTION_CALL × 3 real calls per image). Any key this call doesn't
  // try is left for a later image to sample instead — across a whole
  // book's worth of concurrent images, the full key pool still gets
  // covered quickly, just spread out instead of dumped onto page 1.
  const orderedKeys = [];
  const seen = new Set();
  const pushIfAlive = (k) => {
    if (k && aliveKeys.includes(k) && !seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  };
  pushIfAlive(preferredKey);
  pushIfAlive(state.lastGoodKey);

  // User's own (extra) keys are still preferred over the shared pool —
  // same priority as the rest of this file (see pickKey) — just also
  // shuffled and capped like the base pool.
  const aliveExtra = extraKeys.filter((k) => aliveKeys.includes(k) && !seen.has(k));
  const aliveBase = baseKeys.filter((k) => aliveKeys.includes(k) && !seen.has(k) && !aliveExtra.includes(k));
  for (const k of [...shuffled(aliveExtra), ...shuffled(aliveBase)]) {
    if (orderedKeys.length >= MAX_KEYS_PER_CAPTION_CALL) break;
    if (!seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  }

  const attempts = [];
  for (const key of orderedKeys) {
    for (const model of models) {
      const combo = `${key}::${model}`;
      // Another page already proved this exact key+model is out of
      // quota this run — skip it without spending a request re-proving
      // the same thing.
      if (state.deadCombos.has(combo)) continue;

      const result = await callGenerateContentImage(model, key, buffer, mimeType, prompt);
      if (result.ok) {
        const text = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          state.lastGoodKey = key; // next image tries this key first — it just proved it still has quota
          return text.trim();
        }
        attempts.push({ model, status: 'empty', errText: 'Gemini returned no caption text' });
        continue;
      }

      attempts.push({ model, status: result.status, errText: result.errText });

      if (result.status === 429 && isHardQuotaExhaustion(result.errText)) {
        state.deadCombos.add(combo);
        if (state.lastGoodKey === key) state.lastGoodKey = null;
      }
    }
  }

  if (state.deadCombos.size >= totalCombos) {
    state.fullyExhausted = true;
    if (!state.notifiedExhausted) {
      state.notifiedExhausted = true;
      notifyAdmins(
        `🚨 كل مفاتيح/موديلات Gemini خلصت الكوتة أثناء توليد وصف الصور (بدأ من صفحة ${pageNumber}) — ` +
          `باقي صفحات الكتاب هتتحفظ بحالة "caption_failed" من غير ما نضرب الـ API تاني، لحد ما الكوتة ترجع أو تتضاف مفاتيح جديدة.`
      ).catch(() => {});
    }
  }

  const last = attempts[attempts.length - 1];
  console.error(
    `captionImage failed for page ${pageNumber} after ${attempts.length} attempt(s) across ${orderedKeys.length} key(s) (of ${fullKeys.length} total) × ${models.length} model(s):`,
    last ? `${last.model} → ${last.status}: ${(last.errText || '').slice(0, 200)}` : 'no attempts were made (every sampled key/model combo already known-exhausted)'
  );
  throw new Error(
    last
      ? `Gemini captioning failed (${last.status}): ${(last.errText || '').slice(0, 300)}`
      : 'Gemini captioning failed: every sampled key/model combo already known-exhausted this run.'
  );
}

// Gemini 3.x models (gemini-3-flash-preview, gemini-3.5-flash,
// gemini-3.6-flash, gemini-3.5-flash-lite, and whatever ships next in
// that line) replaced the old numeric `thinkingBudget` with a string enum
// `thinkingLevel` (minimal/low/medium/high). This isn't just a soft
// deprecation for the newest models: gemini-3.6-flash hard-rejects
// `thinkingBudget` with a 400 INVALID_ARGUMENT (no backward-compat shim),
// which is exactly the error seen when it was tried with the old
// thinkingBudget:0 body.
//
// IMPORTANT — this is checked by PATTERN, not by an allowlist, and
// defaults to "Gemini-3-style" for anything NOT recognized as an older
// generation. That's deliberate: this codebase also points some model
// config at Google's auto-updating "-latest" aliases (e.g.
// GEMINI_EXTRACTION_MODEL's default, 'gemini-flash-lite-latest'), and
// those aliases silently move forward over time — as of the 2.0 line's
// full retirement (June 2026), every "-latest" alias in the flash/lite
// family now resolves to a Gemini 3.x model (currently
// gemini-3.5-flash-lite). A naive `/^gemini-3/` check would miss that
// alias entirely (it doesn't literally start with "gemini-3") and keep
// sending the old thinkingBudget field forever, which is exactly the bug
// that silently broke lib/questionExtractor.js's AI extraction — every
// call 400'd, and the per-chunk try/catch quietly fell back to naive
// line-splitting with no chapter detection and no line-wrap merging.
// Recognizing only a short, explicit list of pre-Gemini-3 prefixes (and
// defaulting everything else — including unknown future models and
// "-latest" aliases — to the modern thinkingLevel shape) is far more
// robust to this kind of silent upstream rename than trying to keep an
// allowlist of "which -latest alias means what" up to date by hand.
function isLegacyThinkingBudgetModel(model) {
  return /^(gemini-2(\.|-|$)|gemini-1(\.|-|$)|text-|models\/gemini-2|models\/gemini-1)/.test(model || '');
}

function getThinkingConfig(model) {
  if (isLegacyThinkingBudgetModel(model)) return { thinkingBudget: 0 };
  // Gemini 3 Flash / Flash-Lite also can't fully disable thinking — the
  // lowest setting is "minimal" (closest equivalent to the old
  // thinkingBudget:0 "don't spend extra tokens thinking" intent).
  return { thinkingLevel: 'minimal' };
}

function buildGenerationBody(prompt, maxOutputTokens, responseSchema, model) {
  // Same legacy/modern split as getThinkingConfig above — anything not
  // recognized as a pre-Gemini-3 model (including "-latest" aliases) is
  // treated as Gemini-3-style here too, since Gemini 3.x ignores/rejects
  // temperature/top_p/top_k the same way it rejects thinkingBudget.
  const isModern = !isLegacyThinkingBudgetModel(model);
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
      // Gemini 3.x ignores temperature/top_p/top_k today and Google has
      // said future generations will 400 on them — omitted entirely for
      // Gemini 3 models so this doesn't quietly break on the next model
      // bump. Older models still get the low, deterministic-ish setting
      // this task wants.
      ...(isModern ? {} : { temperature: 0.2 }),
      maxOutputTokens,
      // This task is straight extraction/QA from provided context, not
      // multi-step reasoning — spending extra thinking tokens would just
      // eat into the same output budget as the actual answer and risk
      // truncating it, so every model is told to think as little as its
      // API shape allows (see getThinkingConfig above).
      thinkingConfig: getThinkingConfig(model),
    },
  };
}

// One single generateContent call against one specific model+key.
// Never throws for HTTP-level failures — returns a result object instead,
// so the caller can log the attempt and move on to the next model/key.
async function callGenerateContent(model, key, prompt, maxOutputTokens, responseSchema) {
  const url = `${BASE}/models/${model}:generateContent?key=${key}`;
  const body = buildGenerationBody(prompt, maxOutputTokens, responseSchema, model);

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
async function runFallbackSequence(prompt, maxOutputTokens, responseSchema, extraKeys, models) {
  const baseKeys = env.GEMINI_API_KEYS;
  // The user's own keys (if any) are tried first, in their own random
  // order, before falling back to the shared/public pool — also
  // shuffled among itself so no single public key is favored.
  const keys = extraKeys.length > 0 ? [...shuffled(extraKeys), ...shuffled(baseKeys)] : shuffled(baseKeys);
  const attempts = [];

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
//   1. Keys are tried in random order. For each key, every model in
//      `models` (default: primary/fallback/lite from env — see below) is
//      tried in order before moving to the next key.
//   2. If that whole sequence still fails and the failures look transient
//      (429/500/503), back off and repeat the entire sequence up to
//      MAX_ROUNDS times.
// Admins get a Telegram notification whenever a call only succeeded after
// at least one failed attempt (so they can see quota pressure as it
// happens), and a separate alert if every key/model combination failed.
// `models` (optional): override the model list — e.g. a caller doing a
// small, cheap task (like question/chapter extraction) can pass just
// ['gemini-flash-lite-latest'] instead of going through the full
// primary→fallback→lite chain meant for the heavier RAG-answer calls.
async function generateJSON(
  prompt,
  { maxOutputTokens = 8192, responseSchema = null, extraKeys = [], collector = null, models = null } = {},
  round = 1,
  priorAttempts = []
) {
  const effectiveModels = models || [env.GEMINI_GENERATION_MODEL, env.GEMINI_GENERATION_MODEL_FALLBACK, env.GEMINI_GENERATION_MODEL_LITE];
  const { data, usedModel, usedKeyLabel, attempts } = await runFallbackSequence(prompt, maxOutputTokens, responseSchema, extraKeys, effectiveModels);
  const allAttempts = [...priorAttempts, ...attempts];

  if (!data) {
    const last = allAttempts[allAttempts.length - 1];
    const retryable = last && (last.status === 429 || last.status === 500 || last.status === 503);

    if (retryable && round < MAX_ROUNDS) {
      const last429 = [...allAttempts].reverse().find((a) => a.status === 429);
      const suggested = last429 ? parseRetryDelayMs(last429.errText) : null;
      const waitMs = suggested ?? Math.min(2 ** round * 1000, 30000);
      await sleep(waitMs + 500);
      return generateJSON(prompt, { maxOutputTokens, responseSchema, extraKeys, collector, models }, round + 1, allAttempts);
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
  if (candidate?.finishReason === 'MAX_TOKENS' && maxOutputTokens < 60000) {
    return generateJSON(prompt, { maxOutputTokens: maxOutputTokens * 2, responseSchema, extraKeys, collector, models }, round, allAttempts);
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

module.exports = {
  embedTexts,
  embedOne,
  embedImages,
  captionImage,
  createCaptionQuotaState,
  generateJSON,
  formatAttemptLog,
  shuffled,
  notifyAdmins,
};
