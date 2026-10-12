// src/pages/Payments.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, Input, Select, PrimaryButton, GhostButton, DangerButton, Modal, Toast } from "../components/UI";
import SearchableSelect from "../components/SearchableSelect";
import StaffQrSendPanel from "../components/StaffQrSendPanel";
import { parseCSV, findByLabel, ddmmyyyyToISO } from "../lib/csv";

function isoToDDMMYYYY(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export default function Payments({ staff } = {}) {
  const isAdmin = staff?.roles?.role_name === "Admin";
  const [editingPayment, setEditingPayment] = useState(null); // payment row being edited, or null
  const [dealers, setDealers] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [applications, setApplications] = useState([]);
  const [form, setForm] = useState({ payment_type: "dealer", dealer_id: "", application_id: "", amount: "", payment_mode: "Cash", reference_no: "", remarks: "", paid_at_agency_id: "", paid_on: "" });
  const [recent, setRecent] = useState([]);
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSendQr, setShowSendQr] = useState(false);
  const [allPayments, setAllPayments] = useState([]);
  const [allLoading, setAllLoading] = useState(true);
  const [allQuery, setAllQuery] = useState("");
  const [allDateFrom, setAllDateFrom] = useState("");
  const [allDateTo, setAllDateTo] = useState("");
  const [recentQuery, setRecentQuery] = useState("");
  const [recentSortKey, setRecentSortKey] = useState("date");
  const [recentSortDir, setRecentSortDir] = useState("desc");
  const [bankFeeDeducted, setBankFeeDeducted] = useState(0); // sum of every application's RTO/govt fee — always paid out of the bank
  const [bankBalanceLoading, setBankBalanceLoading] = useState(true);
  const [bankBalanceError, setBankBalanceError] = useState("");
  const [feeRows, setFeeRows] = useState([]); // application fee rows powering the Bank Transactions table
  const [bankQuery, setBankQuery] = useState("");
  const [bankDateFrom, setBankDateFrom] = useState("");
  const [bankDateTo, setBankDateTo] = useState("");
  const [ledgerTab, setLedgerTab] = useState("bank"); // "bank" | "all" — which of the two tables below is showing

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.tagName === "SELECT" ? e.target.value : e.target.value.toUpperCase() }));

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("dealers").select("id, name, code");
      setDealers(data || []);
      const { data: a } = await supabase.from("agencies").select("id, name, code");
      setAgencies(a || []);
      loadRecent();
      loadAllPayments();
      loadBankBalance();
    })();
  }, []);

  // Bank Balance = every UPI payment received from a dealer (lands straight
  // in the bank) minus every application's RTO/govt fee (always paid out of
  // the bank as an online challan) minus every agency payment sent by
  // Bank/UPI/Cheque (Cash paid to an agency never touches the bank).
  // Fee rows are paginated the same way loadAllPayments is, since a plain
  // .select("rto_fee") would otherwise get silently capped at the
  // project's "Max Rows" setting. We keep the full rows (not just the sum)
  // because the Bank Transactions table below needs the date + application
  // each fee belongs to.
  const loadBankBalance = async () => {
    setBankBalanceLoading(true);
    setBankBalanceError("");
    try {
      const pageSize = 1000;
      const maxPages = 50;
      const base = () =>
        supabase.from("applications").select("id, draft_code, applicant_name, rto_fee, fee_entered_at, application_date, submitted_at", { count: "exact" }).not("rto_fee", "is", null);
      const { count, error: countErr } = await base().range(0, 0);
      if (countErr) throw countErr;
      const totalPages = Math.min(maxPages, Math.max(1, Math.ceil((count || 0) / pageSize)));
      const pages = await Promise.all(
        Array.from({ length: totalPages }, (_, page) => {
          const from = page * pageSize;
          return base().range(from, from + pageSize - 1).then(({ data, error }) => {
            if (error) throw error;
            return data || [];
          });
        })
      );
      const all = pages.flat();
      setFeeRows(all);
      setBankFeeDeducted(all.reduce((acc, r) => acc + Number(r.rto_fee || 0), 0));
    } catch (err) {
      console.error("loadBankBalance:", err);
      setBankBalanceError(err?.message || "Couldn't load application fees");
      setFeeRows([]);
      setBankFeeDeducted(0);
    } finally {
      // Always runs, even on a thrown/network error — this is what was
      // missing before and left "Bank Balance" stuck on "…" forever
      // whenever this particular query failed.
      setBankBalanceLoading(false);
    }
  };

  // Money IN: dealer payments collected via UPI (UPI lands straight in the
  // bank; Cash/Bank-transfer-at-counter/Cheque from a dealer don't).
  const bankUpiReceived = allPayments
    .filter((p) => p.dealer_id && p.payment_mode === "UPI")
    .reduce((acc, p) => acc + Number(p.amount || 0), 0);
  // Money OUT to agencies: a direct agency payment (no dealer involved)
  // sent by Bank/UPI/Cheque comes straight out of the bank; Cash paid at
  // the counter doesn't.
  const bankAgencyPaidOut = allPayments
    .filter((p) => !p.dealer_id && p.paid_at_agency_id && p.payment_mode !== "Cash")
    .reduce((acc, p) => acc + Number(p.amount || 0), 0);
  const bankBalance = bankUpiReceived - bankFeeDeducted - bankAgencyPaidOut;

  // Unified Bank Transactions feed: application-fee debits (dated by the
  // day the fee was entered, falling back to the application's approval
  // date and then its submitted date), dealer-UPI credits, and agency
  // Bank/UPI/Cheque debits — the exact three flows that make up
  // bankBalance above, laid out as a chronological ledger.
  const bankTransactions = React.useMemo(() => {
    const rows = [];
    feeRows.forEach((r) => {
      const date = r.fee_entered_at || r.application_date || r.submitted_at;
      if (!date || !Number(r.rto_fee)) return;
      rows.push({
        id: `fee-${r.id}`,
        date,
        label: `RTO Fee — ${r.draft_code || "Application"}${r.applicant_name ? ` (${r.applicant_name})` : ""}`,
        mode: "Challan",
        type: "debit",
        amount: Number(r.rto_fee),
      });
    });
    allPayments.forEach((p) => {
      if (p.dealer_id && p.payment_mode === "UPI") {
        rows.push({
          id: `dealer-${p.id}`,
          date: p.created_at,
          label: `Received from ${p.dealers?.name || "Dealer"}${p.applications?.draft_code ? ` — ${p.applications.draft_code}` : ""}`,
          mode: p.payment_mode,
          type: "credit",
          amount: Number(p.amount || 0),
        });
      } else if (!p.dealer_id && p.paid_at_agency_id && p.payment_mode !== "Cash") {
        rows.push({
          id: `agency-${p.id}`,
          date: p.created_at,
          label: `Paid to ${p.paid_at_agency?.name || "Agency"}`,
          mode: p.payment_mode,
          type: "debit",
          amount: Number(p.amount || 0),
        });
      }
    });
    // Oldest first so a running balance can be accumulated correctly.
    rows.sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.id.localeCompare(b.id));
    let running = 0;
    rows.forEach((r) => {
      running += r.type === "credit" ? r.amount : -r.amount;
      r.balance = running;
    });
    return rows.reverse(); // newest first for display
  }, [feeRows, allPayments]);

  useEffect(() => {
    (async () => {
      if (!form.dealer_id) { setApplications([]); return; }
      const { data } = await supabase
        .from("applications")
        .select("id, draft_code, applicant_name")
        .eq("dealer_id", form.dealer_id)
        .order("submitted_at", { ascending: false });
      setApplications(data || []);
    })();
  }, [form.dealer_id]);

  const loadRecent = async () => {
    const { data } = await supabase
      .from("payments")
      .select("*, dealers(name), applications(draft_code), paid_at_agency:paid_at_agency_id(name)")
      .order("created_at", { ascending: false })
      .limit(20);
    setRecent(data || []);
  };

  // Full history, not just the last 20 — powers the "All Receipts &
  // Payments" table below. Capped at 2000 rows; if that's ever not enough,
  // the date-range filter should be pushed server-side instead of the
  // client-side filtering below.
  // A single request is always capped server-side at Supabase's project
  // "Max Rows" setting (1000 by default) no matter what .limit() we ask
  // for here — that's why the list used to silently stop at exactly 1000.
  // Paging with .range() in chunks under that cap, and looping until a
  // partial page comes back, gets everything regardless of how large the
  // table grows or what the server cap is set to. Ordered by created_at
  // then id so ties don't shuffle rows between pages.
  const loadAllPayments = async () => {
    setAllLoading(true);
    const pageSize = 1000;
    const maxPages = 50; // safety ceiling (50,000 rows) so a bug can't loop forever
    const base = () =>
      supabase
        .from("payments")
        .select("*, dealers(name), applications(draft_code), paid_at_agency:paid_at_agency_id(name)", { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
    let all = [];
    try {
      const { count, error: countErr } = await base().range(0, 0);
      if (countErr) throw countErr;
      const totalPages = Math.min(maxPages, Math.max(1, Math.ceil((count || 0) / pageSize)));
      const pages = await Promise.all(
        Array.from({ length: totalPages }, (_, page) => {
          const from = page * pageSize;
          return base().range(from, from + pageSize - 1).then(({ data, error }) => {
            if (error) throw error;
            return data || [];
          });
        })
      );
      all = pages.flat();
    } catch (error) {
      console.error("loadAllPayments:", error);
    }
    setAllPayments(all);
    setAllLoading(false);
  };

  const submit = async () => {
    const isAgencyOnly = form.payment_type === "agency";
    if (isAgencyOnly ? !form.paid_at_agency_id : !form.dealer_id) {
      setToast(isAgencyOnly ? "Agency and amount are required" : "Dealer and amount are required");
      return;
    }
    if (!form.amount) {
      setToast("Amount is required");
      return;
    }
    if (form.reference_no?.trim()) {
      const { data: dupe } = await supabase
        .from("payments")
        .select("id")
        .eq("reference_no", form.reference_no.trim())
        .limit(1)
        .maybeSingle();
      if (dupe) {
        setToast(`A payment with reference "${form.reference_no.trim()}" already exists — check it isn't already recorded before saving again.`);
        return;
      }
    }
    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    const { data: staffRow } = await supabase.from("staff").select("id").eq("auth_user_id", userData?.user?.id).maybeSingle();

    // Dealer-code-based receipt number, same idea as Applications' Draft
    // ID (next_draft_code) — only makes sense when a dealer is actually
    // involved; agency-only payments have no dealer code to build one from.
    let receiptNo = null;
    if (!isAgencyOnly) {
      const { data: code, error: codeErr } = await supabase.rpc("next_payment_code", { p_dealer_id: form.dealer_id });
      if (codeErr) console.error("next_payment_code failed", codeErr);
      else receiptNo = code;
    }

    const { data: paymentRow, error } = await supabase
      .from("payments")
      .insert({
        dealer_id: isAgencyOnly ? null : form.dealer_id,
        application_id: isAgencyOnly ? null : (form.application_id || null),
        amount: parseFloat(form.amount),
        payment_mode: form.payment_mode,
        reference_no: form.reference_no || null,
        receipt_no: receiptNo,
        remarks: form.remarks || null,
        paid_at_agency_id: form.paid_at_agency_id || null,
        received_by: staffRow?.id || null,
        ...(form.paid_on ? { created_at: form.paid_on } : {}),
      })
      .select()
      .single();

    if (error) {
      setSaving(false);
      setToast(error.code === "23505" ? "This reference number was just used by another payment — please check before saving again." : "Failed: " + error.message);
      return;
    }

    // Post this payment to the ledger: dealer_id set means the dealer's
    // running balance drops by this amount (payment received); agency_id
    // set means the agency's running balance drops too (agency collected
    // this on our behalf, or the payment was made directly to them) — both
    // effects live on the SAME row now, not two separate ledger tables.
    // Writing straight to ledger_entries from the client is blocked by its
    // RLS policy, so this goes through the SECURITY DEFINER RPC instead
    // (same pattern as Applications' Amount field).
    const agencyName = agencies.find((a) => a.id === form.paid_at_agency_id)?.name;
    const { error: ledgerError } = await supabase.rpc("upsert_ledger_entry_for_payment", {
      p_payment_id: paymentRow.id,
    });

    setSaving(false);
    if (ledgerError) {
      setToast("Payment saved, but ledger sync failed: " + ledgerError.message);
    } else if (isAgencyOnly) {
      setToast(`Payment recorded — ${agencyName || "agency"} ledger updated`);
    } else {
      setToast(`Payment recorded — ledger entry & receipt generated${agencyName ? ` (dealer & ${agencyName} ledgers updated)` : ""}`);
    }
    setForm({ payment_type: "dealer", dealer_id: "", application_id: "", amount: "", payment_mode: "Cash", reference_no: "", remarks: "", paid_at_agency_id: "", paid_on: "" });
    loadRecent();
    loadAllPayments();
  };

  // Admin-only: deleting a payment also removes its ledger row — matched
  // directly by source_payment_id (no more voucher_no fallback matching,
  // no more two separate ledger tables to clean up).
  const deletePaymentAndLedger = async (p) => {
    const { error: ledgerErr } = await supabase.rpc("delete_ledger_entry_for_payment", { p_payment_id: p.id });
    if (ledgerErr) {
      return { ok: false, message: "Failed to remove ledger entry: " + ledgerErr.message + " — payment was NOT deleted." };
    }
    // A payment created via "Pay by QR" has a payment_qr_requests row
    // pointing back at it (payment_qr_requests.payment_id -> payments.id)
    // — that FK blocks the delete below with a 23503 violation unless this
    // link is cleared first. Detaching (not deleting) the QR request row
    // keeps its own history/audit trail intact, just no longer tied to a
    // payment that's about to stop existing.
    const { error: qrUnlinkErr } = await supabase
      .from("payment_qr_requests")
      .update({ payment_id: null })
      .eq("payment_id", p.id);
    if (qrUnlinkErr) {
      return { ok: false, message: "Failed to unlink QR request: " + qrUnlinkErr.message + " — payment was NOT deleted." };
    }
    const { error } = await supabase.from("payments").delete().eq("id", p.id);
    if (error) return { ok: false, message: "Failed to delete: " + error.message };
    return { ok: true, message: "" };
  };

  const deletePayment = async (p) => {
    const payerName = p.dealers?.name || p.paid_at_agency?.name || "this payer";
    if (!window.confirm(`Delete this ₹${Number(p.amount).toLocaleString("en-IN")} payment from ${payerName}? This also removes its ledger entries.`)) return;
    const result = await deletePaymentAndLedger(p);
    setToast(result.ok ? "Payment deleted" : result.message);
    loadRecent();
    loadAllPayments();
  };

  // Deletes every payment in `ids` (payment rows from allPayments) one at a
  // time — sequential, not Promise.all, so one failure doesn't race with
  // another payment's ledger cleanup on the same dealer/agency ledger.
  const bulkDeletePayments = async (ids) => {
    const rows = allPayments.filter((p) => ids.includes(p.id));
    if (!rows.length) return;
    if (!window.confirm(`Delete ${rows.length} selected payment${rows.length !== 1 ? "s" : ""}? This also removes their ledger entries. This cannot be undone.`)) return;
    let succeeded = 0;
    const failures = [];
    for (const p of rows) {
      const result = await deletePaymentAndLedger(p);
      if (result.ok) succeeded++;
      else failures.push(`₹${p.amount} (${p.dealers?.name || p.paid_at_agency?.name || "—"}): ${result.message}`);
    }
    setToast(
      failures.length
        ? `Deleted ${succeeded}/${rows.length}. Failed: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`
        : `Deleted ${succeeded} payment${succeeded !== 1 ? "s" : ""}`
    );
    loadRecent();
    loadAllPayments();
  };

  // Admin-only: saves an edited date/amount/mode/reference/remarks and
  // updates the matching ledger row — matched directly by
  // source_payment_id now, no more voucher_no fallback / two-table sync.
  const savePaymentEdit = async (edited) => {
    const original = editingPayment;
    const newAmount = parseFloat(edited.amount);
    const { error } = await supabase
      .from("payments")
      .update({
        amount: newAmount,
        payment_mode: edited.payment_mode,
        reference_no: edited.reference_no || null,
        remarks: edited.remarks || null,
        ...(edited.paid_on ? { created_at: edited.paid_on } : {}),
      })
      .eq("id", original.id);
    if (error) {
      setToast("Failed to update: " + error.message);
      return;
    }

    const { error: ledgerErr } = await supabase.rpc("upsert_ledger_entry_for_payment", {
      p_payment_id: original.id,
    });

    if (ledgerErr) {
      setToast("Payment updated, but its ledger entry failed to sync: " + ledgerErr.message);
    } else {
      setToast("Payment updated");
    }
    setEditingPayment(null);
    loadRecent();
    loadAllPayments();
  };

  const payerNameOf = (p) => p.dealers?.name || (p.paid_at_agency?.name ? `${p.paid_at_agency.name} (Agency)` : "—");

  const toggleRecentSort = (key) => {
    if (recentSortKey === key) setRecentSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setRecentSortKey(key); setRecentSortDir(key === "amount" ? "desc" : "asc"); }
  };

  const visibleRecent = recent
    .filter((p) => {
      if (!recentQuery.trim()) return true;
      const q = recentQuery.trim().toLowerCase();
      const haystack = [payerNameOf(p), p.applications?.draft_code, p.reference_no, p.remarks, p.payment_mode].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    })
    .sort((a, b) => {
      let av, bv;
      if (recentSortKey === "amount") { av = Number(a.amount) || 0; bv = Number(b.amount) || 0; }
      else if (recentSortKey === "payer") { av = payerNameOf(a).toLowerCase(); bv = payerNameOf(b).toLowerCase(); }
      else { av = a.created_at; bv = b.created_at; }
      if (av < bv) return recentSortDir === "asc" ? -1 : 1;
      if (av > bv) return recentSortDir === "asc" ? 1 : -1;
      return 0;
    });

  const RecentSortTh = ({ label, sortKeyName, align = "left" }) => (
    <th
      onClick={() => toggleRecentSort(sortKeyName)}
      className={`px-3 py-2 text-${align} cursor-pointer select-none whitespace-nowrap`}
    >
      {label} {recentSortKey === sortKeyName && (recentSortDir === "asc" ? "↑" : "↓")}
    </th>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Card className="!p-4">
          <p className="text-xs text-slate-400 dark:text-slate-500">Bank Balance</p>
          <p className={`text-xl font-bold mt-1 ${bankBalance < 0 ? "text-rose-600" : "text-slate-800 dark:text-slate-100"}`}>
            {(bankBalanceLoading || allLoading) ? "…" : `₹${bankBalance.toLocaleString("en-IN")}`}
          </p>
          {bankBalanceError ? (
            <p className="text-[11px] text-rose-500 mt-1">
              Couldn't load application fees: {bankBalanceError}{" "}
              <button onClick={loadBankBalance} className="underline font-semibold">Retry</button>
            </p>
          ) : (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
              UPI received ₹{bankUpiReceived.toLocaleString("en-IN")} − Application fee paid ₹{bankFeeDeducted.toLocaleString("en-IN")} − Agency payouts ₹{bankAgencyPaidOut.toLocaleString("en-IN")}
            </p>
          )}
        </Card>
        <div className="flex gap-2">
          <PrimaryButton onClick={() => setShowSendQr(true)}>📲 Send Payment QR</PrimaryButton>
          <GhostButton onClick={() => setShowImport(true)}>⬆ Import CSV</GhostButton>
        </div>
      </div>

      {showSendQr && (
        <StaffQrSendPanel staff={staff} dealers={dealers} onClose={() => { setShowSendQr(false); loadRecent(); loadAllPayments(); }} />
      )}

      <Card title="Record New Payment">
        <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Payment Type" required>
            <Select value={form.payment_type} onChange={set("payment_type")}>
              <option value="dealer">Dealer</option>
              <option value="agency">Agency (no dealer involved)</option>
            </Select>
          </Field>
          {form.payment_type === "dealer" ? (
            <>
              <Field label="Dealer" required>
                <SearchableSelect
                  value={form.dealer_id}
                  onChange={(id) => setForm((s) => ({ ...s, dealer_id: id }))}
                  options={dealers.map((d) => ({ id: d.id, name: `${d.name} (${d.code})` }))}
                  placeholder="Type to search dealer…"
                />
              </Field>
              <Field label="Application (optional)">
                <Select value={form.application_id} onChange={set("application_id")} disabled={!form.dealer_id}>
                  <option value="">— General payment, not tied to one application —</option>
                  {applications.map((a) => <option key={a.id} value={a.id}>{a.draft_code} — {a.applicant_name}</option>)}
                </Select>
              </Field>
            </>
          ) : (
            <Field label="Agency" required>
              <SearchableSelect
                value={form.paid_at_agency_id}
                onChange={(id) => setForm((s) => ({ ...s, paid_at_agency_id: id }))}
                options={agencies.map((a) => ({ id: a.id, name: `${a.name} (${a.code})` }))}
                placeholder="Type to search agency…"
              />
            </Field>
          )}
          <Field label="Date">
            <Input type="date" value={form.paid_on} onChange={set("paid_on")} />
          </Field>
          <Field label="Amount (₹)" required>
            <Input type="number" value={form.amount} onChange={set("amount")} />
          </Field>
          <Field label="Payment Mode" required>
            <Select value={form.payment_mode} onChange={set("payment_mode")}>
              <option>Cash</option><option>UPI</option><option>Bank</option><option>Cheque</option>
            </Select>
          </Field>
          <Field label="Reference No.">
            <Input value={form.reference_no} onChange={set("reference_no")} placeholder="UTR / cheque no." />
          </Field>
          {form.payment_type === "dealer" && (
            <Field label="Paid At (Agency)">
              <Select value={form.paid_at_agency_id} onChange={set("paid_at_agency_id")}>
                <option value="">— Not via an agency —</option>
                {agencies.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}
              </Select>
            </Field>
          )}
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Remarks">
              <Input value={form.remarks} onChange={set("remarks")} />
            </Field>
          </div>
        </div>
        <PrimaryButton onClick={submit} disabled={saving}>
          {saving ? "Saving..." : "Save Payment & Generate Receipt"}
        </PrimaryButton>
      </Card>

      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-800 mb-1">
        <button
          onClick={() => setLedgerTab("bank")}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${ledgerTab === "bank" ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}
        >
          Bank Transactions
        </button>
        <button
          onClick={() => setLedgerTab("all")}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${ledgerTab === "all" ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}
        >
          All Receipts & Payments
        </button>
      </div>

      {ledgerTab === "bank" ? (
        <BankTransactionsTable
          transactions={bankTransactions}
          loading={bankBalanceLoading || allLoading}
          query={bankQuery}
          setQuery={setBankQuery}
          dateFrom={bankDateFrom}
          setDateFrom={setBankDateFrom}
          dateTo={bankDateTo}
          setDateTo={setBankDateTo}
        />
      ) : (
        <AllPaymentsTable
          payments={allPayments}
          loading={allLoading}
          query={allQuery}
          setQuery={setAllQuery}
          dateFrom={allDateFrom}
          setDateFrom={setAllDateFrom}
          dateTo={allDateTo}
          setDateTo={setAllDateTo}
          isAdmin={isAdmin}
          onBulkDelete={bulkDeletePayments}
          onEdit={setEditingPayment}
          onDelete={deletePayment}
        />
      )}

      {editingPayment && (
        <EditPaymentModal
          payment={editingPayment}
          onClose={() => setEditingPayment(null)}
          onSave={savePaymentEdit}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {showImport && (
        <PaymentsImportModal
          dealers={dealers}
          agencies={agencies}
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            loadRecent();
            loadAllPayments();
          }}
        />
      )}
    </div>
  );
}

