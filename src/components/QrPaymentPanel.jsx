// src/components/QrPaymentPanel.jsx
//
// Opens as a modal from the "Pay by QR" card in DealerPortal's summary row
// (alongside Running Balance / Credit Limit). Three states:
//   1. Asking for an amount -> calls createPaymentQr()
//   2. Showing the QR + a live countdown to qr_expires_at
//   3. Paid (a Supabase Realtime row change flips payment_qr_requests.status
//      to 'paid') -- at that point the `payments` row already exists,
//      inserted by api/payments/webhook.js, no further action needed here.
//
// Realtime is the primary signal; a 5s poll is kept as a fallback in case
// the Realtime subscription doesn't fire (e.g. briefly dropped connection),
// so this never leaves someone staring at a QR that's actually already paid.
import React, { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { createPaymentQr } from "../lib/serverApi";
import { openCashfreeHostedCheckout } from "../lib/cashfreeCheckout";
import { Modal, Field, Input, PrimaryButton, GhostButton, Toast } from "./UI";

export default function QrPaymentPanel({ dealerId, onClose, onPaid }) {
  const [step, setStep] = useState("form"); // form | qr | paid | expired
  const [amount, setAmount] = useState("");
  const [creating, setCreating] = useState(false);
  const [qr, setQr] = useState(null); // { qrRequestId, qrImageUrl, qrRawString, paymentSessionId, cashfreeMode, expiresAt, cfOrderId }
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [toast, setToast] = useState(null);
  const [openingHosted, setOpeningHosted] = useState(false);
  const pollRef = useRef(null);

  const requestQr = async () => {
    if (!amount || Number(amount) <= 0) { setToast("Enter an amount"); return; }
    setCreating(true);
    try {
      const result = await createPaymentQr({ dealerId, amount: Number(amount) });
      setQr(result);
      setStep("qr");
    } catch (e) {
      setToast(e.message || "Could not create QR");
    } finally {
      setCreating(false);
    }
  };

  // Countdown display, ticking every second purely client-side -- the real
  // expiry is enforced by Cashfree itself (order_expiry_time), this is just
  // so the dealer sees the clock running down.
  useEffect(() => {
    if (step !== "qr" || !qr) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((new Date(qr.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setStep("expired");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [step, qr]);

  // Realtime subscription: flips to "paid" the instant the webhook updates
  // this row -- no reload, no manual "I've paid" click needed from the dealer.
  useEffect(() => {
    if (step !== "qr" || !qr) return;

    const channel = supabase
      .channel(`qr-request-${qr.qrRequestId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "payment_qr_requests", filter: `id=eq.${qr.qrRequestId}` },
        (payload) => {
          if (payload.new.status === "paid") {
            setStep("paid");
            onPaid?.(payload.new);
          } else if (payload.new.status === "expired") {
            setStep("expired");
          }
        }
      )
      .subscribe();

    // Fallback poll, in case Realtime is unavailable in this environment.
    pollRef.current = setInterval(async () => {
      const { data } = await supabase.from("payment_qr_requests").select("status").eq("id", qr.qrRequestId).maybeSingle();
      if (data?.status === "paid") { setStep("paid"); onPaid?.(data); }
      else if (data?.status === "expired") setStep("expired");
    }, 5000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollRef.current);
    };
  }, [step, qr, onPaid]);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  const openHosted = async () => {
    if (!qr?.paymentSessionId) return;
    setOpeningHosted(true);
    try {
      await openCashfreeHostedCheckout({ paymentSessionId: qr.paymentSessionId, mode: qr.cashfreeMode });
    } catch (e) {
      setToast(e.message || "Could not open the payment page");
    } finally {
      setOpeningHosted(false);
    }
  };

  return (
    <Modal title="Pay by QR" onClose={onClose}>
      {step === "form" && (
        <div className="space-y-4">
          <Field label="Amount (₹)" required>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
          <PrimaryButton onClick={requestQr} disabled={creating} className="w-full">
            {creating ? "Generating QR…" : "Generate QR"}
          </PrimaryButton>
        </div>
      )}

      {step === "qr" && qr && (
        <div className="text-center space-y-4">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Scan with any UPI app — PhonePe, Google Pay, Paytm, BHIM, your bank's app.
          </p>
          {qr.qrImageUrl ? (
            <img src={qr.qrImageUrl} alt="UPI payment QR" className="mx-auto w-56 h-56 rounded-lg border border-slate-200 dark:border-slate-700" />
          ) : qr.paymentSessionId ? (
            <div className="py-4">
              <PrimaryButton onClick={openHosted} disabled={openingHosted} className="w-full">
                {openingHosted ? "Opening…" : "Pay Now"}
              </PrimaryButton>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">Opens Cashfree's payment page in a new tab — UPI QR, UPI app, or card, whichever's easiest. This tab keeps waiting for confirmation.</p>
            </div>
          ) : (
            <p className="text-sm text-rose-500">QR image unavailable — try again in a moment.</p>
          )}
          {qr.qrImageUrl && qr.paymentSessionId && (
            <div>
              <GhostButton onClick={openHosted} disabled={openingHosted} className="w-full">
                {openingHosted ? "Opening…" : "Card / Netbanking / UPI app se pay karein"}
              </GhostButton>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Cashfree ka payment page naye tab me khulega. Payment hote hi yahan apne aap confirm ho jayega.</p>
            </div>
          )}
          <p className="text-2xl font-bold text-slate-700 dark:text-slate-200">₹{Number(amount).toLocaleString("en-IN")}</p>
          <p className={`text-sm font-mono ${secondsLeft <= 30 ? "text-rose-500" : "text-slate-400"}`}>
            Expires in {mm}:{ss}
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500 animate-pulse">Waiting for payment…</p>
          <GhostButton onClick={onClose} className="w-full">Cancel</GhostButton>
        </div>
      )}

      {step === "paid" && (
        <div className="text-center space-y-3 py-4">
          <p className="text-3xl">✅</p>
          <p className="text-lg font-semibold text-emerald-600">Payment received</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">₹{Number(amount).toLocaleString("en-IN")} recorded automatically — no verification needed.</p>
          <PrimaryButton onClick={onClose} className="w-full">Done</PrimaryButton>
        </div>
      )}

      {step === "expired" && (
        <div className="text-center space-y-3 py-4">
          <p className="text-lg font-semibold text-rose-500">QR expired</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">No payment came through in time. Generate a fresh one to try again.</p>
          <div className="flex gap-2">
            <GhostButton onClick={() => { setStep("form"); setQr(null); }} className="flex-1">Try again</GhostButton>
            <PrimaryButton onClick={onClose} className="flex-1">Close</PrimaryButton>
          </div>
        </div>
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </Modal>
  );
}
