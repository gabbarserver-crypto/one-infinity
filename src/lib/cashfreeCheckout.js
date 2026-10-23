// src/lib/cashfreeCheckout.js
//
// Fallback path for when api/payments/create-qr.js couldn't get an embedded
// UPI QR from Cashfree (their "Order Pay" API needs separate approval on
// some accounts -- see the comment in create-qr.js) but DID create the
// order, so it returned a `paymentSessionId` instead. This loads Cashfree's
// hosted-checkout SDK and opens their own payment page for that session --
// no special approval needed for this path, and their page offers UPI QR,
// UPI intent, cards, netbanking, etc. on its own.
//
// Used by QrPaymentPanel.jsx and DealerPortal.jsx's TopUpModal whenever
// qrImageUrl comes back null from create-qr.js.

import { Capacitor } from "@capacitor/core";

const SDK_URL = "https://sdk.cashfree.com/js/v3/cashfree.js";

let sdkPromise = null;

function loadScript() {
  if (window.Cashfree) return Promise.resolve(window.Cashfree);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => (window.Cashfree ? resolve(window.Cashfree) : reject(new Error("Cashfree checkout script loaded but window.Cashfree is missing")));
    script.onerror = () => reject(new Error("Could not load the Cashfree checkout script"));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

// Opens Cashfree's hosted checkout page for this order in a new tab, so the
// caller's own tab keeps running (e.g. its Realtime "waiting for payment"
// subscription on payment_qr_requests keeps listening -- webhook.js fires
// the same way regardless of which page the dealer actually paid from).
export async function openCashfreeHostedCheckout({ paymentSessionId, mode = "sandbox", redirectTarget = "_blank" }) {
  const CashfreeCtor = await loadScript();
  const cashfree = CashfreeCtor({ mode });
  return cashfree.checkout({ paymentSessionId, redirectTarget });
}

// A shareable link that opens Cashfree's hosted checkout for this order from
// any phone/browser, no login needed (handled by pages/PayLink.jsx, picked up
// by App.jsx from the ?pay= query on the site root). Used when Cashfree
// doesn't give us a QR image/UPI link for this account. Inside the Android
// app window.location.origin is not a real website, so use the live domain.
export function buildPayLink({ paymentSessionId, mode = "sandbox" }) {
  if (!paymentSessionId) return "";
  const origin = Capacitor.isNativePlatform() ? "https://www.1infinity.online" : window.location.origin;
  return `${origin}/?pay=${encodeURIComponent(paymentSessionId)}&m=${mode === "production" ? "production" : "sandbox"}`;
}
