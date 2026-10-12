// src/lib/pushNav.js
//
// "Open this chat" requests coming from a tapped push notification.
//
// A tap can arrive at any moment — including while the app is still starting
// up, signed out, or sitting on the PIN lock screen — so the request is kept
// in a single pending slot until the signed-in UI is ready to act on it
// (see usePushThreadOpen below), instead of being fired once and lost.
import { useEffect } from "react";
import { getThreadSummary } from "./chat";

let pending = null;
const subs = new Set();

export function requestOpenThread(threadId) {
  if (threadId === null || threadId === undefined || threadId === "") return;
  pending = { threadId: String(threadId), at: Date.now() };
  subs.forEach((fn) => fn(pending));
}

export function clearThreadTarget() {
  pending = null;
}

// Subscribes to requests; immediately replays one that arrived earlier.
export function onThreadTarget(fn) {
  subs.add(fn);
  if (pending) fn(pending);
  return () => subs.delete(fn);
}

// When `target` is set and the UI is `ready`, looks the thread up and opens
// it in the shared CommsWindow (via its ref), then calls onHandled().
// A thread the person can't access (or that no longer exists) is simply
// skipped — the app just stays where it is.
export function usePushThreadOpen({ target, ready, variant, commsRef, onHandled }) {
  useEffect(() => {
    if (!target || !ready) return;
    let cancelled = false;
    (async () => {
      let thread = null;
      try { thread = await getThreadSummary(target.threadId, variant); } catch { thread = null; }
      if (cancelled) return;
      if (thread && commsRef.current?.openThread) commsRef.current.openThread(thread);
      onHandled();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ready]);
}
