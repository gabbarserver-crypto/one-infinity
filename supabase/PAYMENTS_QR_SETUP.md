# Pay-by-QR setup

What this adds: a dealer taps **Pay by QR** on the Dealer Portal → Payments
tab, gets a UPI QR that expires after 10 minutes, pays with any UPI app,
and the payment is inserted into `payments` automatically and already
`verified` — no staff action needed. The existing "Submit a Payment"
self-report form (pending → staff verifies) is untouched and still there
for payments made outside the app.

## 1. Run the migration

In Supabase SQL editor, run `supabase/009_qr_payments.sql`. It:
- creates `payment_qr_requests` (one row per QR shown)
- adds `'gateway'` as a valid `payments.submitted_by` value
- turns on Realtime for the new table

## 2. Get Cashfree credentials

1. Sign up at [cashfree.com](https://www.cashfree.com) → complete KYC (needed
   before you can go to Production; Sandbox works immediately without it).
2. Dashboard → **Developers → API Keys** → copy your Client ID / Client Secret
   (there's a separate pair for Sandbox and Production).
3. Dashboard → **Developers → Webhooks** → add a webhook pointing at
   `https://<your-deployed-domain>/api/payments/webhook`, subscribed to
   **Payment Success** (and Payment Failed, optional). Cashfree does not
   issue a separate secret per webhook endpoint — it signs webhook payloads
   with the same PG Client Secret from step 2, so there's nothing extra to
   copy here.

## 3. Set Vercel environment variables

Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `CASHFREE_CLIENT_ID` | from step 2 |
| `CASHFREE_CLIENT_SECRET` | from step 2 (also used to verify webhook signatures — see note in step 2) |
| `CASHFREE_ENV` | `SANDBOX` while testing, `PRODUCTION` once live |
| `PUBLIC_APP_URL` | your deployed URL, e.g. `https://sjo-admin.vercel.app` (no trailing slash) |

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` should already be set from
the existing login endpoints — the new functions reuse them.)

## 4. Before going to Production

- `api/payments/_lib/cashfree.js` has a note at the top about the API
  version (`x-api-version`) and the exact shape of the QR-generation
  response — Cashfree's docs are the source of truth; open their current
  **Create Order** and **Order Pay** reference pages and confirm nothing's
  shifted since this was written, especially `extractQrPayload()`.
- Test the full loop in Sandbox first: Cashfree's sandbox has test UPI
  handles that simulate a successful payment without real money.
- Confirm the webhook actually reaches you — check Vercel's function logs
  after a sandbox payment; `payments/webhook.js` logs a warning if the
  signature check fails (usually means `CASHFREE_CLIENT_SECRET` doesn't
  match what's set in the Cashfree Dashboard for the environment — Sandbox
  and Production have different secrets, so check you're not mixing them).

## What got added / changed

New:
- `supabase/009_qr_payments.sql`
- `api/payments/_lib/cashfree.js`
- `api/payments/create-qr.js`
- `api/payments/webhook.js`
- `src/components/QrPaymentPanel.jsx`

Changed:
- `src/lib/serverApi.js` — added `createPaymentQr()`
- `src/components/DealerPaymentsPanel.jsx` — added the "Pay by QR" button
  that opens `QrPaymentPanel`