// Full history of every payment (receipt) recorded — search + date range,
// entirely client-side over what Payments() already fetched via
// loadAllPayments(). Separate from "Recent Payments" above, which is
// intentionally just the last 20 for a quick glance.
// Sortable column header for AllPaymentsTable — same click-to-sort,
// click-again-to-flip pattern as RecentSortTh above, just a separate
// component since it takes its sort state as props instead of closing
// over local state (AllPaymentsTable owns its own sort state, independent
// of the Recent Payments list's).
function AllSortTh({ label, sortKeyName, sortKey, sortDir, onSort, align = "left" }) {
  return (
    <th
      onClick={() => onSort(sortKeyName)}
      className={`px-3 py-2 text-${align} cursor-pointer select-none whitespace-nowrap`}
    >
      {label} {sortKey === sortKeyName && (sortDir === "asc" ? "↑" : "↓")}
    </th>
  );
}

function AllPaymentsTable({ payments, loading, query, setQuery, dateFrom, setDateFrom, dateTo, setDateTo, isAdmin, onBulkDelete, onEdit, onDelete }) {
  const [selected, setSelected] = useState(new Set());
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const payerName = (p) => p.dealers?.name || (p.paid_at_agency?.name ? `${p.paid_at_agency.name} (Agency)` : "—");

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "amount" || key === "date" ? "desc" : "asc"); }
  };

  const filtered = payments
    .filter((p) => {
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const haystack = [payerName(p), p.applications?.draft_code, p.reference_no, p.remarks, p.payment_mode].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      const paidDate = p.created_at?.slice(0, 10);
      if (dateFrom && paidDate < dateFrom) return false;
      if (dateTo && paidDate > dateTo) return false;
      return true;
    })
    .sort((a, b) => {
      let av, bv;
      if (sortKey === "amount") { av = Number(a.amount) || 0; bv = Number(b.amount) || 0; }
      else if (sortKey === "payer") { av = payerName(a).toLowerCase(); bv = payerName(b).toLowerCase(); }
      else if (sortKey === "application") { av = (a.applications?.draft_code || "").toLowerCase(); bv = (b.applications?.draft_code || "").toLowerCase(); }
      else if (sortKey === "mode") { av = (a.payment_mode || "").toLowerCase(); bv = (b.payment_mode || "").toLowerCase(); }
      else if (sortKey === "reference") { av = (a.receipt_no || a.reference_no || "").toLowerCase(); bv = (b.receipt_no || b.reference_no || "").toLowerCase(); }
      else { av = a.created_at || ""; bv = b.created_at || ""; }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

  // Selection is cleared whenever the visible set changes (new search/date
  // filter) so it can never silently hold onto an id that's since scrolled
  // out of view — "select all" always means "all of what you're looking at
  // right now", not some stale set from before you changed the filter.
  useEffect(() => { setSelected(new Set()); }, [query, dateFrom, dateTo]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));
  const toggleSelectAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map((p) => p.id)));
  };
  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const total = filtered.reduce((sum, p) => sum + Number(p.amount || 0), 0);

  const exportCSV = () => {
    const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Date", "Payer", "Type", "Application", "Amount", "Mode", "Receipt No", "Reference No", "Paid At Agency", "Remarks"];
    const lines = [header.join(",")];
    filtered.forEach((p) => {
      lines.push([
        escapeCsv(new Date(p.created_at).toLocaleDateString()),
        escapeCsv(p.dealers?.name || p.paid_at_agency?.name || ""),
        escapeCsv(p.dealer_id ? "Dealer" : "Agency"),
        escapeCsv(p.applications?.draft_code || ""),
        escapeCsv(p.amount),
        escapeCsv(p.payment_mode),
        escapeCsv(p.receipt_no || ""),
        escapeCsv(p.reference_no || ""),
        escapeCsv(p.dealer_id ? (p.paid_at_agency?.name || "") : ""),
        escapeCsv(p.remarks || ""),
      ].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "all-payments.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Card title="All Receipts & Payments">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Field label="Search">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Dealer, agency, application, reference…" />
        </Field>
        <Field label="From">
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Field>
        <GhostButton onClick={exportCSV}>⬇ Export CSV</GhostButton>
        {isAdmin && selected.size > 0 && (
          <button
            onClick={() => onBulkDelete(Array.from(selected))}
            className="px-3 py-2 rounded-lg text-sm font-semibold bg-rose-600 hover:bg-rose-700 text-white"
          >
            Delete Selected ({selected.size})
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 py-6 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 py-6 text-center">No payments match this filter.</p>
      ) : (
        <>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
            {filtered.length} payment{filtered.length !== 1 ? "s" : ""} · ₹{total.toLocaleString("en-IN")} total
          </p>
          <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg max-h-[480px] overflow-y-auto">
            <table className="m-scroll w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-500 sticky top-0">
                <tr>
                  {isAdmin && (
                    <th className="px-3 py-2 text-left w-8">
                      <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
                    </th>
                  )}
                  <AllSortTh label="Date" sortKeyName="date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <AllSortTh label="Payer" sortKeyName="payer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <AllSortTh label="Payment Mode" sortKeyName="mode" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <AllSortTh label="Reference No" sortKeyName="reference" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <th className="px-3 py-2 text-left">Remarks</th>
                  <AllSortTh label="Amount" sortKeyName="amount" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  {isAdmin && <th className="px-3 py-2 text-left">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                    {isAdmin && (
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                      </td>
                    )}
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-500">{new Date(p.created_at).toLocaleDateString()}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-300">{payerName(p)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-500">{p.payment_mode}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-500">{p.receipt_no || p.reference_no || "—"}</td>
                    <td className="px-3 py-2 max-w-[220px] truncate text-slate-500 dark:text-slate-500" title={p.remarks || ""}>{p.remarks || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-semibold text-emerald-600">₹{Number(p.amount).toLocaleString("en-IN")}</td>
                    {isAdmin && (
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button onClick={() => onEdit(p)} className="text-xs font-semibold text-blue-600 hover:underline mr-3">Edit</button>
                        <button onClick={() => onDelete(p)} className="text-xs font-semibold text-rose-500 hover:underline">Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// Bank Transactions — a chronological feed of every rupee that actually
// moves through the bank account, built straight from the application and
// payment data already loaded on this page (no separate table to keep in
// sync). Three kinds of rows only:
//   • RTO Fee (debit)   — an application's rto_fee, dated by the day the
//     fee was entered (fee_entered_at), falling back to application_date
//     and then submitted_at when the fee was recorded before those existed.
//   • Received (credit) — a dealer payment collected via UPI.
//   • Paid to Agency (debit) — a direct agency payment sent by
//     Bank/UPI/Cheque (Cash paid at the counter never touches the bank).
function BankTransactionsTable({ transactions, loading, query, setQuery, dateFrom, setDateFrom, dateTo, setDateTo }) {
  const filtered = transactions.filter((t) => {
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!`${t.label} ${t.mode}`.toLowerCase().includes(q)) return false;
    }
    const d = t.date?.slice(0, 10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  });

  const credits = filtered.filter((t) => t.type === "credit").reduce((s, t) => s + t.amount, 0);
  const debits = filtered.filter((t) => t.type === "debit").reduce((s, t) => s + t.amount, 0);

  return (
    <Card title="Bank Transactions">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Field label="Search">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Application, dealer, agency…" />
        </Field>
        <Field label="From">
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Field>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 py-6 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 py-6 text-center">No bank transactions match this filter.</p>
      ) : (
        <>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
            {filtered.length} transaction{filtered.length !== 1 ? "s" : ""} · +₹{credits.toLocaleString("en-IN")} in · −₹{debits.toLocaleString("en-IN")} out
          </p>
          <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg max-h-[480px] overflow-y-auto">
            <table className="m-scroll w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-500 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Date</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Mode</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">Amount</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">Balance</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-500">{new Date(t.date).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{t.label}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-500">{t.mode}</td>
                    <td className={`px-3 py-2 whitespace-nowrap text-right font-semibold ${t.type === "credit" ? "text-emerald-600" : "text-rose-500"}`}>
                      {t.type === "credit" ? "+" : "−"}₹{t.amount.toLocaleString("en-IN")}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap text-right ${t.balance < 0 ? "text-rose-600" : "text-slate-500 dark:text-slate-500"}`}>
                      ₹{t.balance.toLocaleString("en-IN")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// Bulk CSV import for Payments — mirrors the Applications import feature:
// parse, resolve names to IDs, preview with per-row validation, then insert
// only the valid+included rows. Each imported payment gets the exact same
// ledger postings (dealer credit, + agency credit if "Paid At Agency" is
// filled in) as a normal single payment via the form above, so bulk-
// imported payments show up in Ledger identically to manually entered ones.
//
// Expected CSV headers (case-insensitive, flexible spacing): Dealer,
// Application (optional — draft code), Amount, Payment Mode (optional,
// defaults to Cash), Reference No (optional), Paid At Agency (optional),
// Remarks (optional).
function PaymentsImportModal({ dealers, agencies, onClose, onImported }) {
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // A ready-to-fill CSV with the exact headers this importer looks for,
  // plus two example rows — one normal Dealer payment, one pure Agency
  // payment (Dealer left blank) — so both patterns are obvious at a glance
  // rather than only explained in the paragraph above.
  const downloadTemplate = () => {
    const header = ["Dealer", "Amount", "Application", "Payment Mode", "Reference No", "Date", "Paid At Agency", "Remarks"];
    const sampleDealer = [dealers[0]?.name || "ABC Motors", "1900", "", "UPI", "UPI-REF-123", "", "", "LL fee"];
    const sampleAgency = ["", "5000", "", "Cash", "", "", agencies[0]?.name || "Agency Name", "Cash collected at counter"];
    const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [header, sampleDealer, sampleAgency].map((row) => row.map(escapeCsv).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "payments-import-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleFile = (file) => {
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setError("");
    const reader = new FileReader();
    reader.onload = async (e) => {
      const parsed = parseCSV(String(e.target.result));

      // Fetch every existing non-empty reference_no once, so each row can
      // be checked against real duplicates without a query per row.
      const { data: existingRefs } = await supabase.from("payments").select("reference_no").not("reference_no", "is", null);
      const existingRefSet = new Set((existingRefs || []).map((r) => r.reference_no));
      const seenInThisFile = new Set(); // catches two rows in the SAME csv reusing one reference no.

      const built = parsed.map((raw) => {
        const get = (...keys) => {
          for (const k of keys) {
            const hit = Object.keys(raw).find((h) => h.toLowerCase().replace(/[^a-z0-9]/g, "") === k);
            if (hit && raw[hit]) return raw[hit];
          }
          return "";
        };
        const dealerRaw = get("dealer", "dealername", "dealercode");
        const applicationRaw = get("application", "draftcode", "draftid");
        const amountRaw = get("amount");
        const modeRaw = get("paymentmode", "mode") || "Cash";
        const referenceRaw = get("referenceno", "reference", "utr", "voucherno", "vouchernumber", "voucher");
        const agencyRaw = get("paidatagency", "agency");
        const remarksRaw = get("remarks", "remark", "narration", "description");
        const dateRaw = get("date", "paymentdate", "paidon", "paiddate");
        const paidOn = dateRaw ? ddmmyyyyToISO(dateRaw) : null;

        const dealer = findByLabel(dealers, dealerRaw, ["name", "code", "short_name"]);
        const agency = agencyRaw ? findByLabel(agencies, agencyRaw, ["name", "code"]) : null;
        const amount = parseFloat(amountRaw);

        const errors = [];
        // A row is valid if it has a payer — either a Dealer, or (when
        // Dealer is left blank on purpose) an Agency standing in as a pure
        // Agency payment. Only actually error if dealerRaw was given but
        // didn't match anything, or if BOTH are missing entirely.
        if (dealerRaw && !dealer) errors.push(`Dealer "${dealerRaw}" not found`);
        if (!dealerRaw && !agencyRaw) errors.push("Either Dealer or Agency is required");
        if (agencyRaw && !agency) errors.push(`Agency "${agencyRaw}" not found`);
        if (!amountRaw || Number.isNaN(amount) || amount <= 0) errors.push("Amount is missing or invalid");

        if (dateRaw && !paidOn) errors.push(`Date "${dateRaw}" not recognized (use DD-MM-YYYY)`);

        if (referenceRaw) {
          if (existingRefSet.has(referenceRaw)) errors.push(`Reference "${referenceRaw}" is already recorded — looks like a duplicate`);
          else if (seenInThisFile.has(referenceRaw)) errors.push(`Reference "${referenceRaw}" appears more than once in this file`);
          else seenInThisFile.add(referenceRaw);
        }

        return {
          dealerRaw, applicationRaw, agencyRaw,
          included: errors.length === 0,
          errors,
          payload: {
            dealer_id: dealer?.id,
            dealer_name: dealer?.name,
            agency_id: agency?.id,
            agency_name: agency?.name,
            application_draft_code: applicationRaw || null,
            amount,
            payment_mode: modeRaw,
            reference_no: referenceRaw || null,
            remarks: remarksRaw || null,
            paid_on: paidOn,
          },
        };
      });
      setPreview(built);
    };
    reader.readAsText(file);
  };

  const toggleIncluded = (i) => setPreview((p) => p.map((r, idx) => (idx === i ? { ...r, included: !r.included } : r)));
  const includedCount = preview.filter((r) => r.included && r.errors.length === 0).length;

  const runImport = async () => {
    const rowsToImport = preview.filter((r) => r.included && r.errors.length === 0);
    if (!rowsToImport.length) return;
    setImporting(true);
    setError("");
    try {
      const { data: userData } = await supabase.auth.getUser();
      const { data: staffRow } = await supabase.from("staff").select("id").eq("auth_user_id", userData?.user?.id).maybeSingle();

      let imported = 0;
      const ledgerFailures = []; // payments that saved fine but whose ledger entry silently failed — surfaced instead of hidden
      for (const r of rowsToImport) {
        const { payload } = r;

        // Resolve an application draft code to its id, if one was given —
        // best-effort: an unmatched code just leaves the payment untied to
        // a specific application rather than failing the whole row.
        // Doesn't apply at all to a pure Agency row (no dealer_id) since
        // applications are always dealer-scoped.
        let applicationId = null;
        if (payload.application_draft_code && payload.dealer_id) {
          const { data: appRow } = await supabase
            .from("applications")
            .select("id")
            .eq("dealer_id", payload.dealer_id)
            .eq("draft_code", payload.application_draft_code)
            .maybeSingle();
          applicationId = appRow?.id || null;
        }

        let receiptNo = null;
        if (payload.dealer_id) {
          const { data: code, error: codeErr } = await supabase.rpc("next_payment_code", { p_dealer_id: payload.dealer_id });
          if (codeErr) console.error("next_payment_code failed", codeErr);
          else receiptNo = code;
        }

        const { data: paymentRow, error: insertError } = await supabase
          .from("payments")
          .insert({
            dealer_id: payload.dealer_id || null,
            application_id: applicationId,
            amount: payload.amount,
            payment_mode: payload.payment_mode,
            reference_no: payload.reference_no,
            remarks: payload.remarks,
            paid_at_agency_id: payload.agency_id || null,
            received_by: staffRow?.id || null,
            receipt_no: receiptNo,
            ...(payload.paid_on ? { created_at: payload.paid_on } : {}),
          })
          .select()
          .single();

        if (insertError) {
          setError(
            insertError.code === "23505"
              ? `Import stopped: reference "${payload.reference_no}" is already used by another payment.`
              : `Import stopped at "${payload.dealer_name || payload.agency_name}" (₹${payload.amount}): ` + insertError.message
          );
          setImporting(false);
          return;
        }

        const { error: ledgerError } = await supabase.rpc("upsert_ledger_entry_for_payment", {
          p_payment_id: paymentRow.id,
        });
        if (ledgerError) {
          ledgerFailures.push({
            reference_no: payload.reference_no || voucherNo,
            amount: payload.amount,
            name: payload.dealer_name || payload.agency_name,
            message: ledgerError.message,
          });
        }
        imported++;
      }

      setResult({ imported, skipped: preview.length - rowsToImport.length, ledgerFailures });
      setImporting(false);
      onImported();
    } catch (err) {
      setError("Import failed: " + err.message);
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-900 rounded-xl w-full max-w-4xl max-h-[85vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-800 dark:text-slate-100">Import Payments</h3>
          <button onClick={onClose} className="text-slate-400 text-xl leading-none">×</button>
        </div>

        {!preview.length && (
          <div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
              CSV columns: <b>Dealer</b> (name or code) and <b>Amount</b> (required). Leave Dealer blank and fill in <b>Paid At Agency</b> instead
              for a pure Agency payment (no dealer involved) — otherwise Dealer is required. Also: Application (optional — draft code),
              Payment Mode (optional, defaults to Cash), Reference No, Date (optional, DD-MM-YYYY — defaults to today if left blank), Remarks.
            </p>
            <button
              type="button"
              onClick={downloadTemplate}
              className="text-xs font-semibold text-blue-600 hover:underline mb-3 block"
            >
              ⬇ Download CSV template
            </button>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => handleFile(e.target.files?.[0])}
              className="text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-100 dark:file:bg-slate-800 file:text-slate-700 dark:file:text-slate-300 file:font-semibold file:text-sm"
            />
            {fileName && <span className="text-xs text-slate-400 dark:text-slate-500 ml-2">{fileName}</span>}
          </div>
        )}

        {preview.length > 0 && !result && (
          <div>
            <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg mb-4">
              <table className="m-scroll w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Import?</th>
                    <th className="px-3 py-2 text-left">Dealer</th>
                    <th className="px-3 py-2 text-left">Application</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Amount</th>
                    <th className="px-3 py-2 text-left">Mode</th>
                    <th className="px-3 py-2 text-left">Voucher No.</th>
                    <th className="px-3 py-2 text-left">Agency</th>
                    <th className="px-3 py-2 text-left">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className={`border-t border-slate-100 dark:border-slate-800 ${r.errors.length ? "bg-rose-50 dark:bg-rose-500/10" : ""}`}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={r.included} disabled={r.errors.length > 0} onChange={() => toggleIncluded(i)} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.payload.dealer_name || r.dealerRaw || (r.payload.agency_name ? `${r.payload.agency_name} (Agency)` : "—")}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.applicationRaw || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.payload.paid_on ? isoToDDMMYYYY(r.payload.paid_on) : "— (today)"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">₹{r.payload.amount || 0}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.payload.payment_mode}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.payload.reference_no || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.payload.agency_name || "—"}</td>
                      <td className="px-3 py-2 text-rose-600">{r.errors.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <p className="text-rose-500 text-sm mb-3">{error}</p>}
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-500 dark:text-slate-400">{includedCount} of {preview.length} rows will be imported</p>
              <div className="flex gap-2">
                <GhostButton onClick={() => { setPreview([]); setFileName(""); }}>Start Over</GhostButton>
                <PrimaryButton disabled={importing || includedCount === 0} onClick={runImport}>
                  {importing ? "Importing…" : `Import ${includedCount} Row${includedCount !== 1 ? "s" : ""}`}
                </PrimaryButton>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="text-center py-6">
            <p className="text-lg font-semibold text-emerald-600">Imported {result.imported} payment{result.imported !== 1 ? "s" : ""}</p>
            {result.skipped > 0 && <p className="text-sm text-slate-400 mt-1">{result.skipped} row(s) skipped</p>}
            {result.ledgerFailures?.length > 0 && (
              <div className="mt-4 text-left rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 px-3 py-2">
                <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">
                  ⚠ {result.ledgerFailures.length} payment{result.ledgerFailures.length !== 1 ? "s" : ""} saved, but the ledger entry failed to post:
                </p>
                <div className="mt-1 max-h-32 overflow-auto rounded-lg border border-rose-200 dark:border-rose-500/30 text-xs">
                  <table className="m-scroll w-full">
                    <tbody className="divide-y divide-rose-100 dark:divide-rose-500/10">
                      {result.ledgerFailures.map((f, i) => (
                        <tr key={i}>
                          <td className="px-2 py-1 whitespace-nowrap font-mono">{f.reference_no}</td>
                          <td className="px-2 py-1">{f.name} · ₹{f.amount}</td>
                          <td className="px-2 py-1 text-rose-600 dark:text-rose-400">{f.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <PrimaryButton onClick={onClose} className="mt-4">Done</PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
}

// Admin-only quick edit for a payment row — date/amount/mode/reference/
// remarks (dealer, application, and Paid-At-Agency stay fixed to avoid the
// ledger-reversal complexity of re-pointing a payment to a different
// dealer or agency after the fact).
function EditPaymentModal({ payment, onClose, onSave }) {
  const [f, setF] = useState({
    amount: payment.amount,
    payment_mode: payment.payment_mode,
    reference_no: payment.reference_no || "",
    remarks: payment.remarks || "",
    paid_on: payment.created_at ? payment.created_at.slice(0, 10) : "",
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <Modal title={`Edit Payment — ${payment.dealers?.name || ""}`} onClose={onClose}>
      <Field label="Paid On" required><Input type="date" value={f.paid_on} onChange={set("paid_on")} /></Field>
      <Field label="Amount" required><Input type="number" value={f.amount} onChange={set("amount")} /></Field>
      <Field label="Payment Mode">
        <Select value={f.payment_mode} onChange={set("payment_mode")}>
          {["Cash", "UPI", "Bank Transfer", "Cheque", "Card"].map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
      </Field>
      <Field label="Reference No."><Input value={f.reference_no} onChange={set("reference_no")} /></Field>
      <Field label="Remarks"><Input value={f.remarks} onChange={set("remarks")} /></Field>
      <div className="flex gap-2">
        <PrimaryButton onClick={() => onSave(f)}>Save Changes</PrimaryButton>
        <GhostButton onClick={onClose}>Cancel</GhostButton>
      </div>
    </Modal>
  );
}