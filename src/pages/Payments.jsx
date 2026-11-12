// src/pages/Payments.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, Input, Select, PrimaryButton, GhostButton, DangerButton, Modal, Toast } from "../components/UI";
import SearchableSelect, { dealerOptionLabel } from "../components/SearchableSelect";
import StaffQrSendPanel from "../components/StaffQrSendPanel";
import { fmtDate } from "../lib/dates";

const EMPTY_FORM = { payment_type: "dealer", dealer_id: "", to_dealer_id: "", application_id: "", amount: "", payment_mode: "Cash", reference_no: "", remarks: "", paid_at_agency_id: "", paid_on: "" };

export default function Payments({ staff } = {}) {
  const isAdmin = staff?.roles?.role_name === "Admin";
  const [dealers, setDealers] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [applications, setApplications] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [recent, setRecent] = useState([]);
  const [editingTransfer, setEditingTransfer] = useState(null);
  const [transfers, setTransfers] = useState([]); // dealer -> dealer transfers (admin-created)
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showSendQr, setShowSendQr] = useState(false);
  const [allPayments, setAllPayments] = useState([]);
  const [allLoading, setAllLoading] = useState(true);
  const [recentQuery, setRecentQuery] = useState("");
  const [recentSortKey, setRecentSortKey] = useState("date");
  const [recentSortDir, setRecentSortDir] = useState("desc");
  const [bankFeeDeducted, setBankFeeDeducted] = useState(0); // sum of every application's RTO/govt fee — always paid out of the bank
  const [bankBalanceLoading, setBankBalanceLoading] = useState(true);
  const [bankBalanceError, setBankBalanceError] = useState("");
  const [feeRows, setFeeRows] = useState([]); // application fee rows powering the Bank Transactions table

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.tagName === "SELECT" ? e.target.value : e.target.value.toUpperCase() }));

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("dealers").select("id, name, code, short_name, mobile");
      setDealers(data || []);
      const { data: a } = await supabase.from("agencies").select("id, name, code");
      setAgencies(a || []);
      loadRecent();
      loadAllPayments();
      loadBankBalance();
      loadTransfers();
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
  const bankUpiReceived = React.useMemo(() => allPayments
    .filter((p) => p.dealer_id && p.payment_mode === "UPI")
    .reduce((acc, p) => acc + Number(p.amount || 0), 0), [allPayments]);
  // Money OUT to agencies: a direct agency payment (no dealer involved)
  // sent by Bank/UPI/Cheque comes straight out of the bank; Cash paid at
  // the counter doesn't.
  const bankAgencyPaidOut = React.useMemo(() => allPayments
    .filter((p) => !p.dealer_id && p.paid_at_agency_id && p.payment_mode !== "Cash")
    .reduce((acc, p) => acc + Number(p.amount || 0), 0), [allPayments]);
  const bankBalance = bankUpiReceived - bankFeeDeducted - bankAgencyPaidOut;

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

  const loadTransfers = async () => {
    const { data, error } = await supabase.rpc("list_dealer_transfers", { p_limit: 50 });
    if (error) { console.error("list_dealer_transfers", error); return; }
    setTransfers(data || []);
  };

  const saveTransferEdit = async (f) => {
    if (!f.from_dealer_id || !f.to_dealer_id) { setToast("Select both dealers"); return; }
    if (f.from_dealer_id === f.to_dealer_id) { setToast("From and To dealer must be different"); return; }
    if (!f.amount || parseFloat(f.amount) <= 0) { setToast("Amount is required"); return; }
    const { error } = await supabase.rpc("update_dealer_transfer", {
      p_group_id: editingTransfer.transfer_group_id,
      p_from_dealer_id: f.from_dealer_id,
      p_to_dealer_id: f.to_dealer_id,
      p_amount: parseFloat(f.amount),
      p_entry_date: f.entry_date || null,
      p_reference_no: f.reference_no?.trim() || null,
      p_remarks: f.remarks || null,
    });
    if (error) { setToast("Failed to update transfer: " + error.message); return; }
    setToast("Transfer updated — both ledgers adjusted");
    setEditingTransfer(null);
    loadTransfers();
  };

  const deleteTransfer = async (t) => {
    if (!window.confirm(`Delete transfer of ₹${Number(t.amount).toLocaleString("en-IN")} (${t.from_dealer} → ${t.to_dealer})? Both ledgers will be reversed.`)) return;
    const { error } = await supabase.rpc("delete_dealer_transfer", { p_group_id: t.transfer_group_id });
    if (error) { setToast("Failed to delete transfer: " + error.message); return; }
    setToast("Transfer deleted");
    loadTransfers();
  };

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
    const type = form.payment_type; // dealer | agency | dealer_agency | dealer_dealer
    const isAgencyOnly = type === "agency";
    const isDealerToAgency = type === "dealer_agency";
    const isTransfer = type === "dealer_dealer";

    if (isTransfer) {
      if (!isAdmin) { setToast("Only Admin can move a payment from one dealer to another"); return; }
      if (!form.dealer_id || !form.to_dealer_id) { setToast("Select both From Dealer and To Dealer"); return; }
      if (form.dealer_id === form.to_dealer_id) { setToast("From Dealer and To Dealer must be different"); return; }
      if (!form.amount || parseFloat(form.amount) <= 0) { setToast("Amount is required"); return; }
      setSaving(true);
      const { error: trfErr } = await supabase.rpc("record_dealer_transfer", {
        p_from_dealer_id: form.dealer_id,
        p_to_dealer_id: form.to_dealer_id,
        p_amount: parseFloat(form.amount),
        p_entry_date: form.paid_on || null,
        p_reference_no: form.reference_no?.trim() || null,
        p_remarks: form.remarks || null,
      });
      setSaving(false);
      if (trfErr) { setToast("Transfer failed: " + trfErr.message); return; }
      const fromName = dealers.find((d) => d.id === form.dealer_id)?.name;
      const toName = dealers.find((d) => d.id === form.to_dealer_id)?.name;
      setToast(`₹${Number(form.amount).toLocaleString("en-IN")} moved from ${fromName} to ${toName} — both ledgers updated`);
      setForm(EMPTY_FORM);
      loadTransfers();
      return;
    }

    if (isAgencyOnly ? !form.paid_at_agency_id : !form.dealer_id) {
      setToast(isAgencyOnly ? "Agency and amount are required" : "Dealer and amount are required");
      return;
    }
    if (isDealerToAgency && !form.paid_at_agency_id) {
      setToast("Select the agency the dealer paid");
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
        paid_at_agency_id: (isAgencyOnly || isDealerToAgency) ? (form.paid_at_agency_id || null) : null,
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
    const agencyName = (isAgencyOnly || isDealerToAgency) ? agencies.find((a) => a.id === form.paid_at_agency_id)?.name : null;
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
    setForm(EMPTY_FORM);
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
        </div>
      </div>

      {showSendQr && (
        <StaffQrSendPanel staff={staff} dealers={dealers} onClose={() => { setShowSendQr(false); loadRecent(); loadAllPayments(); }} />
      )}

      <Card title="Record New Payment">
        <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Payment Type" required>
            <Select value={form.payment_type} onChange={set("payment_type")}>
              <option value="dealer">Pay to Dealer</option>
              <option value="agency">Pay to Agency</option>
              <option value="dealer_agency">Pay Dealer to Agency</option>
              {isAdmin && <option value="dealer_dealer">Pay Dealer to Dealer</option>}
            </Select>
          </Field>
          {form.payment_type === "agency" ? (
            <Field label="Agency" required>
              <SearchableSelect
                value={form.paid_at_agency_id}
                onChange={(id) => setForm((s) => ({ ...s, paid_at_agency_id: id }))}
                options={agencies.map((a) => ({ id: a.id, name: `${a.name} (${a.code})` }))}
                placeholder="Type to search agency…"
              />
            </Field>
          ) : (
            <>
              <Field label={form.payment_type === "dealer_dealer" ? "From Dealer" : "Dealer"} required>
                <SearchableSelect
                  value={form.dealer_id}
                  onChange={(id) => setForm((s) => ({ ...s, dealer_id: id }))}
                  options={dealers.map((d) => ({ id: d.id, name: dealerOptionLabel(d, true) }))}
                  placeholder="Type to search dealer…"
                />
              </Field>
              {form.payment_type === "dealer_dealer" ? (
                <Field label="To Dealer" required>
                  <SearchableSelect
                    value={form.to_dealer_id}
                    onChange={(id) => setForm((s) => ({ ...s, to_dealer_id: id }))}
                    options={dealers.filter((d) => d.id !== form.dealer_id).map((d) => ({ id: d.id, name: dealerOptionLabel(d, true) }))}
                    placeholder="Type to search dealer…"
                  />
                </Field>
              ) : (
                <>
                  {form.payment_type === "dealer_agency" && (
                    <Field label="Agency (dealer paid here)" required>
                      <SearchableSelect
                        value={form.paid_at_agency_id}
                        onChange={(id) => setForm((s) => ({ ...s, paid_at_agency_id: id }))}
                        options={agencies.map((a) => ({ id: a.id, name: `${a.name} (${a.code})` }))}
                        placeholder="Type to search agency…"
                      />
                    </Field>
                  )}
                  <Field label="Application (optional)">
                    <Select value={form.application_id} onChange={set("application_id")} disabled={!form.dealer_id}>
                      <option value="">— General payment, not tied to one application —</option>
                      {applications.map((a) => <option key={a.id} value={a.id}>{a.draft_code} — {a.applicant_name}</option>)}
                    </Select>
                  </Field>
                </>
              )}
            </>
          )}
          <Field label="Date">
            <Input type="date" value={form.paid_on} onChange={set("paid_on")} />
          </Field>
          <Field label="Amount (₹)" required>
            <Input type="number" value={form.amount} onChange={set("amount")} />
          </Field>
          {form.payment_type !== "dealer_dealer" && (
            <Field label="Payment Mode" required>
              <Select value={form.payment_mode} onChange={set("payment_mode")}>
                <option>Cash</option><option>UPI</option><option>Bank</option><option>Cheque</option>
              </Select>
            </Field>
          )}
          <Field label="Reference No.">
            <Input value={form.reference_no} onChange={set("reference_no")} placeholder="UTR / cheque no." />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Remarks">
              <Input value={form.remarks} onChange={set("remarks")} />
            </Field>
          </div>
        </div>
        <PrimaryButton onClick={submit} disabled={saving}>
          {saving ? "Saving..." : form.payment_type === "dealer_dealer" ? "Move Payment Between Dealers" : "Save Payment & Generate Receipt"}
        </PrimaryButton>
      </Card>

      {isAdmin && transfers.length > 0 && (
        <Card title="Recent Dealer → Dealer Transfers">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">From Dealer</th>
                  <th className="px-3 py-2 text-left">To Dealer</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">Reference</th>
                  <th className="px-3 py-2 text-left">Remarks</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.transfer_group_id} className="border-t border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100">
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(t.entry_date)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.from_dealer}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.to_dealer}</td>
                    <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">₹{Number(t.amount).toLocaleString("en-IN")}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.reference_no || "—"}</td>
                    <td className="px-3 py-2">{t.remarks || "—"}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={() => setEditingTransfer(t)} className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline mr-3">Edit</button>
                      <button onClick={() => deleteTransfer(t)} className="text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editingTransfer && (
        <EditTransferModal
          transfer={editingTransfer}
          dealers={dealers}
          onClose={() => setEditingTransfer(null)}
          onSave={saveTransferEdit}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

