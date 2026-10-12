// api/send-push.js
//
// Vercel Serverless Function — the client-facing entry point for sending a
// real push notification. Verifies whoever's calling is actually signed in
// (resolveCaller), then hands off to _lib/push.js's sendPushNotification(),
// which is the actual FCM-sending logic — shared with server-to-server
// callers like api/payments/webhook.js that have no signed-in user to
// check at all.
//
// Body: { accessToken, targetType, targetId, title, body, data }
//   targetType/targetId — 'staff' | 'dealer' | 'dealer_staff' + that row's id,
//   OR targetType: 'all_staff' to broadcast to every staff device (used for
//   "a dealer sent a message" — any staff member might pick it up).
//
// Required Vercel env vars (Project Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (already set for the login endpoints)
//   FIREBASE_SERVICE_ACCOUNT                  (see below — not set yet)
//
// FIREBASE_SERVICE_ACCOUNT: the JSON key for a Firebase service account with
// permission to send via FCM for the sharmajikaoffice-242eb project
// (android/app/google-services.json). Get it from:
//   Firebase Console → Project Settings → Service Accounts → Generate new
//   private key
// That downloads a .json file — paste its ENTIRE contents as the value of
// this env var (Vercel handles multi-line values fine). Nothing will send
// until this is set; every other piece (token capture, the DB table, the
// Android manifest/gradle wiring) is already in place.
import { resolveCaller, supabaseAdmin } from "./_lib/adminAuth.js";
import { canReach, callerCanAccessThread, isSafeId, PEER_TABLES } from "./_lib/access.js";
import { applyCors } from "./_lib/cors.js";
import { sendPushNotification } from "./_lib/push.js";

// Only these notification kinds may be requested by a client. "payment" is
// sent by the Cashfree webhook on the server side (it calls
// sendPushNotification directly and never goes through this endpoint).
// "payment_qr" is only ever sent by staff.
// "draft" is the new-draft-submitted notice (own kind so it has its own toggle
// in Settings). "test" is the Settings "Test notification" button — it may only
// ever target the caller's own device(s), see below.
const CLIENT_KINDS = new Set(["chat", "draft", "call", "payment_qr", "test"]);
const STAFF_ONLY_KINDS = new Set(["payment_qr"]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return; // preflight handled

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!supabaseAdmin) return res.status(500).json({ error: "Server isn't configured with SUPABASE_SERVICE_ROLE_KEY" });

  try {
    const { accessToken, targetType, targetId, title, body, data } = req.body || {};
    if (!targetType || (!targetId && targetType !== "all_staff")) {
      return res.status(400).json({ error: "targetType and targetId are required" });
    }
    if (!title) return res.status(400).json({ error: "title is required" });

    const caller = await resolveCaller(accessToken);
    if (!caller) return res.status(403).json({ error: "Not signed in" });

    if (typeof title !== "string" || (body != null && typeof body !== "string")) {
      return res.status(400).json({ error: "title and body must be strings" });
    }
    if (targetType !== "all_staff" && !Object.prototype.hasOwnProperty.call(PEER_TABLES, targetType)) {
      return res.status(400).json({ error: "Unknown targetType" });
    }
    if (targetType !== "all_staff" && !isSafeId(targetId)) {
      return res.status(400).json({ error: "Invalid targetId" });
    }

    // Who may this caller notify? Staff: anyone. Dealer / dealer_staff:
    // admin staff only (what the app itself ever does). A "test" push is the
    // one exception: it is allowed only to yourself (checked below).
    const isTest = data?.kind === "test";
    if (isTest) {
      if (caller.kind !== targetType || String(caller.id) !== String(targetId)) {
        return res.status(403).json({ error: "A test notification can only be sent to yourself" });
      }
    } else if (!canReach(caller, targetType, targetId)) {
      return res.status(403).json({ error: "Not allowed to notify this recipient" });
    }

    // Client-supplied `data` is reduced to a whitelist. In particular a
    // data-only "call" message makes the recipient's phone ring like a real
    // incoming call, so `kind` must be a known value and a thread reference
    // must be one the caller actually belongs to.
    const kind = data?.kind;
    if (!CLIENT_KINDS.has(kind)) return res.status(400).json({ error: "Unsupported notification kind" });
    if (STAFF_ONLY_KINDS.has(kind) && caller.kind !== "staff") {
      return res.status(403).json({ error: "Not allowed to send this kind of notification" });
    }
    const safeData = { kind };
    if (data?.threadId != null) {
      if (!(await callerCanAccessThread(caller, data.threadId))) {
        return res.status(403).json({ error: "Not allowed to reference this thread" });
      }
      safeData.threadId = String(data.threadId);
    }

    const result = await sendPushNotification({ targetType, targetId, title: title.slice(0, 120), body: (body || "").slice(0, 500), data: safeData });
    if (result.reason && result.sent === 0 && result.failed === 0) {
      return res.json({ sent: 0, reason: result.reason });
    }
    return res.json({ sent: result.sent, failed: result.failed });
  } catch (e) {
    console.error("send-push failed:", e);
    return res.status(500).json({ error: e.message || "Unexpected server error" });
  }
}
