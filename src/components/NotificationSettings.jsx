// src/components/NotificationSettings.jsx
//
// The "Notifications" tab on the Settings page.
//   - Alert types: separate on/off for chat, draft, payment and call.
//   - Quiet hours: sound off between two times (calls still ring).
//   - Test notification: checks the OS permission first; if notifications are
//     blocked it says so instead of pretending to work.
//   - Sound on/off + ring tone (lib/notificationSound.js).
// Everything is saved per device (localStorage) the moment it changes — no
// save button — and lib/push.js copies the toggles + quiet hours to this
// device's push_tokens row so the server honours them when the app is closed.
import React, { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Card } from "./UI";
import { useNotificationSound, NOTIFICATION_TONES } from "../lib/notificationSound";
import { useNotificationPrefs, NOTIF_TYPES, setTypeEnabled, setQuiet, isQuietNow } from "../lib/notificationPrefs";
import { previewTone, notify } from "../lib/notify";
import { getPushPermissionStatus, requestPushPermission, getPushIdentity } from "../lib/push";
import { sendTestPush } from "../lib/serverApi";

function Toggle({ checked, onChange, label, hint, disabled = false }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">{label}</p>
        {hint && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          checked ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-700"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}

const timeInputClass =
  "rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-3 py-2 text-sm disabled:opacity-50";

// Shown when the OS / browser has notifications switched off for this app.
function PermissionBanner({ status, onAllow }) {
  if (status === "granted" || status === null) return null;
  const native = Capacitor.isNativePlatform();

  if (status === "denied") {
    return (
      <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30 px-4 py-3">
        <p className="text-sm font-semibold text-red-700 dark:text-red-300">
          {native ? "Phone settings me notifications blocked hain" : "Browser me notifications blocked hain"}
        </p>
        <p className="text-xs text-red-600/80 dark:text-red-300/80 mt-1">
          {native
            ? "Phone Settings → Apps → One Infinity → Notifications me jaakar allow karein, phir yahan wapas aayein."
            : "Address bar ke lock icon par click karke Notifications ko Allow karein, phir page reload karein."}{" "}
          Jab tak yeh blocked hai, neeche ke switches se kuch fark nahi padega.
        </p>
      </div>
    );
  }

  if (status === "unsupported") {
    return (
      <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900 px-4 py-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          This device can't show system notifications — you'll still get in-app alerts while the app is open.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30 px-4 py-3 flex items-center justify-between gap-3">
      <p className="text-sm text-amber-800 dark:text-amber-300">Notifications abhi allow nahi hain.</p>
      <button
        type="button"
        onClick={onAllow}
        className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white transition-colors"
      >
        Allow
      </button>
    </div>
  );
}

export default function NotificationSettings() {
  const { enabled, tone, setEnabled, setTone } = useNotificationSound();
  const prefs = useNotificationPrefs();

  const [permission, setPermission] = useState(null); // 'granted' | 'denied' | 'prompt' | 'unsupported' | null (still checking)
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // { ok: boolean, text: string }

  const refreshPermission = useCallback(async () => {
    setPermission(await getPushPermissionStatus());
  }, []);

  // Re-check when the person comes back from the phone's Settings app.
  useEffect(() => {
    refreshPermission();
    const onVisible = () => { if (document.visibilityState === "visible") refreshPermission(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshPermission);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshPermission);
    };
  }, [refreshPermission]);

  const allow = async () => {
    setPermission(await requestPushPermission());
  };

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      let status = await getPushPermissionStatus();
      if (status === "prompt") status = await requestPushPermission();
      setPermission(status);

      if (status === "denied") {
        setResult({
          ok: false,
          text: Capacitor.isNativePlatform()
            ? "Phone settings me notifications blocked hain — pehle unhe allow karein."
            : "Browser me notifications blocked hain — pehle unhe allow karein.",
        });
        return;
      }

      // In-app toast + sound (sound still follows the master sound switch).
      notify({ kind: "test", title: "Test notification", body: "This is how an in-app alert looks and sounds." });

      if (Capacitor.isNativePlatform()) {
        const id = getPushIdentity();
        if (!id) {
          setResult({ ok: false, text: "This phone isn't registered for push yet. Sign out, sign in again, and retry." });
          return;
        }
        const r = await sendTestPush({ targetType: id.type, targetId: id.id });
        if (r?.sent > 0) {
          setResult({ ok: true, text: `System notification sent to ${r.sent} device${r.sent > 1 ? "s" : ""}. It should appear in your notification tray — lock the phone and run it once more to check the lock screen.` });
        } else {
          setResult({ ok: false, text: r?.error || r?.reason || "The server accepted the request but no device received it." });
        }
      } else if (status === "granted") {
        try {
          new Notification("Test notification", { body: "If you can see this, browser notifications are working." });
          setResult({ ok: true, text: "Browser notification sent." });
        } catch {
          setResult({ ok: false, text: "In-app alert shown, but this browser couldn't raise a system notification." });
        }
      } else {
        setResult({ ok: true, text: "In-app alert shown. System notifications aren't supported on this device." });
      }
    } finally {
      setTesting(false);
    }
  };

  const quietNow = isQuietNow();

  return (
    <div className="max-w-xl">
      <p className="text-sm text-slate-400 dark:text-slate-500 mb-5">
        Choose which alerts you get, silence sound at night, and check that notifications actually reach this device.
      </p>

      <PermissionBanner status={permission} onAllow={allow} />

      <Card title="Test notification" className="mb-5">
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">
          Sends a notification to this device right now. If notifications are blocked in the phone's settings, you'll see that here instead.
        </p>
        <button
          type="button"
          onClick={runTest}
          disabled={testing}
          className="btn-accent inline-flex items-center justify-center text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          {testing ? "Sending…" : "Send test notification"}
        </button>
        {result && (
          <p
            role="status"
            className={`text-xs mt-3 ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
          >
            {result.text}
          </p>
        )}
      </Card>

      <Card title="What to notify me about" className="mb-5">
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {NOTIF_TYPES.map((t) => (
            <Toggle
              key={t.key}
              label={t.label}
              hint={t.hint}
              checked={prefs.types[t.key]}
              onChange={(v) => setTypeEnabled(t.key, v)}
            />
          ))}
        </div>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
          Applies to this device only. A switched-off kind shows no toast, plays no sound and sends no push here. An incoming-call screen still appears on screen even with Call off.
        </p>
      </Card>

      <Card title="Quiet hours" className="mb-5">
        <Toggle
          label="Mute sound at night"
          hint="Chat, draft and payment alerts still arrive, just without sound. Calls always ring."
          checked={prefs.quiet.enabled}
          onChange={(v) => setQuiet({ enabled: v })}
        />
        <div className="flex flex-wrap items-center gap-3 mt-2">
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            From{" "}
            <input
              type="time"
              value={prefs.quiet.start}
              disabled={!prefs.quiet.enabled}
              onChange={(e) => setQuiet({ start: e.target.value })}
              className={`${timeInputClass} ml-1`}
            />
          </label>
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            To{" "}
            <input
              type="time"
              value={prefs.quiet.end}
              disabled={!prefs.quiet.enabled}
              onChange={(e) => setQuiet({ end: e.target.value })}
              className={`${timeInputClass} ml-1`}
            />
          </label>
        </div>
        {prefs.quiet.enabled && (
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
            {prefs.quiet.start === prefs.quiet.end
              ? "Start and end are the same, so quiet hours are not active."
              : quietNow
                ? "Quiet hours are active right now — new alerts are silent."
                : "Outside quiet hours right now — alerts will play sound."}
          </p>
        )}
      </Card>

      <Card className="mb-5">
        <Toggle
          label="Notification sound"
          checked={enabled}
          onChange={setEnabled}
          hint={enabled ? "Sounds will play for new activity and incoming calls." : "Muted — you'll still see in-app and on-screen alerts, just without sound."}
        />
      </Card>

      <Card title="Notification ring">
        <div className="space-y-2">
          {Object.entries(NOTIFICATION_TONES).map(([key, def]) => (
            <div
              key={key}
              onClick={() => setTone(key)}
              className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${
                tone === key
                  ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30"
                  : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                    tone === key ? "border-blue-600 bg-blue-600" : "border-slate-300 dark:border-slate-600"
                  }`}
                />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{def.label}</span>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); previewTone(def); }}
                className="text-xs font-semibold px-3 py-1.5 rounded-md bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-700 transition-colors"
              >
                ▶ Preview
              </button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
