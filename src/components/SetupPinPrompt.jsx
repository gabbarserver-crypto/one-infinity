// src/components/SetupPinPrompt.jsx
import React, { useState } from "react";
import { setPin, markPinPrompted } from "../lib/pinLock";
import PinPad from "./PinPad";
import BiometricOffer from "./BiometricOffer";
import { isBiometricAvailable } from "../lib/biometric";

// Shown once after a fresh full login (password/OTP/passkey), offering to
// set up a quick-unlock PIN for next time. Fully skippable — dismissing it
// marks this user as "already asked" so it doesn't nag on every login.
export default function SetupPinPrompt({ userId, onDone }) {
  const [step, setStep] = useState("offer"); // "offer" | "create" | "confirm" | "biometric"
  const [firstPin, setFirstPin] = useState("");
  const [error, setError] = useState("");

  const skip = () => {
    markPinPrompted(userId);
    onDone();
  };

  const handleFirstEntry = (pin) => {
    setFirstPin(pin);
    setStep("confirm");
  };

  // The PIN is only written once the whole flow is finished (below), so the
  // app can't swap to the unlock screen halfway through the fingerprint step.
  const finish = async (pin) => {
    await setPin(userId, pin);
    markPinPrompted(userId);
    onDone();
  };

  const handleConfirm = async (pin) => {
    if (pin !== firstPin) {
      setError("Didn't match — try again");
      setStep("create");
      setFirstPin("");
      return;
    }
    if (await isBiometricAvailable()) {
      setStep("biometric");
      return;
    }
    await finish(pin);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-8 text-center">
        {step === "offer" && (
          <>
            <h2 className="text-lg font-bold text-slate-800 mb-2">Set up a quick-unlock PIN?</h2>
            <p className="text-slate-500 text-sm mb-6">
              Next time you open the app on this device, unlock with a 4-digit PIN instead of typing your password.
            </p>
            <button
              onClick={() => setStep("create")}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl mb-2"
            >
              Set up PIN
            </button>
            <button onClick={skip} className="w-full text-slate-400 hover:text-slate-600 text-sm py-2">
              Skip for now
            </button>
          </>
        )}
        {step === "create" && (
          <>
            <h2 className="text-lg font-bold text-slate-800 mb-1">Choose a 4-digit PIN</h2>
            <p className="text-slate-400 text-xs mb-6">You'll enter it again to confirm</p>
            <PinPad length={4} onComplete={handleFirstEntry} error={error} />
            <button onClick={skip} className="text-slate-400 hover:text-slate-600 text-sm mt-6">Skip for now</button>
          </>
        )}
        {step === "biometric" && <BiometricOffer userId={userId} onDone={() => finish(firstPin)} />}
        {step === "confirm" && (
          <>
            <h2 className="text-lg font-bold text-slate-800 mb-1">Confirm your PIN</h2>
            <p className="text-slate-400 text-xs mb-6">Enter it once more</p>
            <PinPad length={4} onComplete={handleConfirm} />
            <button onClick={skip} className="text-slate-400 hover:text-slate-600 text-sm mt-6">Skip for now</button>
          </>
        )}
      </div>
    </div>
  );
}
