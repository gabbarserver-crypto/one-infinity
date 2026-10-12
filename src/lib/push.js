// src/lib/push.js
//
// Real, lock-screen-capable push notifications for the native Android app —
// the piece notify.js explicitly says it can't do (see the comment at the
// top of that file). This is the "app is closed / phone is locked" half.
//
// How it fits together:
//   1. registerForPush(identity) — called once from App.jsx right after
//      sign-in — asks Android for notification permission, gets an FCM
//      device token from Google, and upserts it into the `push_tokens`
//      table (supabase/add_push_tokens.sql) against whoever's signed in.
//   2. Whenever something push-worthy happens (an incoming direct call, a
//      new chat message), the sender calls sendPush() (src/lib/serverApi.js)
//      which hits POST /api/send-push — a server function that looks up the
//      target's device token(s) and asks Firebase Cloud Messaging to deliver
//      a real Android notification. FCM delivers "notification"-shaped
//      payloads straight to the system tray via Android's own background
//      service, so this works even if the app process isn't running at
//      all — which is what actually gets it onto the lock screen.
//   3. unregisterForPush() — best-effort, called on sign-out — removes this
//      device's token so a signed-out phone stops receiving someone else's
//      notifications.
//
// No-ops entirely on web/desktop — this only ever runs inside the Capacitor
// Android shell.
import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabase";
import { requestOpenThread } from "./pushNav";
import { requestNotificationPermission } from "./notify";
import { subscribePrefs, serverPrefsPayload } from "./notificationPrefs";

let currentToken = null;
let listenersAttached = false;
// Whoever is signed in RIGHT NOW. The "registration" listener below is only
// attached once, so it must read this at event time — capturing the
// `identity` argument of the first call would save a later user's device
// token under the previous user (shared phone).
let currentIdentity = null;
let tapListenerAttached = false;
let prefsSyncAttached = false;
let prefsSyncTimer = null;

function schedulePrefsSync() {
  clearTimeout(prefsSyncTimer);
  prefsSyncTimer = setTimeout(async () => {
    if (!currentToken) return;
    try {
      await supabase.from("push_tokens").update({ notif_prefs: serverPrefsPayload() }).eq("token", currentToken);
    } catch {
      // Best-effort — the in-app toggles still apply locally.
    }
  }, 600);
}

async function loadPushPlugin() {
  try {
    return await import("@capacitor/push-notifications");
  } catch {
    return null; // plugin not present in this build — nothing to do
  }
}

// A dedicated channel for chat/draft pushes, created once per device with
// android.enableLights + a fast vibration pattern + max importance.
// (Incoming calls are handled separately — see send-push.js's data-only
// message path and the native FirebaseMessagingService — so they don't use
// this channel.) Without this, Capacitor's push-notifications plugin
// auto-creates a bare-minimum default channel on first registration — that
// default channel has no light color set (so the LED, on phones that have
// one, never turns on) and Android treats it as a lower-priority "default"
// sound rather than the punchier "urgent" one. api/send-push.js must
// target this same channel id (android.notification.channelId) for any of
// this to apply — the channel's settings are ignored otherwise.
export const CALLS_MESSAGES_CHANNEL_ID = "calls_messages";
// Used by the server (api/_lib/push.js) for pushes that arrive during this
// person's quiet hours: still shows in the tray, but IMPORTANCE_LOW means no
// sound, no vibration, no heads-up. Channel settings can't be changed after
// creation, which is why this is a second channel rather than an edit.
export const QUIET_CHANNEL_ID = "calls_messages_quiet";

async function ensureNotificationChannel(PushNotifications) {
  try {
    await PushNotifications.createChannel({
      id: QUIET_CHANNEL_ID,
      name: "Chats & Drafts (quiet hours)",
      description: "Delivered silently during your quiet hours",
      importance: 2, // IMPORTANCE_LOW — tray only, no sound
      visibility: 1,
      vibration: false,
      lights: false,
    });
  } catch {
    // Best-effort — without it, quiet-hours pushes fall back to the normal channel.
  }
  try {
    await PushNotifications.createChannel({
      id: CALLS_MESSAGES_CHANNEL_ID,
      name: "Chats & Drafts",
      description: "New chat messages and new drafts",
      importance: 5, // IMPORTANCE_MAX — heads-up + urgent sound
      visibility: 1, // VISIBILITY_PUBLIC — full content on the lock screen
      sound: "default",
      vibration: true,
      lights: true,
      lightColor: "#FF3B30",
    });
  } catch {
    // Best-effort — if this fails (e.g. very old Android without channel
    // support), the notification still arrives, just with default styling.
  }
}

