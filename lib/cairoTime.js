const { DateTime } = require('luxon');

// Egypt has turned DST on and off multiple times over the years (most
// recently: reintroduced in 2023), currently switching between EET
// (UTC+2, winter) and EEST (UTC+3, summer). Using the IANA zone name
// 'Africa/Cairo' — rather than a hardcoded +2/+3 offset — means this stays
// correct automatically across those transitions, and would keep working
// even if Egypt changes its DST rules again in the future, since luxon
// resolves the offset from the environment's tz database at the time of
// each conversion instead of a fixed number baked into this file.
const CAIRO_ZONE = 'Africa/Cairo';

// Parses an admin-supplied "yyyy-MM-dd HH:mm" string as Cairo LOCAL
// wall-clock time and returns the equivalent absolute instant as a UTC ISO
// string (safe to store and compare directly — no timezone math needed
// again once this conversion has happened once, at creation time).
// Returns null if the input doesn't parse.
function parseCairoLocalToUtcIso(input) {
  const dt = DateTime.fromFormat(String(input).trim(), 'yyyy-MM-dd HH:mm', { zone: CAIRO_ZONE });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

// Formats a stored UTC ISO timestamp back into readable Cairo local time,
// for showing admins what a period means in their own clock (e.g. in
// /blocklist or the confirmation after /addblock).
function formatUtcIsoAsCairo(utcIso) {
  const dt = DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(CAIRO_ZONE);
  return dt.isValid ? dt.toFormat('yyyy-MM-dd HH:mm') : utcIso;
}

module.exports = { parseCairoLocalToUtcIso, formatUtcIsoAsCairo, CAIRO_ZONE };
