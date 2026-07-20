const supabase = require('./supabaseClient');

// Telegram retries webhook delivery if it doesn't get a response quickly
// enough. Answering a batch of 80 questions can take minutes, so by the
// time we're done, Telegram has already resent the same update one or
// more times — and without dedup, each resend kicks off its own full
// search/answer run in parallel (the "lag" / duplicate-processing bug).
//
// Fix: telegram_updates.update_id is a primary key. We try to INSERT the
// incoming update_id before doing anything else. The insert either:
//   - succeeds -> this is the first time we've seen this update, proceed.
//   - fails with a unique-violation -> we've already seen (or are already
//     processing) this update, so skip it entirely.
// This is atomic at the DB level, so there's no read-then-write race
// between two overlapping invocations handling the same retried update.
async function isDuplicateUpdate(updateId) {
  if (updateId === undefined || updateId === null) return false; // nothing to key on, let it through

  const { error } = await supabase.from('telegram_updates').insert({ update_id: updateId });
  if (!error) return false; // first time seeing this update_id

  if (error.code === '23505') return true; // Postgres unique_violation -> duplicate delivery

  // Any other DB error: fail open. Better to risk an occasional duplicate
  // than to silently drop a legitimate update because of a transient DB
  // hiccup.
  console.error('isDuplicateUpdate error (failing open):', error.message);
  return false;
}

// Best-effort cleanup so the table doesn't grow forever. Not required for
// correctness (the PK dedup above works regardless of table size) — the
// webhook calls this occasionally (low probability per request) rather
// than on every request, to avoid an extra DB round-trip on the hot path.
async function pruneOldUpdates(olderThanDays = 7) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('telegram_updates').delete().lt('created_at', cutoff);
  if (error) console.error('pruneOldUpdates error:', error.message);
}

module.exports = { isDuplicateUpdate, pruneOldUpdates };
