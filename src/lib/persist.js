// src/lib/persist.js
//
// Remembers which page/tab someone was on so a browser refresh (or the
// Android app being restarted) lands them back on the same screen instead of
// the dashboard. Stored in localStorage; every read/write is guarded because
// storage can be unavailable (private mode, blocked WebView, quota).
import { useEffect, useState } from "react";

export const NAV_KEY = "sjo-active-nav";
export const DEALER_TAB_KEY = "sjo-dealer-tab";
export const MASTERS_TAB_KEY = "sjo-masters-tab";

export function readSaved(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeSaved(key, value) {
  try { localStorage.setItem(key, value); } catch { /* best-effort */ }
}

// Called on sign-out so the next person on this device starts fresh.
export function clearSavedNav() {
  try {
    [NAV_KEY, DEALER_TAB_KEY, MASTERS_TAB_KEY].forEach((k) => localStorage.removeItem(k));
  } catch { /* best-effort */ }
}

// useState that restores from / saves to localStorage. `allowed` (optional
// array) guards against a stale saved value that no longer exists.
export function usePersistedState(key, fallback, allowed) {
  const [value, setValue] = useState(() => {
    const saved = readSaved(key);
    return saved && (!allowed || allowed.includes(saved)) ? saved : fallback;
  });
  useEffect(() => { writeSaved(key, value); }, [key, value]);
  return [value, setValue];
}
