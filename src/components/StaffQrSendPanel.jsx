// src/components/StaffQrSendPanel.jsx
//
// Staff counterpart to QrPaymentPanel (which a dealer opens for themself).
// This is for the other direction: staff picks a dealer, generates a QR,
// and it's sent straight to that dealer -- as a chat message (with the QR
// as an attachment, so it's sitting in their Payments/Chats tab whichever
// they open first) and as a push notification if their phone has the app.
//
// The payment side is identical to the dealer-initiated flow: the QR is a
// normal api/payments/create-qr.js order tied to that dealer_id, and
// api/payments/webhook.js inserts the `payments` row against THAT dealer
// the instant Cashfree confirms it -- same auto-verified, no staff-action-
// required path. This panel is only about *how the dealer receives the QR*,
// not how the payment itself gets recorded.
import React, { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { createPaymentQr, sendPush } from "../lib/serverApi";
import { getOrCreateThread, sendMessage, identityFor } from "../lib/chat";
import { buildPayLink } from "../lib/cashfreeCheckout";
import { Modal, Field, Input, Select, PrimaryButton, GhostButton, Toast } from "./UI";
import SearchableSelect from "./SearchableSelect";

// Cashfree requires order_expiry_time to be more than 15 minutes out, so
// this must stay above 15 -- 10 used to be the default and silently failed
// every "Generate & Send" until raised.
const DEFAULT_MINUTES = 20;

// Draws the QR onto a white card (with the amount underneath) and returns a
// PNG blob — a plain QR on a transparent background looks bad when pasted
// into WhatsApp, and the clipboard only reliably accepts PNG.
async function buildShareBlob(src, caption) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Couldn't load the QR image"));
    i.src = src;
  });
  const size = 480, pad = 28, capH = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size + pad * 2;
  canvas.height = size + pad * 2 + capH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, pad, pad, size, size);
  ctx.fillStyle = "#111";
  ctx.font = "bold 30px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(caption, canvas.width / 2, size + pad * 2 + 36);
  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't prepare the QR image"))), "image/png")
  );
}

// 10-digit Indian mobile -> wa.me format (91XXXXXXXXXX); "" if unusable.
function waNumber(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 10 ? "91" + digits.slice(-10) : "";
}

