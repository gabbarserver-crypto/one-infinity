// src/pages/PinUnlock.jsx
import React, { useEffect, useRef, useState } from "react";
import { verifyPin } from "../lib/pinLock";
import {
  isBiometricAvailable,
  isBiometricEnabled,
  hasBeenOfferedBiometric,
  authenticateBiometric,
} from "../lib/biometric";
import PinPad from "../components/PinPad";
import BiometricOffer from "../components/BiometricOffer";
import logo from "../assets/one-infinity-logo-full.png";

// Shown instead of the normal Dashboard/DealerPortal when a valid Supabase
// session already exists on this device AND a PIN has been set up for
// this user — a quick "unlock" gate rather than a full re-login. Getting
// the PIN wrong doesn't touch Supabase at all (it's a local check), so
// there's no lockout/rate-limit concern from repeated tries — the actual
// account security still rests on the underlying login.
//
// If fingerprint unlock is enabled (native app only) the system prompt opens
// automatically; cancelling it just leaves the PIN pad to use instead.
export default function PinUnlock({ userId, userLabel, onUnlocked, onSignOut }) {
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [bioReady, setBioReady] = useState(false);
  const [offering, setOffering] = useState(false);
  const autoTried = useRef(false);

  const tryBiometric = async () => {
    const ok = await authenticateBiometric("Unlock with your fingerprint");
    if (ok) onUnlocked();
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isBiometricEnabled(userId)) return;
      if (!(await isBiometricAvailable())) return;
      if (cancelled) return;
      setBioReady(true);
      if (!autoTried.current) {
        autoTried.current = true;
        setTimeout(() => { if (!cancelled) tryBiometric(); }, 300); // let the screen settle so the prompt can attach
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleComplete = async (pin) => {
    setChecking(true);
    const ok = await verifyPin(userId, pin);
    if (!ok) {
      setChecking(false);
      setError("Incorrect PIN");
      return;
    }
    // Correct PIN. If this device supports fingerprint and they haven't been
    // asked yet (or never turned it on), offer it once before unlocking.
    if (!isBiometricEnabled(userId) && !hasBeenOfferedBiometric(userId) && (await isBiometricAvailable())) {
      setChecking(false);
      setOffering(true);
      return;
    }
    setChecking(false);
    onUnlocked();
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-8 shadow-sm border border-slate-100 text-center">
        {offering ? (
          <BiometricOffer userId={userId} onDone={() => onUnlocked()} />
        ) : (
          <>
            <img src={logo} alt="One Infinity" className="w-full max-w-[200px] mx-auto mb-4" />
            <p className="text-slate-500 text-sm mb-1">Welcome back,</p>
            <p className="text-slate-800 font-semibold mb-6">{userLabel}</p>

            <PinPad length={4} onComplete={handleComplete} error={error} disabled={checking} />

            {bioReady && (
              <button
                type="button"
                onClick={tryBiometric}
                className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700"
              >
                <span aria-hidden="true">☝️</span> Use fingerprint
              </button>
            )}

            <div>
              <button onClick={onSignOut} className="text-xs text-slate-400 hover:text-slate-600 mt-6">
                Not you, or forgot your PIN? Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
