// src/pages/Ledger.jsx
import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, GhostButton, PrimaryButton, Modal } from "../components/UI";
import { DealerForm, AgencyForm } from "./Masters";
import { todayIST } from "../lib/dates";

// Tailwind classes per ledger_type, purely cosmetic grouping — payments in
// green, PCC in blue, anything else (service names like LL RIC, MCWG...)
// neutral.
function txnTypeClass(typeLabel) {
  if (!typeLabel) return "text-slate-400 dark:text-slate-500";
  if (typeLabel === "PAYMENT") return "text-emerald-600 dark:text-emerald-400 font-semibold";
  if (typeLabel === "PCC") return "text-sky-600 dark:text-sky-400 font-semibold";
  return "text-slate-600 dark:text-slate-300 font-semibold";
}

// Builds a CSV of the given ledger rows and triggers a browser download —
// entirely client-side, matching how the rest of the app's CSV export/import
// works (see lib/csv.js).
function exportLedgerCSV(entityName, rows) {
  const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Date", "Draft No", "Entry Code", "Type", "Name", "Debit", "Credit", "Running Balance"];
  const lines = [header.join(",")];
  rows.forEach((r) => {
    lines.push([
      escapeCsv(new Date(r.entry_date).toLocaleDateString()),
      escapeCsv(r.draft_code || ""),
      escapeCsv(r.entry_code),
      escapeCsv(r.ledger_type),
      escapeCsv(r.display_name),
      escapeCsv(r.debit > 0 ? r.debit : ""),
      escapeCsv(r.credit > 0 ? r.credit : ""),
      escapeCsv(r.running_balance),
    ].join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(entityName || "ledger").replace(/[^a-z0-9]+/gi, "-")}-ledger.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// "Dealer" (they owe us) and "Agency" (we owe/settle with them) sit here
// as the two ledger heads. Each lists every dealer/agency with its running
// balance; clicking the name or balance opens that entity's transaction
// ledger below. Add/Edit for dealers & agencies lives here too (reusing the
// same forms Masters used to use) — Masters no longer has Dealer/Agency
// tabs, this page is now the only place to manage them.
//
// Backed by ledger_entries (one row per SERVICE or PAYMENT — no more
// double-entry pairs, no more type/name buried in free text) via the
// dealer_ledger / agency_ledger views, which already compute debit,
// credit, and running_balance server-side.
export default function Ledger({ only, initialEntityId, isAdmin = false } = {}) {
  const [entityId, setEntityId] = useState(initialEntityId || "");
  const [entityMode, setEntityMode] = useState(only === "agency" ? "agency" : "dealer"); // "dealer" | "agency"
  const [summary, setSummary] = useState(null); // { credit_limit } for dealer mode, fetched from dealers table directly
  const [rows, setRowsState] = useState([]); // ledger rows for the open entity, from dealer_ledger / agency_ledger
  const [loadError, setLoadError] = useState(null);
  const [entityName, setEntityName] = useState("");
  const [sortKey, setSortKey] = useState("entry_date");
  const [sortDir, setSortDir] = useState("desc"); // newest first by default
  const [periodFrom, setPeriodFrom] = useState(""); // yyyy-mm-dd, empty = no lower bound
  const [periodTo, setPeriodTo] = useState(""); // yyyy-mm-dd, empty = no upper bound
  const [appDetail, setAppDetail] = useState(null); // application row shown in the row-click modal
  const [appDetailLoading, setAppDetailLoading] = useState(false);
  const [appDetailError, setAppDetailError] = useState("");
  const [appDetailRow, setAppDetailRow] = useState(null); // the ledger_entries row that was clicked
  const [editAmount, setEditAmount] = useState(""); // draft value while editing the Amount field in the modal
  const [savingAmount, setSavingAmount] = useState(false);
  const [amountSaveError, setAmountSaveError] = useState("");

  // Clicking a SERVICE row's name looks the application up. Prefer the
  // direct id link (source_application_id) — this is always reliable when
  // present. Older rows, or rows coming from a ledger view that doesn't
  // expose source_application_id, fall back to matching on draft_code
  // (the Draft ID, e.g. "KWN0083") instead of application_no — App No. is
  // often still blank at the point a row gets posted, so it was never a
  // safe key to match on. PAYMENT rows have no application behind them,
  // so they're not clickable.
  const openAppDetail = useCallback(async (row) => {
    if (row.entry_type !== "SERVICE") return;
    setAppDetailLoading(true);
    setAppDetailError("");
    setAmountSaveError("");
    setAppDetail(null);
    setAppDetailRow(row);
    let query = supabase
      .from("applications")
      .select("*, dealers(name,code,short_name), services(parent_service,short_name), staff:assigned_staff_id(full_name)");
    query = row.source_application_id
      ? query.eq("id", row.source_application_id)
      : query.eq("draft_code", row.draft_code);
    const { data, error } = await query.maybeSingle();
    setAppDetailLoading(false);
    if (error || !data) {
      setAppDetailError(`No application found for Draft No: ${row.draft_code || "—"}`);
      return;
    }
    setAppDetail(data);
    setEditAmount(String(row.debit || data.amount || ""));
  }, []);

  // Saves the edited Amount into both ledger_entries and the linked
  // application's own amount field, atomically, via a single Postgres
  // function (see 005_summary_views_and_rpc.sql) — so either both land or
  // neither does, and the ledger + application amount can never go out of
  // sync from a half-completed save.
  const saveAmount = useCallback(async () => {
    if (!appDetailRow || !appDetail) return;
    const newAmount = Number(editAmount);
    if (!Number.isFinite(newAmount) || newAmount < 0) {
      setAmountSaveError("Enter a valid amount");
      return;
    }
    setSavingAmount(true);
    setAmountSaveError("");
    const { error: rpcErr } = await supabase.rpc("update_ledger_entry_amount", {
      p_entry_id: appDetailRow.id,
      p_application_id: appDetail.id,
      p_new_amount: newAmount,
    });
    setSavingAmount(false);
    if (rpcErr) {
      setAmountSaveError(rpcErr.message);
      return;
    }
    // Reflect the new amount locally so the ledger table + running balance
    // recompute without a full refetch of everything.
    setRowsState((prev) =>
      prev.map((r) => (r.id === appDetailRow.id ? { ...r, debit: newAmount } : r))
    );
    setAppDetailRow((r) => ({ ...r, debit: newAmount }));
    setAppDetail((a) => ({ ...a, amount: newAmount }));
  }, [appDetailRow, appDetail, editAmount]);

  // Admin-only: removes a single ledger entry outright — for correcting
  // mistakes like a duplicate row, without touching the application/payment
  // it came from.
  const [deletingRowId, setDeletingRowId] = useState(null);
  const deleteRow = useCallback(async (row) => {
    const amt = row.debit > 0 ? row.debit : row.credit;
    if (!window.confirm(`Delete this ${row.ledger_type} entry of ₹${Number(amt).toLocaleString("en-IN")} (${row.entry_code})? This cannot be undone.`)) return;
    setDeletingRowId(row.id);
    const { error } = await supabase.from("ledger_entries").delete().eq("id", row.id);
    setDeletingRowId(null);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    setRowsState((prev) => prev.filter((r) => r.id !== row.id));
  }, []);

  const sortedRows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === "entry_date") { av = new Date(av); bv = new Date(bv); }
      if (sortKey === "debit" || sortKey === "credit" || sortKey === "running_balance") { av = Number(av || 0); bv = Number(bv || 0); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "entry_date" ? "desc" : "asc"); }
  };
  const ledgerDetailRef = useRef(null);

  const openLedger = (mode, id, name) => {
    setEntityMode(mode);
    setEntityId(id);
    if (name) setEntityName(name);
  };

  // Clicking a name/balance should feel like being taken straight to that
  // entity's transactions — scroll there instead of leaving the person to
  // notice the section changed further down the page.
  useEffect(() => {
    if (entityId) ledgerDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [entityId, entityMode]);

  // Ledger rows don't carry the application's Draft ID themselves, and
  // the dealer_ledger/agency_ledger views these rows come from don't
  // expose source_application_id either. Worse, a direct client SELECT
  // on the ledger_entries table itself is blocked by RLS too (views work
  // because they run as their owner, bypassing RLS — a plain client
  // query doesn't get that). So this goes through
  // get_draft_codes_for_ledger_rows(), a SECURITY DEFINER RPC that reads
  // both source_application_id and draft_code on our behalf in one call.
  const attachDraftCodes = async (rowsIn) => {
    if (!rowsIn.length) return rowsIn;
    const rowIds = rowsIn.map((r) => r.id);
    const { data: resolved, error } = await supabase.rpc("get_draft_codes_for_ledger_rows", { p_ledger_ids: rowIds });
    if (error) {
      console.error("get_draft_codes_for_ledger_rows failed", error);
      return rowsIn;
    }
    const byRowId = Object.fromEntries((resolved || []).map((r) => [r.ledger_id, r]));
    return rowsIn.map((r) => ({
      ...r,
      source_application_id: r.source_application_id || byRowId[r.id]?.source_application_id || null,
      draft_code: byRowId[r.id]?.draft_code || null,
    }));
  };

  useEffect(() => {
    (async () => {
      if (!entityId) { setSummary(null); setRowsState([]); return; }
      if (entityMode === "dealer") {
        const { data: dealerRow } = await supabase.from("dealers").select("name, credit_limit").eq("id", entityId).maybeSingle();
        if (dealerRow?.name) setEntityName(dealerRow.name);
        setSummary(dealerRow);
        const { data: r, error: rErr } = await supabase
          .from("dealer_ledger")
          .select("*")
          .eq("dealer_id", entityId)
          .order("entry_date", { ascending: false });
        setLoadError(rErr?.message || null);
        setRowsState(await attachDraftCodes(r || []));
      } else {
        const { data: agencyRow } = await supabase.from("agencies").select("name").eq("id", entityId).maybeSingle();
        if (agencyRow?.name) setEntityName(agencyRow.name);
        setSummary(null);
        const { data: r, error: rErr } = await supabase
          .from("agency_ledger")
          .select("*")
          .eq("agency_id", entityId)
          .order("entry_date", { ascending: false });
        setLoadError(rErr?.message || null);
        setRowsState(await attachDraftCodes(r || []));
      }
    })();
  }, [entityId, entityMode]);

  // running_balance is already computed server-side by the view (walked
  // chronologically by entry_date/created_at), so the latest row — however
  // the table is currently sorted for display — always carries the correct
  // final balance.
  const runningBalance = useMemo(() => {
    if (!rows.length) return 0;
    return rows.reduce((latest, r) => {
      const d = new Date(r.entry_date);
      return !latest || d >= latest.d ? { d, val: Number(r.running_balance || 0) } : latest;
    }, null)?.val ?? 0;
  }, [rows]);

  // Available Limit = Credit Limit + Running Balance. Running balance is
  // negative when the dealer owes money and positive when they're in
  // credit, so adding it (not subtracting it) correctly shrinks the
  // available limit as debt grows and grows it when they're prepaid.
  const availableLimit = Number(summary?.credit_limit || 0) + Number(runningBalance || 0);

  // Rows within the selected date range (inclusive).
  const periodRows = useMemo(() => {
    if (!periodFrom && !periodTo) return sortedRows;
    // entry_date and the period inputs are plain calendar dates, so compare
    // them as "YYYY-MM-DD" strings. Building Date objects from them mixed UTC
    // midnight (entry_date) with local midnight (the range), which is only
    // right by accident in IST.
    return sortedRows.filter((r) => {
      const day = String(r.entry_date).slice(0, 10);
      if (periodFrom && day < periodFrom) return false;
      if (periodTo && day > periodTo) return false;
      return true;
    });
  }, [sortedRows, periodFrom, periodTo]);

  const periodTotals = useMemo(
    () =>
      periodRows.reduce(
        (acc, r) => {
          acc.debit += Number(r.debit || 0);
          acc.credit += Number(r.credit || 0);
          return acc;
        },
        { debit: 0, credit: 0 }
      ),
    [periodRows]
  );

  return (
    <div>
      {!only && (
        <div className="no-print flex gap-2 mb-4">
          <button
            onClick={() => setEntityMode("dealer")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${
              entityMode === "dealer" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            }`}
          >
            Dealer
          </button>
          <button
            onClick={() => setEntityMode("agency")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${
              entityMode === "agency" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            }`}
          >
            Agency
          </button>
          <button
            onClick={() => setEntityMode("bank")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${
              entityMode === "bank" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            }`}
          >
            Bank
          </button>
        </div>
      )}

      {(only === "bank" || (!only && entityMode === "bank")) && <BankTab />}

      {(only === "dealer" || (!only && entityMode === "dealer")) && (
        <SundryHead
          title="Dealer"
          subtitle="Dealers — amounts owed to us"
          entityMode="dealer"
          table="dealers"
          balancesTable="dealer_ledger_balances"
          balancesKey="dealer_id"
          Form={DealerForm}
          selectedId={entityMode === "dealer" ? entityId : null}
          onOpenLedger={(id, name) => openLedger("dealer", id, name)}
          className="no-print"
        />
      )}

      {(only === "agency" || (!only && entityMode === "agency")) && (
        <SundryHead
          title="Agency"
          subtitle="Agencies — amounts we owe / settle with them"
          entityMode="agency"
          table="agencies"
          balancesTable="agency_ledger_balances"
          balancesKey="agency_id"
          Form={AgencyForm}
          selectedId={entityMode === "agency" ? entityId : null}
          onOpenLedger={(id, name) => openLedger("agency", id, name)}
          className="no-print"
        />
      )}

      {entityId && (
        <div className="mt-6" ref={ledgerDetailRef}>
          <div className="no-print flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{entityName || "Ledger"}</h3>
            <div className="flex items-center gap-3">
              <button
                onClick={() => window.open(`?nav=${entityMode === "dealer" ? "dealerLedger" : "agencyLedger"}&entity=${entityId}`, "_blank", "noopener,noreferrer")}
                className="text-sm font-semibold text-slate-500 hover:text-blue-600"
              >
                ↗ Open in New Tab
              </button>
              <button onClick={() => window.print()} className="text-sm font-semibold text-slate-500 hover:text-blue-600">
                🖶 Print
              </button>
              <button onClick={() => exportLedgerCSV(entityName, periodRows)} className="text-sm font-semibold text-slate-500 hover:text-blue-600">
                ⬇ Export CSV
              </button>
            </div>
          </div>
          <h3 className="hidden print:block text-lg font-bold mb-4">{entityName || "Ledger"} — Ledger Statement</h3>
          <div className="no-print flex items-end justify-between flex-wrap gap-3 mb-4">
            <div className="flex items-end gap-3">
              <div>
                <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">From</label>
                <input
                  type="date"
                  value={periodFrom}
                  onChange={(e) => setPeriodFrom(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">To</label>
                <input
                  type="date"
                  value={periodTo}
                  onChange={(e) => setPeriodTo(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
                />
              </div>
              {(periodFrom || periodTo) && (
                <button
                  onClick={() => { setPeriodFrom(""); setPeriodTo(""); }}
                  className="text-sm font-semibold text-slate-500 hover:text-blue-600 pb-1.5"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-5">
            <Card>
              <p className="text-xs text-slate-400 dark:text-slate-500">Running Balance</p>
              <p className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">₹{Number(runningBalance || 0).toLocaleString("en-IN")}</p>
              {loadError && <p className="text-[11px] text-amber-600 mt-1">Error loading ledger: {loadError}</p>}
            </Card>
            {entityMode === "dealer" && summary && (
              <>
                <Card>
                  <p className="text-xs text-slate-400 dark:text-slate-500">Credit Limit</p>
                  <p className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">₹{Number(summary.credit_limit || 0).toLocaleString("en-IN")}</p>
                </Card>
                <Card>
                  <p className="text-xs text-slate-400 dark:text-slate-500">Available Limit</p>
                  <p className="text-xl font-bold text-emerald-600 mt-1">₹{availableLimit.toLocaleString("en-IN")}</p>
                </Card>
              </>
            )}
            <Card>
              <p className="text-xs text-slate-400 dark:text-slate-500">Total Debit{(periodFrom || periodTo) ? " (period)" : ""}</p>
              <p className="text-xl font-bold text-rose-600 mt-1">₹{periodTotals.debit.toLocaleString("en-IN")}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-400 dark:text-slate-500">Total Credit{(periodFrom || periodTo) ? " (period)" : ""}</p>
              <p className="text-xl font-bold text-emerald-600 mt-1">₹{periodTotals.credit.toLocaleString("en-IN")}</p>
            </Card>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
            <table className="m-scroll w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
                <tr>
                  <SortableTh label="Date" sortKeyName="entry_date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Draft No" sortKeyName="draft_code" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Entry Code" sortKeyName="entry_code" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <th className="px-3 py-2 text-left">Type</th>
                  <SortableTh label="Name" sortKeyName="display_name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Debit" sortKeyName="debit" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  <SortableTh label="Credit" sortKeyName="credit" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  <SortableTh label="Running Balance" sortKeyName="running_balance" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  {isAdmin && <th className="px-3 py-2 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {periodRows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">{new Date(r.entry_date).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">{r.draft_code || "—"}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">{r.entry_code}</td>
                    <td className={`px-3 py-2 whitespace-nowrap ${txnTypeClass(r.ledger_type)}`}>{r.ledger_type || "—"}</td>
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                      {r.entry_type === "SERVICE" ? (
                        <button
                          type="button"
                          onClick={() => openAppDetail(r)}
                          className="text-left hover:underline decoration-dotted text-blue-600 dark:text-blue-400"
                          title="View application details"
                        >
                          {r.display_name}
                        </button>
                      ) : (
                        <>
                          {r.display_name}
                          {r.payment_mode && <span className="text-slate-400 dark:text-slate-500"> · {r.payment_mode}{r.reference_no ? ` ${r.reference_no}` : ""}</span>}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap text-rose-600">
                      {r.debit > 0 ? `₹${Number(r.debit).toLocaleString("en-IN")}` : ""}
                    </td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap text-emerald-600">
                      {r.credit > 0 ? `₹${Number(r.credit).toLocaleString("en-IN")}` : ""}
                    </td>
                    <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${r.running_balance < 0 ? "text-rose-600" : "text-slate-700 dark:text-slate-300"}`}>
                      ₹{Number(r.running_balance).toLocaleString("en-IN")}
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => deleteRow(r)}
                          disabled={deletingRowId === r.id}
                          className="text-rose-600 hover:text-rose-700 text-xs font-medium disabled:opacity-50"
                          title="Delete this ledger entry"
                        >
                          {deletingRowId === r.id ? "Deleting…" : "Delete"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {periodRows.length === 0 && (
                  <tr><td colSpan={isAdmin ? 8 : 7} className="text-center text-slate-400 dark:text-slate-500 py-8">No transactions yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {(appDetailLoading || appDetail || appDetailError) && (
        <Modal
          title="Application Details"
          onClose={() => { setAppDetail(null); setAppDetailError(""); setAppDetailRow(null); setAmountSaveError(""); }}
        >
          {appDetailLoading && <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>}
          {appDetailError && <p className="text-sm text-rose-600">{appDetailError}</p>}
          {appDetail && (
            <div className="space-y-3 text-sm">
              <Row label="Applicant" value={appDetail.applicant_name} />
              <Row label="App No." value={appDetail.application_no} />
              <Row label="Status" value={appDetail.status} />
              <Row label="Service" value={appDetail.services?.short_name || appDetail.services?.parent_service} />
              <Row label="Dealer" value={appDetail.dealers?.name} />
              <Row label="Assigned Staff" value={appDetail.staff?.full_name} />
              <div className="flex justify-between items-center gap-4 border-b border-slate-100 dark:border-slate-800 pb-2">
                <span className="text-slate-400 dark:text-slate-500">Amount</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    className="w-32 text-right rounded-lg border border-slate-300 dark:border-slate-700 px-2 py-1 text-sm text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] focus:border-[var(--accent)]"
                  />
                  <PrimaryButton onClick={saveAmount} disabled={savingAmount || Number(editAmount) === Number(appDetail.amount)}>
                    {savingAmount ? "Saving…" : "Save"}
                  </PrimaryButton>
                </div>
              </div>
              {amountSaveError && <p className="text-rose-600 text-xs -mt-1">{amountSaveError}</p>}
              <Row label="Submitted" value={appDetail.submitted_at ? new Date(appDetail.submitted_at).toLocaleDateString() : null} />
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// A label/value line used by the application-details modal above.
function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-2">
      <span className="text-slate-400 dark:text-slate-500">{label}</span>
      <span className="text-slate-800 dark:text-slate-100 font-medium text-right">{value || "—"}</span>
    </div>
  );
}

// One "head" — either Dealer or Agency: every record in that table, with
// just Name / Code / Active status / Balance, name & balance clickable
// into the ledger below, plus a New/Edit affordance (reusing the same
// forms Masters used to use — those tabs are gone from Masters now).
function SundryHead({ title, subtitle, entityMode, table, balancesTable, balancesKey, Form, selectedId, onOpenLedger, className = "" }) {
  const [rows, setRows] = useState([]);
  const [balances, setBalances] = useState({}); // id -> running_balance
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // row being edited, or null
  const [open, setOpen] = useState(false); // form modal open
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    // Fetch rows and balances together so they land in state in the same
    // pass — otherwise the zero-balance filter below would briefly hide
    // every row on first paint (balances start empty).
    const [{ data }, { data: balanceRows }] = await Promise.all([
      supabase.from(table).select("*").order("name"),
      supabase.from(balancesTable).select("*"),
    ]);
    setRows(data || []);
    setBalances(Object.fromEntries((balanceRows || []).map((b) => [b[balancesKey], b.running_balance])));
    setLoading(false);
  }, [table, balancesTable, balancesKey]);

  useEffect(() => { load(); }, [load]);

  // Zero-balance accounts are settled/uninteresting for everyday browsing,
  // so they're hidden — but a search should still be able to find a
  // specific dealer/agency even if its balance happens to be zero.
  const searchTerm = search.trim().toLowerCase();
  const visibleRows = rows.filter((r) => {
    if (searchTerm) {
      return (r.name || "").toLowerCase().includes(searchTerm) || (r.code || "").toLowerCase().includes(searchTerm);
    }
    return Number(balances[r.id] ?? 0) !== 0;
  });

  const save = async (form) => {
    const payload = entityMode === "dealer"
      ? {
          name: form.name, code: form.code, short_name: form.short_name || null, contact_name: form.contact_name, mobile: form.mobile, email: form.email,
          address: form.address, city: form.city, state: form.state, pincode: form.pincode,
          credit_limit: parseFloat(form.credit_limit) || 0,
          opening_balance: parseFloat(form.opening_balance) || 0,
          ...(form.visible_from_year !== undefined && {
            visible_from_year: form.visible_from_year === "" || form.visible_from_year === null ? null : parseInt(form.visible_from_year, 10),
          }),
        }
      : {
          name: form.name, code: form.code, contact_person: form.contact_person, mobile: form.mobile, status: form.status,
          opening_balance: parseFloat(form.opening_balance) || 0, default_processing_charges: parseFloat(form.default_processing_charges) || 0,
          payment_terms: form.payment_terms,
        };
    const { error } = editing
      ? await supabase.from(table).update(payload).eq("id", editing.id)
      : await supabase.from(table).insert(payload);
    if (error) { alert("Failed: " + error.message); return; }
    setOpen(false); setEditing(null); load();
  };

  // Dealers don't carry an explicit "active" flag — same computed
  // definition Masters uses: on hold once available credit runs out.
  // Agencies do have their own status field, so that's used as-is.
  const activeLabel = (row) => {
    if (entityMode === "agency") return row.status || "Active";
    const bal = balances[row.id];
    if (bal === undefined) return "Active";
    const avail = Number(row.credit_limit || 0) + Number(bal || 0);
    return avail <= 0 ? "On Hold" : "Active";
  };

  const totalBalance = Object.values(balances).reduce((acc, b) => acc + Number(b || 0), 0);

  return (
    <Card
      title={
        <div className="flex items-center justify-between w-full">
          <div>
            <span>{title}</span>
            <span className="block text-xs font-normal text-slate-400 dark:text-slate-500 mt-0.5">{subtitle}</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <span className="block text-[11px] font-normal text-slate-400 dark:text-slate-500">Total Balance</span>
              <span className={`block text-sm font-bold ${totalBalance < 0 ? "text-rose-600" : "text-slate-800 dark:text-slate-100"}`}>
                ₹{totalBalance.toLocaleString("en-IN")}
              </span>
            </div>
            <GhostButton onClick={() => { setEditing(null); setOpen(true); }}>+ New</GhostButton>
          </div>
        </div>
      }
      className={className}
    >
      <div className="mb-3">
        <div className="relative max-w-xs">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${title.toLowerCase()} name or code…`}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-xs">🔍</span>
        </div>
      </div>
      <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
        <table className="m-scroll w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
            <tr>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2">Code</th>
              <th className="text-left font-medium px-3 py-2">Active</th>
              <th className="text-right font-medium px-3 py-2">Balance</th>
              <th className="text-right font-medium px-3 py-2">Edit</th>
              <th className="text-right font-medium px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const bal = balances[r.id];
              const isSelected = selectedId === r.id;
              const navKey = entityMode === "dealer" ? "dealerLedger" : "agencyLedger";
              return (
                <tr key={r.id} className={`border-t border-slate-100 dark:border-slate-800 ${isSelected ? "bg-blue-50 dark:bg-blue-500/10" : ""}`}>
                  <td className="px-3 py-2">
                    <button onClick={() => onOpenLedger(r.id, r.name)} className="text-blue-600 font-semibold hover:underline text-left">
                      {r.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-500">{r.code}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${
                      activeLabel(r) === "Active"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-rose-50 text-rose-600 border-rose-200"
                    }`}>
                      {activeLabel(r)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => window.open(`?nav=${navKey}&entity=${r.id}`, "_blank", "noopener,noreferrer")}
                      title="Open this ledger in a new window"
                      className="text-blue-600 font-semibold hover:underline"
                    >
                      ₹{Number(bal || 0).toLocaleString("en-IN")}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => { setEditing(r); setOpen(true); }} className="text-xs font-semibold text-slate-500 hover:text-blue-600">
                      Edit
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => window.open(`?nav=${navKey}&entity=${r.id}`, "_blank", "noopener,noreferrer")}
                      title="Open this ledger in a new tab"
                      className="text-xs font-semibold text-slate-400 hover:text-blue-600"
                    >
                      ↗
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && visibleRows.length === 0 && (
              <tr><td colSpan={6} className="text-center text-slate-400 dark:text-slate-500 py-8">{searchTerm ? "No match" : "None yet"}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {open && <Form initial={editing} onSave={save} onClose={() => setOpen(false)} />}
    </Card>
  );
}

// Clickable column header for the transaction table — shows an arrow when
// this is the active sort column, flips direction on repeat clicks.
function SortableTh({ label, sortKeyName, sortKey, sortDir, onSort, align = "left" }) {
  const active = sortKey === sortKeyName;
  return (
    <th
      onClick={() => onSort(sortKeyName)}
      className={`font-medium px-3 py-2 cursor-pointer select-none whitespace-nowrap ${align === "right" ? "text-right" : "text-left"} ${active ? "text-slate-800 dark:text-slate-100" : ""}`}
    >
      {label} {active && (sortDir === "asc" ? "↑" : "↓")}
    </th>
  );
}

// Bank tab — tracks money actually flowing through the bank account:
// RTO government fee paid out (rto_fee on SERVICE entries) vs. money
// collected via UPI (Cash never touches the bank, so it's excluded), with
// a running Bank Balance. Backed by the bank_ledger view
// (009_bank_ledger_view.sql), which already does the daily grouping and
// running-total math server-side.
function BankTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase.from("bank_ledger").select("*").order("entry_date", { ascending: false });
      if (error) { setLoadError(error.message); setLoading(false); return; }
      setLoadError(null);
      setRows(data || []);
      setLoading(false);
    })();
  }, []);

  const today = todayIST();
  const todayRow = rows.find((r) => r.entry_date === today);
  const latestBalance = rows[0]?.bank_balance ?? 0; // rows are newest-first

  const filteredRows = rows.filter((r) => {
    if (rangeFrom && r.entry_date < rangeFrom) return false;
    if (rangeTo && r.entry_date > rangeTo) return false;
    return true;
  });
  const periodTotals = filteredRows.reduce(
    (acc, r) => {
      acc.feePaid += Number(r.fee_paid || 0);
      acc.upiReceived += Number(r.upi_received || 0);
      return acc;
    },
    { feePaid: 0, upiReceived: 0 }
  );

  return (
    <div>
      <div className="grid sm:grid-cols-3 gap-4 mb-5">
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Fee Paid Today</p>
          <p className="text-xl font-bold text-rose-600 mt-1">₹{Number(todayRow?.fee_paid || 0).toLocaleString("en-IN")}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Received in Bank Today (UPI)</p>
          <p className="text-xl font-bold text-emerald-600 mt-1">₹{Number(todayRow?.upi_received || 0).toLocaleString("en-IN")}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Bank Balance</p>
          <p className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">₹{Number(latestBalance).toLocaleString("en-IN")}</p>
          {loadError && <p className="text-[11px] text-amber-600 mt-1">Error: {loadError}</p>}
        </Card>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <label className="text-xs text-slate-400 dark:text-slate-500">From</label>
        <input
          type="date"
          value={rangeFrom}
          onChange={(e) => setRangeFrom(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        />
        <label className="text-xs text-slate-400 dark:text-slate-500">To</label>
        <input
          type="date"
          value={rangeTo}
          onChange={(e) => setRangeTo(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        />
        {(rangeFrom || rangeTo) && (
          <button onClick={() => { setRangeFrom(""); setRangeTo(""); }} className="text-sm font-semibold text-slate-500 hover:text-blue-600">
            Clear
          </button>
        )}
        {(rangeFrom || rangeTo) && (
          <span className="text-xs text-slate-400 dark:text-slate-500 ml-2">
            Period total — Fee Paid: <span className="text-rose-600 font-semibold">₹{periodTotals.feePaid.toLocaleString("en-IN")}</span>
            {" · "}UPI Received: <span className="text-emerald-600 font-semibold">₹{periodTotals.upiReceived.toLocaleString("en-IN")}</span>
          </span>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
        <table className="m-scroll w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-right">Fee Paid</th>
              <th className="px-3 py-2 text-right">UPI Received</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-right">Bank Balance</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="text-center text-slate-400 dark:text-slate-500 py-8">Loading…</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td colSpan={5} className="text-center text-slate-400 dark:text-slate-500 py-8">No activity yet</td></tr>
            ) : (
              filteredRows.map((r) => (
                <tr key={r.entry_date} className={`border-t border-slate-100 dark:border-slate-800 ${r.entry_date === today ? "bg-blue-50 dark:bg-blue-500/10" : ""}`}>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">
                    {new Date(r.entry_date).toLocaleDateString("en-IN")}{r.entry_date === today ? " (Today)" : ""}
                  </td>
                  <td className="px-3 py-2 text-right text-rose-600 font-medium whitespace-nowrap">
                    {r.fee_paid > 0 ? `₹${Number(r.fee_paid).toLocaleString("en-IN")}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-emerald-600 font-medium whitespace-nowrap">
                    {r.upi_received > 0 ? `₹${Number(r.upi_received).toLocaleString("en-IN")}` : "—"}
                  </td>
                  <td className={`px-3 py-2 text-right font-medium whitespace-nowrap ${r.net_for_day < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {r.net_for_day >= 0 ? "+" : ""}₹{Number(r.net_for_day).toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    ₹{Number(r.bank_balance).toLocaleString("en-IN")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

