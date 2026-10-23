// api/payments/create-qr.js
//
// Vercel Serverless Function. A dealer (or their active sub-staff) hits
// "Pay by QR" in DealerPortal -- this creates a Cashfree order with
// a fixed expiry, asks Cashfree to render it as a UPI QR, and records a
// `payment_qr_requests` row so the frontend has something to poll/subscribe
// to. Nothing lands in `payments` yet -- that only happens in webhook.js,
// once Cashfree actually confirms money moved. Every payment made this way
// always ends up as a verified `payments` row, optionally tied to
// `applicationId`, and feeds straight into the dealer's ledger/running
// balance -- there's no separate wallet/prepaid pool anymore.
//
// Body: { accessToken, dealerId, applicationId?, amount, minutesValid? }
//
// Required Vercel env vars, in addition to the ones create-dealer-login.js
// already needs (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY):
//   CASHFREE_CLIENT_ID, CASHFREE_CLIENT_SECRET, CASHFREE_ENV   (see _lib/cashfree.js)
//   PUBLIC_APP_URL   your deployed app's base URL, e.g. https://sjo-admin.vercel.app
//                     -- used to build the webhook URL we hand Cashfree.
import { supabaseAdmin, resolveCaller } from "../_lib/adminAuth.js";
import { createOrder, generateUpiQr, cashfreeConfigured } from "./_lib/cashfree.js";

// Cashfree requires order_expiry_time to be more than 15 minutes out (and
// less than 30 days), so this fallback -- and anything the client sends --
// must stay above 15.
const DEFAULT_MINUTES_VALID = 20;
const MIN_MINUTES_VALID = 16;

// CORS: same reasoning/pattern as api/agora-token.js -- the Android app
// (Capacitor) and any local dev server hit this as a genuine cross-origin
// request (different origin than this API), so without these headers plus
// answering the OPTIONS preflight, the browser fetch() fails with an opaque
// "Failed to fetch"/405 before the response body is ever readable, even
// though the function itself would have run fine. "*" is fine here -- this
// endpoint requires a valid Supabase accessToken in the body to do
// anything, so an open CORS policy doesn't itself expose anything; auth is
// enforced by resolveCaller() below, not by origin-checking.
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  // Preflight -- the browser sends this automatically before the real POST
  // on a cross-origin request; it just needs a 2xx response with the CORS
  // headers above, no body required.
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!supabaseAdmin) return res.status(500).json({ error: "Server isn't configured with SUPABASE_SERVICE_ROLE_KEY" });
  if (!cashfreeConfigured()) return res.status(500).json({ error: "Server isn't configured with Cashfree credentials" });
  if (!process.env.PUBLIC_APP_URL) return res.status(500).json({ error: "Server isn't configured with PUBLIC_APP_URL" });

  try {
    const { accessToken, dealerId, applicationId, amount, minutesValid } = req.body || {};
    const amountNum = Number(amount);
    if (!dealerId || !amountNum || amountNum <= 0) {
      return res.status(400).json({ error: "dealerId and a positive amount are required" });
    }
    const effectiveApplicationId = applicationId || null;

    // Only that dealer themself (or their active sub-staff), or staff
    // acting on a dealer's behalf, can request a QR for that dealer_id --
    // otherwise anyone signed in could generate a QR that credits a
    // stranger's account once paid.
    const caller = await resolveCaller(accessToken);
    const allowed =
      caller?.kind === "staff" ||
      ((caller?.kind === "dealer" || caller?.kind === "dealer_staff") && caller.dealerId === dealerId);
    if (!allowed) return res.status(403).json({ error: "Not allowed to request a QR for this dealer" });

    const { data: dealer, error: dealerErr } = await supabaseAdmin
      .from("dealers")
      .select("id, name, mobile, email")
      .eq("id", dealerId)
      .maybeSingle();
    if (dealerErr || !dealer) return res.status(404).json({ error: "Dealer not found" });

    const requestedMinutes = Number(minutesValid) > 0 ? Number(minutesValid) : DEFAULT_MINUTES_VALID;
    if (requestedMinutes < MIN_MINUTES_VALID) {
      return res.status(400).json({ error: `QR must be valid for at least ${MIN_MINUTES_VALID} minutes (Cashfree requires more than 15 minutes)` });
    }
    const minutes = requestedMinutes;
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    const cfOrderId = `SJO-${dealerId.slice(0, 8)}-${Date.now()}`;

    const webhookUrl = `${process.env.PUBLIC_APP_URL}/api/payments/webhook`;

    const order = await createOrder({
      orderId: cfOrderId,
      amount: amountNum,
      dealer,
      expiresAtIso: expiresAt.toISOString(),
      webhookUrl,
    });

    // The order itself is created either way -- it's specifically the
    // "Order Pay" call (rendering that order as an embedded UPI QR) that
    // some Cashfree accounts don't have enabled yet ("POST /orders/pay is
    // not enabled or approved", needs Cashfree support to turn on). Rather
    // than failing the whole request when that happens, fall back to
    // returning the order's payment_session_id so the frontend can send the
    // dealer to Cashfree's own hosted checkout page instead (which needs no
    // special approval and offers UPI QR/intent/cards there) -- see
    // src/lib/cashfreeCheckout.js.
    let qr = { qrImageUrl: null, qrRawString: null };
    try {
      qr = await generateUpiQr({ paymentSessionId: order.payment_session_id });
    } catch (qrErr) {
      console.warn("create-qr: embedded UPI QR unavailable, falling back to hosted checkout:", qrErr.message);
    }

    const { data: qrRequest, error: insertErr } = await supabaseAdmin
      .from("payment_qr_requests")
      .insert({
        dealer_id: dealerId,
        application_id: effectiveApplicationId,
        amount: amountNum,
        cf_order_id: cfOrderId,
        qr_expires_at: expiresAt.toISOString(),
        status: "pending",
      })
      .select()
      .single();
    if (insertErr) return res.status(500).json({ error: "Order created at Cashfree but failed to save locally: " + insertErr.message });

    res.json({
      qrRequestId: qrRequest.id,
      qrImageUrl: qr.qrImageUrl,
      qrRawString: qr.qrRawString,
      // Always included so the frontend can fall back to Cashfree's hosted
      // checkout (cashfree.checkout({ paymentSessionId, ... })) whenever
      // qrImageUrl above is null.
      paymentSessionId: order.payment_session_id,
      // Some Cashfree API versions also return a ready-made hosted payment link
      // on the order; passed along (if present) so staff can share it manually.
      paymentLink: order.payment_link || null,
      cashfreeMode: process.env.CASHFREE_ENV === "PRODUCTION" ? "production" : "sandbox",
      expiresAt: expiresAt.toISOString(),
      cfOrderId,
    });
  } catch (e) {
    console.error("create-qr failed:", e);
    res.status(500).json({ error: e.message || "Unexpected server error" });
  }
}