export default function StaffQrSendPanel({ staff, dealers, onClose }) {
  const [step, setStep] = useState("form"); // form | sending | qr | paid | expired
  const [dealerId, setDealerId] = useState("");
  const [applications, setApplications] = useState([]);
  const [applicationId, setApplicationId] = useState("");
  const [amount, setAmount] = useState("");
  const [minutesValid, setMinutesValid] = useState(DEFAULT_MINUTES);
  const [qr, setQr] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [toast, setToast] = useState(null);
  const pollRef = useRef(null);
  const [localQr, setLocalQr] = useState(""); // QR drawn here from the UPI link when Cashfree sent no image

  useEffect(() => {
    (async () => {
      if (!dealerId) { setApplications([]); return; }
      const { data } = await supabase
        .from("applications")
        .select("id, draft_code, applicant_name")
        .eq("dealer_id", dealerId)
        .order("submitted_at", { ascending: false });
      setApplications(data || []);
    })();
  }, [dealerId]);

  const generateAndSend = async () => {
    if (!dealerId) { setToast("Pick a dealer"); return; }
    if (!amount || Number(amount) <= 0) { setToast("Enter an amount"); return; }
    setStep("sending");
    try {
      const result = await createPaymentQr({ dealerId, applicationId: applicationId || null, amount: Number(amount), minutesValid });

      // Same fallback create-qr.js documents: some Cashfree accounts don't
      // have the embedded "Order Pay" QR image enabled, and only a
      // paymentSessionId comes back. Previously that meant attachmentUrl
      // ended up null/undefined here and the dealer just got plain text
      // with nothing to tap — this now sends a "cashfree-pay:" attachment
      // instead, which ChatPanel.jsx renders as a real "Pay Now" button
      // that opens Cashfree's hosted checkout (same as the dealer's own
      // "Pay by QR" screen already does in this exact fallback case).
      const attachmentUrl = result.qrImageUrl || `cashfree-pay:${result.paymentSessionId}?mode=${result.cashfreeMode}`;

      const thread = await getOrCreateThread({ dealerId, applicationId: applicationId || null });
      await sendMessage({
        threadId: thread.id,
        sender: {
          ...identityFor({ staff }),
          body: `Payment QR for ₹${Number(amount).toLocaleString("en-IN")} — scan with any UPI app (PhonePe, GPay, Paytm, BHIM). Expires in ${minutesValid} minutes.`,
          attachmentUrl,
        },
      });

      await sendPush({
        targetType: "dealer",
        targetId: dealerId,
        title: "Payment QR sent",
        body: `₹${Number(amount).toLocaleString("en-IN")} — open Chats to scan and pay`,
        data: { kind: "payment_qr", threadId: thread.id },
      });

      setQr(result);
      setStep("qr");
    } catch (e) {
      setToast(e.message || "Could not generate/send QR");
      setStep("form");
    }
  };

  // Shareable link that opens Cashfree's hosted checkout for this order.
  const payLink = qr ? buildPayLink({ paymentSessionId: qr.paymentSessionId, mode: qr.cashfreeMode }) : "";

  // If Cashfree didn't send a QR image, draw one here — from its raw UPI
  // link if it gave us one, otherwise from the shareable pay link above —
  // so staff always has a QR to show/copy/share.
  useEffect(() => {
    setLocalQr("");
    if (!qr || qr.qrImageUrl) return;
    const source = qr.qrRawString || payLink;
    if (!source) return;
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const url = await QRCode.toDataURL(source, { margin: 1, width: 480 });
        if (!cancelled) setLocalQr(url);
      } catch { /* leave empty */ }
    })();
    return () => { cancelled = true; };
  }, [qr, payLink]);

  // Live countdown, purely for staff's own view of how long the dealer has
  // left -- Cashfree enforces the real expiry (order_expiry_time), not this.
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

  // Same Realtime-plus-poll pattern as QrPaymentPanel, so staff sees "Paid"
  // land here too without having to go check the Receipts list separately.
  useEffect(() => {
    if (step !== "qr" || !qr) return;

    const channel = supabase
      .channel(`staff-qr-request-${qr.qrRequestId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "payment_qr_requests", filter: `id=eq.${qr.qrRequestId}` },
        (payload) => {
          if (payload.new.status === "paid") setStep("paid");
          else if (payload.new.status === "expired") setStep("expired");
        }
      )
      .subscribe();

    pollRef.current = setInterval(async () => {
      const { data } = await supabase.from("payment_qr_requests").select("status").eq("id", qr.qrRequestId).maybeSingle();
      if (data?.status === "paid") setStep("paid");
      else if (data?.status === "expired") setStep("expired");
    }, 5000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollRef.current);
    };
  }, [step, qr]);

  const shownQr = qr?.qrImageUrl || localQr;
  const dealerMobile = dealers.find((d) => d.id === dealerId)?.mobile;
  const linkBased = !qr?.qrImageUrl && !qr?.qrRawString && !!payLink; // QR encodes our pay link, not a UPI string
  const shareText = linkBased
    ? `Payment — ₹${Number(amount).toLocaleString("en-IN")}\nOpen this link to pay (UPI / card / netbanking). Valid for ${minutesValid} minutes:\n${payLink}`
    : `Payment QR — ₹${Number(amount).toLocaleString("en-IN")}\nScan with any UPI app (PhonePe, GPay, Paytm, BHIM). Valid for ${minutesValid} minutes.`;

  const copyImage = async () => {
    try {
      const blob = await buildShareBlob(shownQr, `₹${Number(amount).toLocaleString("en-IN")} — Scan & Pay`);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setToast("QR copied — paste it in WhatsApp (Ctrl+V)");
      return true;
    } catch {
      setToast("Couldn't copy automatically — right-click the QR and choose “Copy image”");
      return false;
    }
  };

  const shareWhatsApp = async () => {
    // Phone / app: the native share sheet can attach the image straight to WhatsApp.
    try {
      const blob = await buildShareBlob(shownQr, `₹${Number(amount).toLocaleString("en-IN")} — Scan & Pay`);
      const file = new File([blob], "payment-qr.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: shareText });
        return;
      }
    } catch (e) {
      if (e?.name === "AbortError") return; // staff closed the share sheet
    }
    // Desktop: copy the QR image, open the dealer's WhatsApp chat with the
    // text prefilled — staff just pastes the image.
    await copyImage();
    const num = waNumber(dealerMobile);
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(shareText)}`, "_blank", "noopener");
  };

  const copyLink = async (text) => {
    try { await navigator.clipboard.writeText(text); setToast("Copied"); }
    catch { setToast("Couldn't copy"); }
  };

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const dealerName = dealers.find((d) => d.id === dealerId)?.name;

  return (
    <Modal title="Send Payment QR to Dealer" onClose={onClose}>
      {step === "form" && (
        <div className="space-y-4">
          <Field label="Dealer" required>
            <SearchableSelect
              value={dealerId}
              onChange={(id) => { setDealerId(id); setApplicationId(""); }}
              options={dealers.map((d) => ({ id: d.id, name: `${d.name} (${d.code})` }))}
              placeholder="Type to search dealer…"
            />
          </Field>
          <Field label="Application (optional)">
            <Select value={applicationId} onChange={(e) => setApplicationId(e.target.value)} disabled={!dealerId}>
              <option value="">— General payment, not tied to one application —</option>
              {applications.map((a) => <option key={a.id} value={a.id}>{a.draft_code} — {a.applicant_name}</option>)}
            </Select>
          </Field>
          <div className="grid sm:grid-cols-2 gap-x-4">
            <Field label="Amount (₹)" required>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="QR valid for (minutes)">
              <Input type="number" value={minutesValid} onChange={(e) => setMinutesValid(e.target.value)} />
            </Field>
          </div>
          <PrimaryButton onClick={generateAndSend} className="w-full">
            Generate &amp; Send to Dealer
          </PrimaryButton>
        </div>
      )}

      {step === "sending" && (
        <p className="text-center text-sm text-slate-400 py-8">Generating QR and sending to {dealerName || "dealer"}…</p>
      )}

      {step === "qr" && qr && (
        <div className="text-center space-y-4">
          <p className="text-sm text-emerald-600 dark:text-emerald-400 font-semibold">
            Sent to {dealerName} — via chat{typeof window !== "undefined" ? " and push notification" : ""}.
          </p>
          {shownQr ? (
            <>
              <img src={shownQr} alt="Payment QR" className="mx-auto w-48 h-48 rounded-lg border border-slate-200 dark:border-slate-700 bg-white p-1" />
              {linkBased && (
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Scan this with the phone camera, or just send the link — it opens the secure payment page (UPI / card / netbanking).
                </p>
              )}
              <div className="flex gap-2">
                <GhostButton onClick={copyImage} className="flex-1">📋 Copy QR</GhostButton>
                <PrimaryButton onClick={shareWhatsApp} className="flex-1">WhatsApp</PrimaryButton>
              </div>
              {linkBased && (
                <button type="button" onClick={() => copyLink(payLink)} className="text-xs text-blue-500 hover:underline">Copy payment link</button>
              )}
              {!linkBased && qr.qrRawString && (
                <button type="button" onClick={() => copyLink(qr.qrRawString)} className="text-xs text-blue-500 hover:underline">Copy UPI payment link</button>
              )}
            </>
          ) : payLink ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">Preparing QR…</p>
          ) : (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              No QR could be generated for this order — {dealerName} still got a "Pay Now" button in chat.
            </p>
          )}
          <p className="text-xl font-bold text-slate-700 dark:text-slate-200">₹{Number(amount).toLocaleString("en-IN")}</p>
          <p className={`text-sm font-mono ${secondsLeft <= 30 ? "text-rose-500" : "text-slate-400"}`}>
            Expires in {mm}:{ss}
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500 animate-pulse">Waiting for payment…</p>
          <GhostButton onClick={onClose} className="w-full">Close</GhostButton>
        </div>
      )}

      {step === "paid" && (
        <div className="text-center space-y-3 py-4">
          <p className="text-3xl">✅</p>
          <p className="text-lg font-semibold text-emerald-600">Paid by {dealerName}</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">₹{Number(amount).toLocaleString("en-IN")} recorded automatically against their account.</p>
          <PrimaryButton onClick={onClose} className="w-full">Done</PrimaryButton>
        </div>
      )}

      {step === "expired" && (
        <div className="text-center space-y-3 py-4">
          <p className="text-lg font-semibold text-rose-500">QR expired, unpaid</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">{dealerName} didn't pay in time. Generate a fresh one to resend.</p>
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
