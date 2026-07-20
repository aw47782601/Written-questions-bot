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

// Parses an admin-supplied date/time string as Cairo LOCAL wall-clock time
// and returns the equivalent absolute instant as a UTC ISO string (safe to
// store and compare directly — no timezone math needed again once this
// conversion has happened once, at creation time).
// Accepts both the original 24-hour form ("2026-06-01 08:00") and a
// 12-hour AM/PM form ("2026-06-01 08:00 PM" / "8:00 pm"), so manually-typed
// commands keep working either way. Returns null if nothing matches.
function parseCairoLocalToUtcIso(input) {
  const raw = String(input).trim();
  const formats = ['yyyy-MM-dd HH:mm', 'yyyy-MM-dd hh:mm a', 'yyyy-MM-dd h:mm a'];
  for (const fmt of formats) {
    const dt = DateTime.fromFormat(raw, fmt, { zone: CAIRO_ZONE });
    if (dt.isValid) return dt.toUTC().toISO();
  }
  return null;
}

// Formats a stored UTC ISO timestamp back into readable Cairo local time
// (12-hour clock with AM/PM), for showing admins what a period means in
// their own clock (e.g. in /blocklist or the confirmation after /addblock).
function formatUtcIsoAsCairo(utcIso) {
  const dt = DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(CAIRO_ZONE);
  return dt.isValid ? dt.toFormat('yyyy-MM-dd hh:mm a') : utcIso;
}

// --- Helpers for the /addblock button-based date & time picker -------------

// Builds the absolute UTC ISO instant from picked Cairo-local calendar
// parts (hour24 already converted from the picked 12-hour + AM/PM choice).
function cairoPartsToUtcIso(year, month, day, hour24, minute) {
  const dt = DateTime.fromObject({ year, month, day, hour: hour24, minute }, { zone: CAIRO_ZONE });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

function daysInCairoMonth(year, month) {
  return DateTime.fromObject({ year, month, day: 1 }, { zone: CAIRO_ZONE }).daysInMonth;
}

// 0 = Sunday .. 6 = Saturday, for laying out the calendar grid — luxon's
// own .weekday is 1 = Monday .. 7 = Sunday.
function firstWeekdaySunIndex(year, month) {
  const wd = DateTime.fromObject({ year, month, day: 1 }, { zone: CAIRO_ZONE }).weekday;
  return wd % 7;
}

function arabicMonthName(month) {
  return DateTime.fromObject({ year: 2000, month, day: 1 }).setLocale('ar').toFormat('LLLL');
}

function nowCairoYearMonth() {
  const dt = DateTime.now().setZone(CAIRO_ZONE);
  return { year: dt.year, month: dt.month };
}

module.exports = {
  parseCairoLocalToUtcIso,
  formatUtcIsoAsCairo,
  cairoPartsToUtcIso,
  daysInCairoMonth,
  firstWeekdaySunIndex,
  arabicMonthName,
  nowCairoYearMonth,
  CAIRO_ZONE,
};
