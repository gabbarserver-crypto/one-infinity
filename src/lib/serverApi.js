// src/lib/serverApi.js
// Talks to the login-creation endpoints — deployed as Vercel Serverless
// Functions under /api (see /api/admin/create-dealer-login.js and
// /api/create-dealer-staff-login.js at the project root), which run
// alongside the frontend on the same Vercel deployment.
//
// Defaulting to "" (same-origin) is correct on the web/PWA, where the page
// really is served from the Vercel domain. It is NOT correct inside the
// Capacitor Android app: that WebView's origin is Capacitor's own local
// sandbox (https://localhost), which has no real server behind it — any
// relative "/api/..." fetch there gets silently intercepted by Capacitor
// (shouldInterceptRequest) and handed back the app's own index.html
// (200 OK, Content-Type: text/html) instead of ever reaching Vercel. The
// caller then gets `{}` back with no thrown error, so every field (token,
// appId, uid, etc.) is undefined — which is what was crashing the Agora
// SDK's client.join()/setAppId() deep inside a .replace() call with an
// opaque "Cannot read properties of undefined" TypeError, on every single
// call attempt from the APK, while the web/PWA build worked fine.
//
// window.Capacitor is only present inside the native wrapper, never in a
// normal browser tab, so it's a reliable way to tell the two apart without
// needing a separate env var per platform.
import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabase";

const REAL_BACKEND_ORIGIN = "https://www.1infinity.online"; // primary host in Vercel → Domains

function resolveServerApiBase() {
  // NOTE: window.Capacitor exists in normal browsers too, so use isNativePlatform().
  if (!Capacitor.isNativePlatform()) return ""; // web/PWA: same-origin
  return import.meta.env.VITE_SERVER_API_BASE || REAL_BACKEND_ORIGIN;
}

export const SERVER_API_BASE = resolveServerApiBase();

async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

async function post(path, body) {
  const res = await fetch(`${SERVER_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Staff-only: creates a dealer's primary login and links it to their record.
export async function createDealerLogin({ dealerId, email, password }) {
  return post("/api/admin/create-dealer-login", { accessToken: await accessToken(), dealerId, email, password });
}

// Staff, or the dealer themself for their own dealerId: creates a sub-staff
// login under that dealer.
export async function createDealerStaffLogin({ dealerId, fullName, email, password }) {
  return post("/api/create-dealer-staff-login", { accessToken: await accessToken(), dealerId, fullName, email, password });
}

// Fire-and-forget: asks the server to push a real (lock-screen-capable)
// notification to a target identity's registered device(s) — see
// api/send-push.js. Never throws — a failed push shouldn't break whatever
// in-app action triggered it (sending a message, ringing someone).
export async function sendPush({ targetType, targetId, title, body, data }) {
  try {
    await post("/api/send-push", { accessToken: await accessToken(), targetType, targetId, title, body, data });
  } catch {
    // Best-effort — the in-app realtime notification (notify.js) still
    // covers the case where the recipient's app is actually open.
  }
}

// Settings -> "Test notification": pushes a real notification to the signed-in
// person's own registered device(s) and, unlike sendPush(), RETURNS the result
// so the screen can say what happened: { sent, failed } or { sent: 0, reason }
// or { error }. Never throws.
export async function sendTestPush({ targetType, targetId }) {
  try {
    return await post("/api/send-push", {
      accessToken: await accessToken(),
      targetType,
      targetId,
      title: "Test notification",
      body: "If you can see this, push notifications are working on this phone.",
      data: { kind: "test" },
    });
  } catch (e) {
    return { error: e.message || "Could not send the test notification" };
  }
}

// A dealer (or their active sub-staff), or staff on a dealer's behalf, asks
// for a UPI QR to pay a specific amount -- see api/payments/create-qr.js.
// Returns { qrRequestId, qrImageUrl, qrRawString, expiresAt, cfOrderId }.
// Nothing lands in `payments` from this call alone -- that only happens
// once Cashfree's webhook confirms the money actually moved.
export async function createPaymentQr({ dealerId, applicationId, amount, minutesValid }) {
  return post("/api/payments/create-qr", { accessToken: await accessToken(), dealerId, applicationId, amount, minutesValid });
}

// Token to join an Agora call. The server checks the caller is actually
// allowed on the call:
//   - thread call:  pass { threadId } -- must be a thread you belong to.
//   - direct call:  pass { sessionId, peerType, peerId } -- the server
//     derives the channel name and returns it as `channel`; join THAT one.
// Returns { token, appId, uid, channel }.
export async function fetchAgoraToken({ threadId, sessionId, peerType, peerId }) {
  return post("/api/agora-token", { accessToken: await accessToken(), threadId, sessionId, peerType, peerId });
}

// Marks the caller's side ('staff' or 'dealer', dealer_staff folded into
// 'dealer') as having read a thread up to now, and returns both sides'
// last_read_at — ChatPanel uses this to color its double-ticks blue.
// Pass markRead: false for a status-only check that doesn't bump your own
// read time.
export async function chatReadReceipt({ threadId, markRead = true }) {
  return post("/api/chat/read-receipt", { accessToken: await accessToken(), threadId, markRead });
}

// True personal "unread since I opened it" counts — see
// api/chat/unread-summary.js. Returns { counts: { [threadId]: number },
// totalUnreadThreads }. Unlike lib/chat.js's countOpenThreads()/
// listRecentThreadsForStaff()'s unreadCount (an "awaiting reply"
// heuristic), this is driven by this specific caller's own
// chat_thread_reads_by_identity row per thread, so it actually clears once
// they've opened a thread.
export async function chatUnreadSummary() {
  return post("/api/chat/unread-summary", { accessToken: await accessToken() });
}

// One-time code for opening the Games app signed in, instead of putting the
// session tokens in its URL. See api/games-handoff.js. Returns { code }.
export async function createGamesHandoffCode({ refreshToken }) {
  return post("/api/games-handoff", { action: "create", accessToken: await accessToken(), refreshToken });
}
