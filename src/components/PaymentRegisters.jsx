// src/components/PaymentRegisters.jsx
//
// "Bank Transactions" and "All Receipts & Payments" — moved here from the
// Payments page so they live under Ledger. Loads its own data, so Ledger can
// mount it without Payments being open. `view` is "bank" or "all".
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, Input, Select, PrimaryButton, GhostButton, Modal, Toast } from "./UI";
import { fmtDate } from "../lib/dates";

export default function PaymentRegisters({ view = "bank", isAdmin = false }) {
  const [allPayments, setAllPayments] = useState([]);
  const [allLoading, setAllLoading] = useState(true);
  const [allQuery, setAllQuery] = useState("");
  const [allDateFrom, setAllDateFrom] = useState("");
  const [allDateTo, setAllDateTo] = useState("");
  const [feeRows, setFeeRows] = useState([]);
  const [feeLoading, setFeeLoading] = useState(true);
  const [feeError, setFeeError] = useState("");
  const [bankQuery, setBankQuery] = useState("");
  const [bankDateFrom, setBankDateFrom] = useState("");
  const [bankDateTo, setBankDateTo] = useState("");
  const [editingPayment, setEditingPayment] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    loadAllPayments();
    loadFeeRows();
  }, []);

  const loadFeeRows = async () => {
    setFeeLoading(true);
    setFeeError("");
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
      setFeeRows(pages.flat());
    } catch (err) {
      console.error("loadFeeRows:", err);
      setFeeError(err?.message || "Couldn't load application fees");
      setFeeRows([]);
    } finally {
      setFeeLoading(false);
    }
  };

  const loadAllPayments = async () => {
    setAllLoading(true);
    const pageSize = 1000;
    const maxPages = 50;
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

  // Same three flows that make up the Bank Balance on the Payments page:
  // RTO fee debits, dealer-UPI credits, agency Bank/UPI/Cheque debits.
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
      if (p.dealer_id && ["upi", "bank", "cheque"].includes(String(p.payment_mode || "").toLowerCase())) {
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
    rows.sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.id.localeCompare(b.id));
    let running = 0;
    rows.forEach((r) => {
      running += r.type === "credit" ? r.amount : -r.amount;
      r.balance = running;
    });
    return rows.reverse();
  }, [feeRows, allPayments]);

  const deletePaymentAndLedger = async (p) => {
    const { error: ledgerErr } = await supabase.rpc("delete_ledger_entry_for_payment", { p_payment_id: p.id });
    if (ledgerErr) {
      return { ok: false, message: "Failed to remove ledger entry: " + ledgerErr.message + " — payment was NOT deleted." };
    }
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
    loadAllPayments();
  };

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
    loadAllPayments();
  };

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
    const { error: ledgerErr } = await supabase.rpc("upsert_ledger_entry_for_payment", { p_payment_id: original.id });
    setToast(ledgerErr ? "Payment updated, but its ledger entry failed to sync: " + ledgerErr.message : "Payment updated");
    setEditingPayment(null);
    loadAllPayments();
  };

  // The big tables are React.memo'd — keep callback identity stable.
  const bulkDeleteRef = React.useRef(bulkDeletePayments);
  bulkDeleteRef.current = bulkDeletePayments;
  const deleteRef = React.useRef(deletePayment);
  deleteRef.current = deletePayment;
  const onBulkDeleteStable = React.useCallback((ids) => bulkDeleteRef.current(ids), []);
  const onDeleteStable = React.useCallback((p) => deleteRef.current(p), []);

  return (
    <div className="flex flex-col gap-4">
      {feeError && (
        <p className="text-[11px] text-rose-500">
          Couldn't load application fees: {feeError}{" "}
          <button onClick={loadFeeRows} className="underline font-semibold">Retry</button>
        </p>
      )}
      {view === "bank" ? (
        <BankTransactionsTable
          transactions={bankTransactions}
          loading={feeLoading || allLoading}
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
          onBulkDelete={onBulkDeleteStable}
          onEdit={setEditingPayment}
          onDelete={onDeleteStable}
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

const payerName = (p) => p.dealers?.name || (p.paid_at_agency?.name ? `${p.paid_at_agency.name} (Agency)` : "—");

// Rows drawn at a time in the two big tables (the rest load on "Show more").
const TABLE_PAGE = 200;

function AllPaymentsTableInner({ payments, loading, query, setQuery, dateFrom, setDateFrom, dateTo, setDateTo, isAdmin, onBulkDelete, onEdit, onDelete }) {
  const [selected, setSelected] = useState(new Set());
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [limit, setLimit] = useState(TABLE_PAGE);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "amount" || key === "date" ? "desc" : "asc"); }
  };

  const filtered = React.useMemo(() => payments
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
    }), [payments, query, dateFrom, dateTo, sortKey, sortDir]);

  // Selection is cleared whenever the visible set changes (new search/date
  // filter) so it can never silently hold onto an id that's since scrolled
  // out of view — "select all" always means "all of what you're looking at
  // right now", not some stale set from before you changed the filter.
  useEffect(() => { setSelected(new Set()); setLimit(TABLE_PAGE); }, [query, dateFrom, dateTo]);

  // "Select all" covers the rows actually on screen, never rows still hidden
  // behind "Show more" (so a bulk delete can't hit rows you haven't seen).
  const shown = filtered.slice(0, limit);
  const allVisibleSelected = shown.length > 0 && shown.every((p) => selected.has(p.id));
  const toggleSelectAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(shown.map((p) => p.id)));
  };
  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const total = React.useMemo(() => filtered.reduce((sum, p) => sum + Number(p.amount || 0), 0), [filtered]);

  const exportCSV = () => {
    const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Date", "Payer", "Type", "Application", "Amount", "Mode", "Receipt No", "Reference No", "Paid At Agency", "Remarks"];
    const lines = [header.join(",")];
    filtered.forEach((p) => {
      lines.push([
        escapeCsv(fmtDate(p.created_at)),
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
                {shown.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                    {isAdmin && (
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                      </td>
                    )}
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-500">{fmtDate(p.created_at)}</td>
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
          {filtered.length > limit && (
            <div className="flex items-center justify-center gap-3 py-3 text-xs text-slate-500 dark:text-slate-400">
              <span>Showing {limit} of {filtered.length}</span>
              <button onClick={() => setLimit((n) => n + 300)} className="font-semibold text-blue-600 hover:underline">Show 300 more</button>
              <button onClick={() => setLimit(filtered.length)} className="font-semibold text-blue-600 hover:underline">Show all</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
const AllPaymentsTable = React.memo(AllPaymentsTableInner);

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
function BankTransactionsTableInner({ transactions, loading, query, setQuery, dateFrom, setDateFrom, dateTo, setDateTo }) {
  const [limit, setLimit] = useState(TABLE_PAGE);
  useEffect(() => { setLimit(TABLE_PAGE); }, [query, dateFrom, dateTo]);

  const filtered = React.useMemo(() => transactions.filter((t) => {
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!`${t.label} ${t.mode}`.toLowerCase().includes(q)) return false;
    }
    const d = t.date?.slice(0, 10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  }), [transactions, query, dateFrom, dateTo]);

  const { credits, debits } = React.useMemo(() => ({
    credits: filtered.filter((t) => t.type === "credit").reduce((s, t) => s + t.amount, 0),
    debits: filtered.filter((t) => t.type === "debit").reduce((s, t) => s + t.amount, 0),
  }), [filtered]);

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
                {filtered.slice(0, limit).map((t) => (
                  <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500 dark:text-slate-500">{fmtDate(t.date)}</td>
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
          {filtered.length > limit && (
            <div className="flex items-center justify-center gap-3 py-3 text-xs text-slate-500 dark:text-slate-400">
              <span>Showing {limit} of {filtered.length}</span>
              <button onClick={() => setLimit((n) => n + 300)} className="font-semibold text-blue-600 hover:underline">Show 300 more</button>
              <button onClick={() => setLimit(filtered.length)} className="font-semibold text-blue-600 hover:underline">Show all</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
const BankTransactionsTable = React.memo(BankTransactionsTableInner);

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

