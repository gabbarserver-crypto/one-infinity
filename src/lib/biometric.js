// src/lib/biometric.js
//
// Fingerprint / face unlock for the PIN lock screen — a convenience shortcut
// that sits ALONGSIDE the PIN (the PIN always remains as the fallback).
// Same trust model as the PIN itself: it only gates whether the
// already-logged-in app is shown on THIS device; it doesn't replace the login.
//
// Native (Android) app only. On the web build there's no device biometric
// API here (web users have passkeys for that), so everything below quietly
// reports "not available" and the PIN screen looks exactly as before.
import { Capacitor } from "@capacitor/core";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";

const ENABLED_PREFIX = "sjo-bio-enabled:";
const OFFERED_PREFIX = "sjo-bio-offered:";

export async function isBiometricAvailable() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const info = await BiometricAuth.checkBiometry();
    return !!info?.isAvailable;
  } catch {
    return false;
  }
}

// Shows the system fingerprint prompt. Resolves true on success, false if
// the user cancelled / it failed — never throws.
export async function authenticateBiometric(reason = "Unlock One Infinity") {
  try {
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: "Use PIN",
      allowDeviceCredential: false, // fingerprint/face only — the PIN is our own fallback
      androidTitle: "Unlock One Infinity",
      androidSubtitle: reason,
      androidConfirmationRequired: false,
    });
    return true;
  } catch {
    return false;
  }
}

export function isBiometricEnabled(userId) {
  return !!localStorage.getItem(ENABLED_PREFIX + userId);
}

export function setBiometricEnabled(userId, on) {
  if (on) localStorage.setItem(ENABLED_PREFIX + userId, "1");
  else localStorage.removeItem(ENABLED_PREFIX + userId);
}

export function hasBeenOfferedBiometric(userId) {
  return !!localStorage.getItem(OFFERED_PREFIX + userId);
}

export function markBiometricOffered(userId) {
  localStorage.setItem(OFFERED_PREFIX + userId, "1");
}
