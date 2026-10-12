// api/payments/webhook.js
//
// Vercel Serverless Function -- this is the ONE part of the QR flow that
// isn't called by our own frontend. Cashfree calls this directly the
// moment a dealer's UPI payment against one of our orders succeeds (or
// fails). No accessToken, no dealer session -- so nothing here can be
// trusted just because the request arrived; every request is verified two
// separate ways before anything gets written:
//   1. The x-webhook-signature header, checked against CASHFREE_CLIENT_SECRET
//      (verifyWebhookSignature in _lib/cashfree.js -- Cashfree signs webhooks
//      with the same PG secret key used for API auth, not a separate
//      per-webhook secret) -- proves the request body wasn't forged or
//      tampered with in transit.
//   2. A direct server-to-server fetchOrderStatus() call back to Cashfree
//      -- proves the order is ACTUALLY marked PAID on Cashfree's side right
//      now, rather than trusting whatever status string the webhook body
//      itself claims. Belt-and-suspenders: even a correctly-signed but
//      stale/replayed webhook can't insert a payment this way, because a
//      replayed "paid" webhook still results in the SAME true status.
//
// This is also why body parsing is turned off below -- signature
// verification needs the exact raw bytes Cashfree sent, before any
// JSON.parse/stringify round-trip could change key order or whitespace.
//
// Register this URL in the Cashfree Dashboard -> Developers -> Webhooks as
// <PUBLIC_APP_URL>/api/payments/webhook, subscribed to at least the
// PAYMENT_SUCCESS_WEBHOOK event.
import { supabaseAdmin } from "../_lib/adminAuth.js";
import { verifyWebhookSignature, fetchOrderStatus } from "./_lib/cashfree.js";
import { sendPushNotification } from "../_lib/push.js";
import { todayIST } from "../_lib/dates.js";

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!supabaseAdmin) return res.status(500).json({ error: "Server isn't configured with SUPABASE_SERVICE_ROLE_KEY" });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: "Could not read request body" });
  }

  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];
  if (!verifyWebhookSignature({ rawBody, timestamp, signature })) {
    console.warn("payments/webhook: signature check failed -- ignoring");
    // 200, not 401/403: Cashfree retries on non-2xx, and a bad signature
    // will never become a good one on retry, so acknowledging (while
    // logging and doing nothing else) avoids pointless retry storms.
    return res.status(200).json({ ok: true, note: "signature check failed, ignored" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(200).json({ ok: true, note: "unparseable body, ignored" });
  }

  const orderId = event?.data?.order?.order_id;
  if (!orderId) return res.status(200).json({ ok: true, note: "no order_id in payload, ignored" });

  try {
    const { data: qrRequest } = await supabaseAdmin
      .from("payment_qr_requests")
      .select("*")
      .eq("cf_order_id", orderId)
      .maybeSingle();
    if (!qrRequest) return res.status(200).json({ ok: true, note: "unknown order_id, ignored" });

    // Already handled (Cashfree can send the same webhook more than once --
    // this makes the handler idempotent instead of double-inserting/
    // double-crediting).
    if (qrRequest.status === "paid") return res.status(200).json({ ok: true, note: "already processed" });

    const order = await fetchOrderStatus(orderId);

    if (order.order_status === "PAID") {
      // Dealer-code-based receipt number, same as the staff-side "Record
      // Payment" form (src/pages/Payments.jsx submit()) — QR payments
      // always have a dealer, so this always runs.
      const { data: receiptNo, error: codeErr } = await supabaseAdmin.rpc("next_payment_code", {
        p_dealer_id: qrRequest.dealer_id,
      });
      if (codeErr) console.error("webhook: next_payment_code failed for", orderId, codeErr.message);

      const { data: payment, error: paymentErr } = await supabaseAdmin
        .from("payments")
        .insert({
          dealer_id: qrRequest.dealer_id,
          application_id: qrRequest.application_id,
          amount: qrRequest.amount,
          payment_mode: "UPI",
          reference_no: order.cf_order_id ? String(order.cf_order_id) : null,
          remarks: `Auto-recorded from UPI QR payment (order ${orderId})`,
          status: "verified", // the gateway confirming it IS the verification
          submitted_by: "gateway",
          receipt_no: receiptNo || null,
        })
        .select()
        .single();
      if (paymentErr) {
        console.error("webhook: failed to insert payment for", orderId, paymentErr.message);
        return res.status(200).json({ ok: true, note: "payment insert failed, will retry on next webhook delivery" });
      }

      // Post this payment to the ledger too -- same as the staff "Record
      // Payment" flow (src/pages/Payments.jsx submit()). The `payments` row
      // alone only feeds the staff-side Receipts list and bank feed; the
      // dealer's own Running Balance, Ledger tab, and Payments tab all read
      // from ledger_entries, so without this insert a QR payment is fully
      // visible to staff but invisible to the dealer who made it.
      const { data: dealerRow } = await supabaseAdmin
        .from("dealers")
        .select("name")
        .eq("id", qrRequest.dealer_id)
        .maybeSingle();

      const { error: ledgerErr } = await supabaseAdmin.from("ledger_entries").insert({
        entry_code: `PMT-${payment.id}`,
        entry_type: "PAYMENT",
        // IST calendar date -- this runs on a UTC server, where the plain
        // toISOString() date is still "yesterday" until 05:30 IST.
        entry_date: todayIST(),
        dealer_id: qrRequest.dealer_id,
        amount: -qrRequest.amount,
        payment_mode: "UPI",
        reference_no: order.cf_order_id ? String(order.cf_order_id) : null,
        payer_name: dealerRow?.name || null,
        source_payment_id: payment.id,
      });
      if (ledgerErr) {
        // Don't fail the webhook over this -- the payment itself is already
        // safely recorded and Cashfree must not be told to retry (that would
        // double-insert the payments row, since payment_qr_requests.status
        // hasn't flipped to 'paid' yet below). Log loudly so it can be
        // backfilled manually instead.
        console.error("webhook: payment recorded but ledger insert failed for", orderId, ledgerErr.message);
      }

      await supabaseAdmin
        .from("payment_qr_requests")
        .update({ status: "paid", payment_id: payment.id, paid_at: new Date().toISOString() })
        .eq("id", qrRequest.id);

      // Real push to every staff device, not just an in-app toast -- this
      // runs server-side (Cashfree calling us directly, no staff browser
      // involved at all), so it's the only way staff get notified if
      // nobody's app happens to be open right now. Fire-and-forget: never
      // block or fail the webhook response over a push delivery issue.
      sendPushNotification({
        targetType: "all_staff",
        title: "Payment received (QR)",
        body: `${dealerRow?.name || "A dealer"} — ₹${Number(qrRequest.amount).toLocaleString("en-IN")}`,
        data: { kind: "payment" },
      }).catch(() => {});

      return res.status(200).json({ ok: true });
    }

    if (["EXPIRED", "TERMINATED", "TERMINATION_REQUESTED"].includes(order.order_status)) {
      await supabaseAdmin.from("payment_qr_requests").update({ status: "expired" }).eq("id", qrRequest.id);
      return res.status(200).json({ ok: true });
    }

    // ACTIVE or anything else -- not paid yet, nothing to do.
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("payments/webhook failed:", e);
    // Non-2xx so Cashfree retries -- this branch is for OUR errors (e.g. a
    // transient Supabase blip), not for anything about the payment itself.
    return res.status(500).json({ error: "internal error, please retry" });
  }
}
