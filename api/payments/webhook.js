// api/payments/webhook.js  (PATCHED)
//
// Cashfree calls this when a UPI QR payment succeeds/fails. Every request is
// verified (HMAC signature + a server-to-server order status check) before
// anything is written.
//
// What changed vs the old version:
//   * A real failure (DB error) now returns 500, so Cashfree RETRIES. The old
//     code returned 200 + "will retry", but Cashfree only retries non-2xx, so
//     a transient DB blip lost the payment for good.
//   * Every step is idempotent, so a retry can finish a half-done job:
//       payment row  -> reused if it already exists (matched by reference_no)
//       ledger row   -> inserted only if none exists for that payment
//       status flip  -> error is checked; failure => 500 => retry
//   * receipt number is only generated when a NEW payment row is created, so
//     retries don't burn receipt numbers.
//   * Push is sent only the first time the request is completed.
//   * Raw body is read as Buffer chunks (multi-byte safe for the signature).
//
// NOTE: this targets the CURRENT schema (payments + ledger_entries, as used by
// Payments.jsx). Do NOT apply migration 011 while the app still uses `payments`.
import { supabaseAdmin } from "../_lib/adminAuth.js";
import { verifyWebhookSignature, fetchOrderStatus } from "./_lib/cashfree.js";
import { sendPushNotification } from "../_lib/push.js";
import { todayIST } from "../_lib/dates.js";

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Thrown for failures that should make Cashfree retry (-> HTTP 500).
class RetryableError extends Error {}
const must = (error, what) => {
  if (error) throw new RetryableError(`${what}: ${error.message}`);
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!supabaseAdmin) return res.status(500).json({ error: "Server isn't configured with SUPABASE_SERVICE_ROLE_KEY" });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: "Could not read request body" });
  }

  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];
  if (!verifyWebhookSignature({ rawBody, timestamp, signature })) {
    console.warn("payments/webhook: signature check failed -- ignoring");
    // 200 on purpose: a bad signature never becomes good on retry.
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
    const { data: qrRequest, error: qrErr } = await supabaseAdmin
      .from("payment_qr_requests")
      .select("*")
      .eq("cf_order_id", orderId)
      .maybeSingle();
    must(qrErr, "load payment_qr_requests"); // DB error != "unknown order"
    if (!qrRequest) return res.status(200).json({ ok: true, note: "unknown order_id, ignored" });
    if (qrRequest.status === "paid") return res.status(200).json({ ok: true, note: "already processed" });

    const order = await fetchOrderStatus(orderId); // throws -> 500 -> retry

    if (order.order_status === "PAID") {
      const refNo = order.cf_order_id ? String(order.cf_order_id) : null;

      // ---- 1. payment row: reuse if a previous attempt already created it ----
      let payment = null;
      if (refNo) {
        const { data: existing, error: exErr } = await supabaseAdmin
          .from("payments")
          .select("*")
          .eq("reference_no", refNo)
          .maybeSingle();
        must(exErr, "look up existing payment");
        payment = existing || null;
      }

      if (!payment) {
        const { data: receiptNo, error: codeErr } = await supabaseAdmin.rpc("next_payment_code", {
          p_dealer_id: qrRequest.dealer_id,
        });
        if (codeErr) console.error("webhook: next_payment_code failed for", orderId, codeErr.message);

        const { data: inserted, error: paymentErr } = await supabaseAdmin
          .from("payments")
          .insert({
            dealer_id: qrRequest.dealer_id,
            application_id: qrRequest.application_id,
            amount: qrRequest.amount,
            payment_mode: "UPI",
            reference_no: refNo,
            remarks: `Auto-recorded from UPI QR payment (order ${orderId})`,
            status: "verified",
            submitted_by: "gateway",
            receipt_no: receiptNo || null,
          })
          .select()
          .single();
        // 23505 = unique(reference_no): a concurrent delivery is creating it
        // right now. Ask Cashfree to retry; the retry will find it above.
        must(paymentErr, "insert payment");
        payment = inserted;
      }

      // ---- 2. dealer name (for ledger payer_name + push) ----
      const { data: dealerRow } = await supabaseAdmin
        .from("dealers")
        .select("name")
        .eq("id", qrRequest.dealer_id)
        .maybeSingle();

      // ---- 3. ledger row: only if this payment has none yet ----
      const { data: existingLedger, error: lgLookupErr } = await supabaseAdmin
        .from("ledger_entries")
        .select("id")
        .eq("source_payment_id", payment.id)
        .limit(1)
        .maybeSingle();
      must(lgLookupErr, "look up ledger entry");

      if (!existingLedger) {
        const { error: ledgerErr } = await supabaseAdmin.from("ledger_entries").insert({
          entry_code: `PMT-${payment.id}`,
          entry_type: "PAYMENT",
          entry_date: todayIST(), // IST date; server runs in UTC
          dealer_id: qrRequest.dealer_id,
          amount: -qrRequest.amount,
          payment_mode: "UPI",
          reference_no: refNo,
          payer_name: dealerRow?.name || null,
          source_payment_id: payment.id,
        });
        must(ledgerErr, "insert ledger entry"); // safe to retry now (idempotent)
      }

      // ---- 4. flip the request to paid; failure => retry ----
      const { data: flipped, error: flipErr } = await supabaseAdmin
        .from("payment_qr_requests")
        .update({ status: "paid", payment_id: payment.id, paid_at: new Date().toISOString() })
        .eq("id", qrRequest.id)
        .neq("status", "paid") // only the delivery that actually flips it sends the push
        .select("id");
      must(flipErr, "mark payment_qr_requests paid");

      if (flipped?.length) {
        sendPushNotification({
          targetType: "all_staff",
          title: "Payment received (QR)",
          body: `${dealerRow?.name || "A dealer"} — ₹${Number(qrRequest.amount).toLocaleString("en-IN")}`,
          data: { kind: "payment" },
        }).catch(() => {});
      }

      return res.status(200).json({ ok: true });
    }

    if (["EXPIRED", "TERMINATED", "TERMINATION_REQUESTED"].includes(order.order_status)) {
      const { error } = await supabaseAdmin
        .from("payment_qr_requests")
        .update({ status: "expired" })
        .eq("id", qrRequest.id)
        .eq("status", "pending"); // never overwrite a 'paid' row
      must(error, "mark payment_qr_requests expired");
      return res.status(200).json({ ok: true });
    }

    // ACTIVE or anything else -- not paid yet.
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("payments/webhook failed (Cashfree will retry):", e);
    return res.status(500).json({ error: "internal error, please retry" });
  }
}
