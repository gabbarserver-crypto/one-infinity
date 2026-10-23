import React, { useEffect, useRef, useState } from "react";
import { openCashfreeHostedCheckout } from "../lib/cashfreeCheckout";

// Public page (no login) opened from a shared payment link:
//   https://<site>/?pay=<paymentSessionId>&m=<sandbox|production>
// It just hands the order to Cashfree's own hosted checkout, where the
// payer picks UPI / card / netbanking. The payment itself is confirmed by
// api/payments/webhook.js, exactly like every other QR payment.
export default function PayLink() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("pay") || "";
  const mode = params.get("m") === "production" ? "production" : "sandbox";
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(true);
  const started = useRef(false);

  const start = async () => {
    setError(""); setOpening(true);
    try {
      await openCashfreeHostedCheckout({ paymentSessionId: sessionId, mode, redirectTarget: "_self" });
    } catch (e) {
      setError(e.message || "Couldn't open the payment page");
      setOpening(false);
    }
  };

  useEffect(() => {
    if (started.current || !sessionId) return;
    started.current = true;
    start();
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 28, maxWidth: 380, width: "100%", textAlign: "center", boxShadow: "0 4px 24px rgba(0,0,0,.08)" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>One Infinity — Payment</h1>
        {!sessionId ? (
          <p style={{ color: "#e11d48", fontSize: 14 }}>This payment link is incomplete. Please ask for a new one.</p>
        ) : (
          <>
            <p style={{ color: "#475569", fontSize: 14, margin: "0 0 16px" }}>
              {opening && !error ? "Opening the secure payment page…" : "Tap below to continue to the secure payment page."}
            </p>
            {error && <p style={{ color: "#e11d48", fontSize: 13, margin: "0 0 12px" }}>{error}. If this link has expired, please ask for a new one.</p>}
            <button
              onClick={start}
              style={{ width: "100%", background: "#2563eb", color: "#fff", border: 0, borderRadius: 12, padding: "12px 16px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              Pay now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
