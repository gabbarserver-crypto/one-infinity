# Receipts / Payments split + dealer self-submitted payments

## Summary of the 3 changes
1. **Staff/admin nav**: "Payments" renamed to **"Receipts"** — same page,
   same functionality (Record New Payment, Recent Payments, Import CSV).
   Nothing about how it works changed.
2. **New "Payments" nav tab (staff/admin)** — a read-only report: every
   application's Fee and PCC Fee side by side, with Applicant Name,
   Application No., and PCC No./Status. Search box, totals footer. Nothing
   here is editable — go to Applications to change a Fee/PCC Fee.
3. **Dealer Portal gets a new "Payments" tab** — a dealer (or their
   sub-staff) can submit a payment themselves. It lands as **Pending** —
   no ledger entry is posted. On the staff Receipts page, a "Pending
   Verification" section appears at the top whenever there's one to
   review; **Verify** posts the same ledger entries a staff-recorded
   payment gets, **Reject** just discards it (nothing to undo, since
   nothing was posted).

## 1. Run the migration first
`server/migrations/005_payment_verification.sql` in the Supabase SQL
editor. Adds `status`/`submitted_by`/`verified_by`/`verified_at` to
`payments`, and RLS so a dealer can only ever insert their OWN pending
submissions (never something already 'verified', never for another
dealer) — enforced at the database level, not just in the UI.

Every payment staff record directly keeps posting to the ledger
immediately, exactly as before — the new columns default to
`status: 'verified'`, `submitted_by: 'staff'`, so nothing about the
existing flow changes.

## 2. Files
- `server/migrations/005_payment_verification.sql` — NEW
- `src/pages/Payments.jsx` — modified (this is "Receipts" in the nav now).
  Ledger-posting logic was pulled into a shared `postPaymentLedgers()`
  used by both the existing form AND the new Verify action. Adds a
  "Pending Verification" section + Verify/Reject.
- `src/pages/PaymentsFeeReport.jsx` — NEW. The new read-only "Payments" tab.
- `src/components/DealerPaymentsPanel.jsx` — NEW. The dealer's
  "Submit a Payment" form + their own payment history with status badges.
- `src/pages/DealerPortal.jsx` — modified. Adds a "Payments" tab that
  renders `DealerPaymentsPanel`.
- `src/App.jsx` — modified. Nav: `payments` key now labeled "Receipts";
  new `paymentsReport` key labeled "Payments" (reuses the same permission
  module as Receipts, so whoever could see the old Payments page can see
  both new tabs — no permissions setup needed).
- `src/components/Sidebar.jsx` — modified. Gives Receipts a receipt icon
  and the new Payments tab a ₹ icon (purely cosmetic).

## Test it
1. Run the migration.
2. Staff side: sidebar should now show **Receipts** (old page, unchanged)
   and **Payments** (new report — search & totals).
3. Dealer Portal: new **Payments** tab → submit a test payment → shows as
   "Pending verification" in blue-ish amber.
4. Back on staff Receipts page: a "Pending Verification" card appears at
   the top → click Verify → check the dealer's Ledger tab, the amount
   should now show as a credit. Try Reject on another test submission —
   confirm no ledger entry appears for it.
