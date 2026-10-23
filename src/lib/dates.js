// src/lib/dates.js
//
// Business dates for this app are Indian Standard Time (IST, UTC+05:30).
//
// Why this exists: `new Date().toISOString().slice(0, 10)` gives the UTC
// calendar date, which is still "yesterday" between 00:00 and 05:30 IST --
// and `new Date(y, m, 1).toISOString()` for "first of the month" lands on
// the LAST day of the previous month, because local midnight in IST is the
// previous day in UTC. Server code (Vercel) runs in UTC, so the same
// mistake there silently dates records a day early. Everything below
// formats/derives dates in Asia/Kolkata explicitly, so the result doesn't
// depend on the device's or server's timezone.
const IST_OFFSET = "+05:30";
const istDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// "YYYY-MM-DD" for the given instant, as the calendar date in IST.
export function todayIST(now = new Date()) {
  return istDateFormat.format(now);
}

// First day of the month (IST) as "YYYY-MM-DD".
export function firstOfMonthIST(now = new Date()) {
  return `${todayIST(now).slice(0, 8)}01`;
}

// Current calendar year in IST.
export function yearIST(now = new Date()) {
  return Number(todayIST(now).slice(0, 4));
}

// Start of the given IST calendar day ("YYYY-MM-DD") as a timestamp string
// with an explicit offset -- Postgres reads a bare "...T00:00:00" as UTC,
// which is 05:30 off from the IST day boundary the user meant.
export function istDayStart(dateStr) {
  return `${dateStr}T00:00:00${IST_OFFSET}`;
}

// Start of the day AFTER dateStr (IST). Use with .lt() for an inclusive
// "up to and including dateStr" filter without fiddling with 23:59:59.
export function istNextDayStart(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.toISOString().slice(0, 10)}T00:00:00${IST_OFFSET}`;
}

// Display format used everywhere in the UI and CSV exports: DD-MM-YYYY.
// - "YYYY-MM-DD" strings (date columns) are just rearranged, no timezone maths.
// - Timestamps are shown as the IST calendar day, whatever the device's timezone.
// Returns "" for empty / invalid input.
export function fmtDate(v) {
  if (!v) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  const iso = todayIST(d);
  return `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
}
