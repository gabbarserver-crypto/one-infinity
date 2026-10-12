// api/_lib/push.js
//
// Core "send a push via FCM" logic, shared by:
//   - api/send-push.js — the client-facing endpoint (dealer/staff already
//     signed in, calls this after resolveCaller() checks their token)
//   - server-to-server callers like api/payments/webhook.js, which run with
//     no signed-in user at all (Cashfree calls that endpoint directly) but
//     already hold the service-role key, so there's nothing left to check.
//
// Pulled out of send-push.js so the webhook doesn't have to fake an
// accessToken just to reach the same FCM-sending code.
import { supabaseAdmin } from "./adminAuth.js";

// Must match src/lib/push.js (QUIET_CHANNEL_ID): a low-importance channel, so a
// push sent here shows in the tray with no sound / vibration / heads-up.
const LOUD_CHANNEL_ID = "calls_messages";
const QUIET_CHANNEL_ID = "calls_messages_quiet";

// Settings -> Notifications saves { types, quiet:{enabled,start,end}, tz } on
// each device's push_tokens row (notif_prefs). 'payment_qr' follows 'payment'.
const prefKeyForKind = (kind) => (kind === "payment_qr" ? "payment" : kind);

function minutesNowIn(tz) {
  const read = (zone) => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    return Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
  };
  try { return read(tz || "Asia/Kolkata"); } catch { return read("Asia/Kolkata"); }
}

function inQuietHours(prefs) {
  const q = prefs?.quiet;
  if (!q?.enabled || !/^\d\d:\d\d$/.test(q.start || "") || !/^\d\d:\d\d$/.test(q.end || "")) return false;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s = toMin(q.start);
  const e = toMin(q.end);
  if (s === e) return false;
  const n = minutesNowIn(prefs.tz);
  return s < e ? n >= s && n < e : n >= s || n < e;
}

let firebaseApp = null;
async function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const { default: admin } = await import("firebase-admin");
  if (admin.apps.length) {
    firebaseApp = admin.apps[0];
    return firebaseApp;
  }
  const serviceAccount = JSON.parse(raw);
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return firebaseApp;
}

// targetType: 'staff' | 'dealer' | 'dealer_staff' + targetId, OR
// targetType: 'all_staff' to broadcast to every staff device.
// Returns { sent, failed, reason? } — never throws; a push failure should
// never break whatever real action triggered it.
export async function sendPushNotification({ targetType, targetId, title, body, data }) {
  try {
    if (!supabaseAdmin) return { sent: 0, failed: 0, reason: "Server isn't configured with SUPABASE_SERVICE_ROLE_KEY" };
    if (!targetType || (!targetId && targetType !== "all_staff")) return { sent: 0, failed: 0, reason: "targetType/targetId required" };
    if (!title) return { sent: 0, failed: 0, reason: "title required" };

    const buildQuery = (columns) => {
      const q = supabaseAdmin.from("push_tokens").select(columns);
      return targetType === "all_staff" ? q.eq("owner_type", "staff") : q.eq("owner_type", targetType).eq("owner_id", targetId);
    };
    let { data: rows, error } = await buildQuery("token, notif_prefs");
    // sql/push_token_notif_prefs.sql not run yet -> behave as before (everything on).
    if (error && /notif_prefs/.test(error.message || "")) ({ data: rows, error } = await buildQuery("token"));
    if (error) return { sent: 0, failed: 0, reason: error.message };

    const devices = (rows || []).map((r) => ({ token: r.token, prefs: r.notif_prefs || null }));
    if (!devices.length) return { sent: 0, failed: 0, reason: "No registered device for this target" };

    // Per-device Settings -> Notifications: skip devices that switched this kind
    // off. A "test" push ignores the switches — it exists to prove delivery works.
    const kind = data?.kind;
    const prefKey = prefKeyForKind(kind);
    const wanted = kind === "test" ? devices : devices.filter((d) => d.prefs?.types?.[prefKey] !== false);
    if (!wanted.length) return { sent: 0, failed: 0, reason: "Recipient has turned this notification type off" };

    const app = await getFirebaseApp();
    if (!app) return { sent: 0, failed: 0, reason: "FIREBASE_SERVICE_ACCOUNT not configured on the server yet" };

    const { default: admin } = await import("firebase-admin");

    // Calls need a data-only message (see send-push.js's longer comment on
    // this) -- everything else (chat, drafts, payments) uses a normal
    // notification block.
    const isCall = kind === "call";

    // Quiet hours: chat / draft / payment arrive on the silent channel. Calls and
    // test pushes are exempt (a missed call is worse than a night-time ring).
    const exemptFromQuiet = isCall || kind === "test";
    const groups = [
      { quiet: false, tokens: wanted.filter((d) => exemptFromQuiet || !inQuietHours(d.prefs)).map((d) => d.token) },
      { quiet: true, tokens: exemptFromQuiet ? [] : wanted.filter((d) => inQuietHours(d.prefs)).map((d) => d.token) },
    ].filter((g) => g.tokens.length);

    let sent = 0;
    let failed = 0;
    const deadTokens = [];

    for (const group of groups) {
      const message = {
        tokens: group.tokens,
        ...(isCall ? {} : { notification: { title, body: body || "" } }),
        data: {
          ...Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
          ...(isCall ? { title, body: body || "" } : {}),
        },
        android: {
          priority: "high",
          ...(isCall ? { ttl: 30000 } : {}),
          ...(isCall
            ? {}
            : group.quiet
              ? {
                  notification: {
                    channelId: QUIET_CHANNEL_ID,
                    priority: "low",
                    visibility: "public",
                    defaultVibrateTimings: false,
                  },
                }
              : {
                  notification: {
                    channelId: LOUD_CHANNEL_ID,
                    priority: "max",
                    visibility: "public",
                    defaultVibrateTimings: false,
                    vibrateTimingsMillis: [0, 250, 150, 250],
                    lightSettings: {
                      color: { red: 1, green: 0.23, blue: 0.18, alpha: 1 },
                      lightOnDurationMillis: 300,
                      lightOffDurationMillis: 300,
                    },
                  },
                }),
        },
      };

      const result = await admin.messaging().sendEachForMulticast(message);
      sent += result.successCount;
      failed += result.failureCount;
      result.responses.forEach((r, i) => {
        if (!r.success && /registration-token-not-registered/.test(r.error?.code || "")) deadTokens.push(group.tokens[i]);
      });
    }

    if (deadTokens.length) await supabaseAdmin.from("push_tokens").delete().in("token", deadTokens);
    return { sent, failed };
  } catch (e) {
    console.error("sendPushNotification failed:", e);
    return { sent: 0, failed: 0, reason: e.message || "Unexpected error" };
  }
}
