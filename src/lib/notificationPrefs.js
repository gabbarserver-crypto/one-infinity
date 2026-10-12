// src/lib/notificationPrefs.js
//
// Per-device notification preferences: which kinds of alerts are on
// (chat / draft / payment / call) and "quiet hours" (sound off at night).
// Same tiny global-store pattern as notificationSound.js — persisted in
// localStorage, no provider needed.
//
// Two consumers:
//   - lib/notify.js reads these for IN-APP alerts (toast + sound).
//   - lib/push.js copies them to this device's push_tokens row, so the
//     SERVER (api/_lib/push.js) can skip a disabled kind and send quiet-hours
//     pushes on a silent channel, even when the app is closed.
import { useEffect, useState } from "react";

const KEY = "sjo-notif-prefs-v1";

export const NOTIF_TYPES = [
  { key: "chat", label: "Chat", hint: "New chat messages" },
  { key: "draft", label: "Draft", hint: "A dealer submits a new draft application" },
  { key: "payment", label: "Payment", hint: "A QR payment is received" },
  { key: "call", label: "Call", hint: "Incoming calls (ring + alert)" },
];

const DEFAULTS = {
  types: { chat: true, draft: true, payment: true, call: true },
  quiet: { enabled: false, start: "22:00", end: "07:00" },
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function load() {
  const base = { types: { ...DEFAULTS.types }, quiet: { ...DEFAULTS.quiet } };
  if (typeof window === "undefined") return base;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "null");
    if (raw?.types) for (const k of Object.keys(base.types)) if (typeof raw.types[k] === "boolean") base.types[k] = raw.types[k];
    if (raw?.quiet) {
      if (typeof raw.quiet.enabled === "boolean") base.quiet.enabled = raw.quiet.enabled;
      if (TIME_RE.test(raw.quiet.start || "")) base.quiet.start = raw.quiet.start;
      if (TIME_RE.test(raw.quiet.end || "")) base.quiet.end = raw.quiet.end;
    }
  } catch {
    // corrupt value — fall back to defaults
  }
  return base;
}

let prefs = load();
const listeners = new Set();

function commit() {
  try { window.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage full/blocked — keep in memory */ }
  listeners.forEach((cb) => cb(prefs));
}

export function getPrefs() {
  return prefs;
}

export function subscribePrefs(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setTypeEnabled(key, value) {
  if (!(key in prefs.types)) return;
  prefs = { ...prefs, types: { ...prefs.types, [key]: !!value } };
  commit();
}

export function setQuiet(patch) {
  const next = { ...prefs.quiet };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (TIME_RE.test(patch.start || "")) next.start = patch.start;
  if (TIME_RE.test(patch.end || "")) next.end = patch.end;
  prefs = { ...prefs, quiet: next };
  commit();
}

// 'payment_qr' (the dealer-side "QR sent" push) follows the Payment toggle.
// Kinds this file doesn't know about (e.g. 'test') are never blocked.
export function prefKeyForKind(kind) {
  return kind === "payment_qr" ? "payment" : kind;
}

export function isTypeEnabled(kind) {
  const key = prefKeyForKind(kind);
  return key in prefs.types ? prefs.types[key] : true;
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// True when `now` falls inside the quiet window. Handles windows that cross
// midnight (22:00 -> 07:00). Start === end means "no window".
export function isQuietNow(now = new Date()) {
  const q = prefs.quiet;
  if (!q.enabled) return false;
  const s = toMinutes(q.start);
  const e = toMinutes(q.end);
  if (s === e) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return s < e ? n >= s && n < e : n >= s || n < e;
}

// What gets stored next to this device's push token. The server evaluates the
// quiet window itself, so it needs the device's timezone.
export function serverPrefsPayload() {
  let tz = "Asia/Kolkata";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* keep default */ }
  return { types: { ...prefs.types }, quiet: { ...prefs.quiet }, tz };
}

export function useNotificationPrefs() {
  const [state, setState] = useState(prefs);
  useEffect(() => subscribePrefs(setState), []);
  return state;
}
