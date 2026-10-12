// src/components/BiometricOffer.jsx
import React, { useState } from "react";
import {
  authenticateBiometric,
  setBiometricEnabled,
  markBiometricOffered,
} from "../lib/biometric";

// "Also unlock with your fingerprint?" step — shown right after a PIN is
// created, or (for people who already had a PIN) right after their next
// successful PIN unlock. Enabling requires one successful fingerprint scan
// so we know it actually works on this device. onDone() is always called
// once, whether they enabled it or not.
export default function BiometricOffer({ userId, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const enable = async () => {
    setBusy(true);
    setError("");
    const ok = await authenticateBiometric("Confirm your fingerprint to enable it");
    setBusy(false);
    if (!ok) {
      setError("Couldn't verify your fingerprint — try again, or skip.");
      return;
    }
    setBiometricEnabled(userId, true);
    markBiometricOffered(userId);
    onDone(true);
  };

  const skip = () => {
    markBiometricOffered(userId);
    onDone(false);
  };

  return (
    <>
      <h2 className="text-lg font-bold text-slate-800 mb-2">Unlock with fingerprint?</h2>
      <p className="text-slate-500 text-sm mb-6">
        Use your fingerprint to open the app on this device. Your PIN still works as a backup.
      </p>
      {error && <p className="text-rose-500 text-xs mb-3">{error}</p>}
      <button
        onClick={enable}
        disabled={busy}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl mb-2"
      >
        {busy ? "Waiting…" : "Enable fingerprint"}
      </button>
      <button onClick={skip} disabled={busy} className="w-full text-slate-400 hover:text-slate-600 text-sm py-2">
        Not now
      </button>
    </>
  );
}