// Tapping a system notification (app backgrounded/closed/open): if it
// carries a chat threadId, ask the app to open that conversation. Call once
// at app start — BEFORE sign-in — so a tap that launches the app from cold
// isn't missed; the request waits in lib/pushNav.js until the signed-in UI
// is ready. Call-type pushes are ignored here (calls have their own UI).
export async function initPushTapListener() {
  if (!Capacitor.isNativePlatform() || tapListenerAttached) return;
  tapListenerAttached = true;
  const mod = await loadPushPlugin();
  if (!mod) { tapListenerAttached = false; return; }
  mod.PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const data = action?.notification?.data || {};
    if (data.kind === "call") return;
    if (data.threadId) requestOpenThread(data.threadId);
  });
}

export async function registerForPush(identity) {
  if (!Capacitor.isNativePlatform() || !identity?.type || !identity?.id) return;
  currentIdentity = identity;

  const mod = await loadPushPlugin();
  if (!mod) return;
  const { PushNotifications } = mod;

  await ensureNotificationChannel(PushNotifications);

  // Keep this device's row in push_tokens in step with Settings -> Notifications
  // (debounced), so the server honours the toggles + quiet hours.
  if (!prefsSyncAttached) {
    prefsSyncAttached = true;
    subscribePrefs(schedulePrefsSync);
  }

  if (!listenersAttached) {
    listenersAttached = true;

    PushNotifications.addListener("registration", async (token) => {
      currentToken = token.value;
      if (!currentIdentity) return;
      try {
        await supabase.from("push_tokens").upsert(
          {
            owner_type: currentIdentity.type,
            owner_id: currentIdentity.id,
            token: token.value,
            platform: "android",
            notif_prefs: serverPrefsPayload(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "token" }
        );
      } catch {
        // Best-effort — a failed token save just means this device won't
        // get pushes until the next successful registration (e.g. next
        // app open), not a reason to interrupt sign-in.
      }
    });

    PushNotifications.addListener("registrationError", () => {
      // Nothing actionable to show the person — foreground in-app
      // notifications (notify.js) still work regardless.
    });

    // Notification taps are handled by initPushTapListener() above.
  }

  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt") perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return;
    await PushNotifications.register();
  } catch {
    // Permission denied or unsupported device — silently skip.
  }
}

export async function unregisterForPush() {
  if (!Capacitor.isNativePlatform() || !currentToken) return;
  try {
    await supabase.from("push_tokens").delete().eq("token", currentToken);
  } catch {
    // Best-effort.
  }
  currentToken = null;
  currentIdentity = null;
}

// Who this device is registered as (null on web / before sign-in). Used by the
// Settings "Test notification" button to push to itself.
export function getPushIdentity() {
  return currentIdentity;
}

const normalisePermission = (v) => (v === "granted" ? "granted" : v === "denied" ? "denied" : "prompt");

// 'granted' | 'denied' | 'prompt' | 'unsupported' — for the Settings screen.
// Native Android asks the push plugin (the real OS-level switch); a browser
// asks the Notification API.
export async function getPushPermissionStatus() {
  if (Capacitor.isNativePlatform()) {
    const mod = await loadPushPlugin();
    if (!mod) return "unsupported";
    try {
      const perm = await mod.PushNotifications.checkPermissions();
      return normalisePermission(perm.receive);
    } catch {
      return "unsupported";
    }
  }
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return normalisePermission(Notification.permission);
}

// Shows the OS permission prompt if it's still allowed to. Once the person has
// denied it (or Android has stopped asking), this returns 'denied' without a
// prompt — only the phone's Settings can flip it back.
export async function requestPushPermission() {
  if (Capacitor.isNativePlatform()) {
    const mod = await loadPushPlugin();
    if (!mod) return "unsupported";
    try {
      const perm = await mod.PushNotifications.requestPermissions();
      const status = normalisePermission(perm.receive);
      if (status === "granted" && currentIdentity) registerForPush(currentIdentity);
      return status;
    } catch {
      return "denied";
    }
  }
  const result = await requestNotificationPermission();
  return result === "unsupported" ? "unsupported" : normalisePermission(result);
}