// Admin-only edit of a Dealer -> Dealer transfer. Saves both ledger halves
// together through update_dealer_transfer.
function EditTransferModal({ transfer, dealers, onClose, onSave }) {
  const [f, setF] = useState({
    from_dealer_id: transfer.from_dealer_id,
    to_dealer_id: transfer.to_dealer_id,
    amount: transfer.amount,
    entry_date: transfer.entry_date ? String(transfer.entry_date).slice(0, 10) : "",
    reference_no: transfer.reference_no || "",
    remarks: transfer.remarks || "",
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const opts = dealers.map((d) => ({ id: d.id, name: dealerOptionLabel(d, true) }));

  return (
    <Modal title={`Edit Transfer — ${transfer.from_dealer} → ${transfer.to_dealer}`} onClose={onClose}>
      <Field label="From Dealer" required>
        <SearchableSelect value={f.from_dealer_id} onChange={(id) => setF((s) => ({ ...s, from_dealer_id: id }))} options={opts} placeholder="Type to search dealer…" />
      </Field>
      <Field label="To Dealer" required>
        <SearchableSelect value={f.to_dealer_id} onChange={(id) => setF((s) => ({ ...s, to_dealer_id: id }))} options={opts.filter((o) => o.id !== f.from_dealer_id)} placeholder="Type to search dealer…" />
      </Field>
      <Field label="Date"><Input type="date" value={f.entry_date} onChange={set("entry_date")} /></Field>
      <Field label="Amount" required><Input type="number" value={f.amount} onChange={set("amount")} /></Field>
      <Field label="Reference No."><Input value={f.reference_no} onChange={set("reference_no")} /></Field>
      <Field label="Remarks"><Input value={f.remarks} onChange={set("remarks")} /></Field>
      <div className="flex gap-2">
        <PrimaryButton onClick={() => onSave(f)}>Save Changes</PrimaryButton>
        <GhostButton onClick={onClose}>Cancel</GhostButton>
      </div>
    </Modal>
  );
}
