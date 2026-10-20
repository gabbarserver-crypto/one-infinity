// src/lib/presence.js
//
// Who is online right now + when they were last seen.
//
//  - ONLINE NOW  : Supabase Realtime Presence on one shared channel. Every
//                  logged-in person (staff / dealer / dealer sub-staff) tracks
//                  themselves there while the app is open; closing the tab or
//                  losing connection drops them automatically.
//  - LAST SEEN   : a heartbeat writes `last_seen` into public.user_presence
//                  (see supabase/migrations/011_user_presence.sql). If that
//                  table hasn't been created yet everything still works —
//                  you just don't get the "last seen" text.
//
// Who sees whom: staff see dealers (and dealer sub-staff); dealers and their
// sub-staff only ever see our staff.

import { useSyncExternalStore } from "react";
import { supabase } from "./supabase";

const HEARTBEAT_MS = 60_000;

let state = { online: [], rows: [] }; // online: presence payloads, rows: user_presence rows
const listeners = new Set();
const emit = () => { state = { ...state }; listeners.forEach((l) => l()); };
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const getSnapshot = () => state;

export const usePresence = () => useSyncExternalStore(subscribe, getSnapshot);

const keyOf = (type, id) => `${type}:${id}`;
const newer = (a, b) => (!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b);

// ---- status lookups (pure; pass the snapshot from usePresence()) ----------
export function statusOfKey(snap, type, id) {
  const key = keyOf(type, id);
  const online = snap.online.some((e) => e.key === key);
  const row = snap.rows.find((r) => r.user_key === key);
  return { online, lastSeen: row?.last_seen || null };
}

export function statusOfDealer(snap, dealerId) {
  if (!dealerId) return { online: false, lastSeen: null };
  const id = String(dealerId);
  const online = snap.online.some((e) => e.type !== "staff" && String(e.dealerId) === id);
  let lastSeen = null;
  for (const r of snap.rows) if (r.user_type !== "staff" && String(r.dealer_id) === id) lastSeen = newer(lastSeen, r.last_seen);
  return { online, lastSeen };
}

export function statusOfStaffTeam(snap) {
  const online = snap.online.some((e) => e.type === "staff");
  let lastSeen = null;
  for (const r of snap.rows) if (r.user_type === "staff") lastSeen = newer(lastSeen, r.last_seen);
  return { online, lastSeen };
}

// The person on the OTHER side of a thread, from the viewer's point of view.
export const statusForThread = (snap, variant, dealerId) =>
  variant === "staff" ? statusOfDealer(snap, dealerId) : statusOfStaffTeam(snap);

// "last seen today at 3:45 PM" / "yesterday at …" / "12 Oct at …"
export function formatLastSeen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (days <= 0) return `last seen today at ${time}`;
  if (days === 1) return `last seen yesterday at ${time}`;
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
  return `last seen ${date} at ${time}`;
}

export const statusText = (s) => (s.online ? "online" : formatLastSeen(s.lastSeen));

// ---- tracker --------------------------------------------------------------
async function fetchRows() {
  try {
    const { data, error } = await supabase.from("user_presence").select("user_key, user_type, dealer_id, last_seen");
    if (error) return; // table not created yet → silently no "last seen"
    const next = data || [];
    if (JSON.stringify(next) === JSON.stringify(state.rows)) return; // nothing changed → no re-render
    state.rows = next;
    emit();
  } catch { /* best-effort */ }
}

// Call once per logged-in session. Returns a stop() function.
export function startPresence(identity, dealerId) {
  if (!identity?.id || !identity?.type) return () => {};
  const key = keyOf(identity.type, identity.id);
  const myDealerId = identity.type === "dealer" ? identity.id : identity.type === "dealer_staff" ? dealerId : null;
  const payload = { key, type: identity.type, id: identity.id, name: identity.name || "", dealerId: myDealerId || null };

  const writeLastSeen = async () => {
    try {
      await supabase.from("user_presence").upsert({
        user_key: key,
        user_type: identity.type,
        user_id: String(identity.id),
        dealer_id: myDealerId ? String(myDealerId) : null,
        last_seen: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
  };

  let prevOnline = new Set();
  const channel = supabase.channel("comms-presence", { config: { presence: { key } } });

  channel.on("presence", { event: "sync" }, () => {
    const entries = Object.values(channel.presenceState()).flat().map((p) => ({ ...p }));
    const nowOnline = new Set(entries.map((e) => e.key));
    // Anyone who just dropped off: stamp their last-seen locally right away.
    const nowIso = new Date().toISOString();
    let rows = state.rows;
    prevOnline.forEach((k) => {
      if (!nowOnline.has(k) && k !== key) {
        const i = rows.findIndex((r) => r.user_key === k);
        const gone = state.online.find((e) => e.key === k);
        if (i >= 0) rows = rows.map((r, j) => (j === i ? { ...r, last_seen: nowIso } : r));
        else if (gone) rows = [...rows, { user_key: k, user_type: gone.type, dealer_id: gone.dealerId, last_seen: nowIso }];
      }
    });
    const sameOnline = entries.length === state.online.length && entries.every((e) => state.online.some((o) => o.key === e.key));
    prevOnline = nowOnline;
    if (sameOnline && rows === state.rows) return; // same people online → no re-render
    state.online = entries;
    state.rows = rows;
    emit();
  });

  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") await channel.track(payload);
  });

  writeLastSeen();
  fetchRows();
  const beat = setInterval(() => { if (document.visibilityState !== "hidden") writeLastSeen(); fetchRows(); }, HEARTBEAT_MS);
  const onHide = () => { if (document.visibilityState === "hidden") writeLastSeen(); };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", writeLastSeen);

  return () => {
    clearInterval(beat);
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", writeLastSeen);
    writeLastSeen();
    supabase.removeChannel(channel);
    state.online = [];
    emit();
  };
}
