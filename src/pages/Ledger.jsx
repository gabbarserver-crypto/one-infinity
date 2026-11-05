// src/pages/Ledger.jsx
import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, GhostButton, PrimaryButton, Modal } from "../components/UI";
import { DealerForm, AgencyForm } from "./Masters";
import { todayIST, fmtDate, istDayStart, istNextDayStart } from "../lib/dates";
import { fetchAllRows } from "../lib/fetchAll";

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
function exportLedgerCSV(entityName, rows, serialMode = false) {
  const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Date", serialMode ? "Sr. No." : "Draft No", "Entry Code", "Type", "Name", "Debit", "Credit", "Running Balance"];
  const lines = [header.join(",")];
  rows.forEach((r) => {
    lines.push([
      escapeCsv(fmtDate(r.entry_date)),
      escapeCsv(serialMode ? (r.serial ?? "") : (r.draft_code || "")),
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
  // Screenshot mode: hide the Draft No + Entry Code columns (remembered on this device).
  const [hideCodes, setHideCodes] = useState(() => {
    try { return localStorage.getItem("ledger_hide_codes") === "1"; } catch { return false; }
  });
  const toggleHideCodes = () => setHideCodes((v) => {
    const next = !v;
    try { localStorage.setItem("ledger_hide_codes", next ? "1" : "0"); } catch { /* ignore */ }
    return next;
  });
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
  // Admin-only: set/clear the Draft No on a PAYMENT row (links it to that
  // application via the set_ledger_entry_draft_code RPC), or rename the Draft
  // No of the APPLICATION behind a SERVICE row (set_application_draft_code).
  const [draftEditId, setDraftEditId] = useState(null);
  const [draftEditValue, setDraftEditValue] = useState("");
  const [draftSaving, setDraftSaving] = useState(false);
  const saveDraftCode = useCallback(async (row) => {
    const isApplicationRow = row.entry_type === "SERVICE";
    if (isApplicationRow && !row.source_application_id) { alert("This row isn't linked to an application."); return; }
    setDraftSaving(true);
    const { data, error } = isApplicationRow
      ? await supabase.rpc("set_application_draft_code", {
          p_application_id: row.source_application_id,
          p_draft_code: draftEditValue,
        })
      : await supabase.rpc("set_ledger_entry_draft_code", {
          p_entry_id: row.id,
          p_draft_code: draftEditValue,
        });
    setDraftSaving(false);
    if (error) { alert(error.message); return; }
    setRowsState((prev) => prev.map((r) => {
      if (isApplicationRow) {
        // every row of that application (service + agency fee) shows the new no
        return r.source_application_id === row.source_application_id ? { ...r, draft_code: data || null } : r;
      }
      return r.id === row.id ? { ...r, draft_code: data || null } : r;
    }));
    setDraftEditId(null);
    setDraftEditValue("");
  }, [draftEditValue]);

  // Admin-only: edit a row's Sr. No. in the agency ledger (blank = back to the
  // automatic number).
  const [serialEditId, setSerialEditId] = useState(null);
  const [serialEditValue, setSerialEditValue] = useState("");
  const [serialSaving, setSerialSaving] = useState(false);
  const saveSerial = useCallback(async (row) => {
    const raw = String(serialEditValue).trim();
    if (raw !== "" && !/^\d+$/.test(raw)) { alert("Sr. No. must be a whole number (or leave blank for automatic)."); return; }
    setSerialSaving(true);
    const { data, error } = await supabase.rpc("set_ledger_entry_serial", {
      p_entry_id: row.id,
      p_serial: raw === "" ? null : Number(raw),
    });
    setSerialSaving(false);
    if (error) { alert(error.message); return; }
    setRowsState((prev) => prev.map((r) => (r.id === row.id ? { ...r, serial_no: data ?? null } : r)));
    setSerialEditId(null);
    setSerialEditValue("");
  }, [serialEditValue]);

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

  // Agency ledger only: a running "Sr. No." (1 = oldest entry) generated right
  // here from the full list of this agency's entries. Admin can overwrite any
  // row's number (stored in ledger_entries.serial_no, migration 023); rows
  // without one keep the auto number. Never appears on Applications. It replaces the
  // Draft No column in the agency ledger, because sorting by Draft No is hard.
  // Oldest first by date; same-day entries keep a stable order by entry code.
  const serialById = useMemo(() => {
    const map = {};
    [...rows]
      .sort((a, b) => {
        const d = String(a.entry_date).slice(0, 10).localeCompare(String(b.entry_date).slice(0, 10));
        if (d !== 0) return d;
        const c = String(a.entry_code || "").localeCompare(String(b.entry_code || ""), undefined, { numeric: true });
        return c !== 0 ? c : String(a.id).localeCompare(String(b.id));
      })
      .forEach((r, i) => { map[r.id] = r.serial_no != null ? Number(r.serial_no) : i + 1; });
    return map;
  }, [rows]);

  // Sorted by a column that only exists in the other ledger kind? Fall back.
  useEffect(() => {
    if (entityMode === "agency" && sortKey === "draft_code") setSortKey("entry_date");
    if (entityMode !== "agency" && sortKey === "serial") setSortKey("entry_date");
  }, [entityMode, sortKey]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === "serial") { av = serialById[a.id]; bv = serialById[b.id]; }
      if (sortKey === "entry_date") { av = new Date(av); bv = new Date(bv); }
      if (sortKey === "debit" || sortKey === "credit" || sortKey === "running_balance") { av = Number(av || 0); bv = Number(bv || 0); }
      if (sortKey === "draft_code") {
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sortKey, sortDir, serialById]);

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
  const attachDraftCodes = async (rowsIn, ownerCol, ownerId) => {
    if (!rowsIn.length) return rowsIn;
    const rowIds = rowsIn.map((r) => r.id);
    const [{ data: resolved, error }, { data: payNos }] = await Promise.all([
      supabase.rpc("get_draft_codes_for_ledger_rows", { p_ledger_ids: rowIds }),
      // Payments keep their own draft no on the ledger row (staff can SELECT
      // ledger_entries directly), so fetch those for this dealer/agency.
      supabase.from("ledger_entries").select("id, payment_draft_no").eq(ownerCol, ownerId).eq("entry_type", "PAYMENT").not("payment_draft_no", "is", null).limit(5000),
    ]);
    if (error) console.error("get_draft_codes_for_ledger_rows failed", error);
    const byRowId = Object.fromEntries((resolved || []).map((r) => [r.ledger_id, r]));
    const payNoById = Object.fromEntries((payNos || []).map((r) => [r.id, r.payment_draft_no]));
    return rowsIn.map((r) => ({
      ...r,
      source_application_id: r.source_application_id || byRowId[r.id]?.source_application_id || null,
      draft_code: payNoById[r.id] || byRowId[r.id]?.draft_code || null,
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
        setRowsState(await attachDraftCodes(r || [], "dealer_id", entityId));
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
        const withDrafts = await attachDraftCodes(r || [], "agency_id", entityId);
        // Admin-edited Sr. Nos. live on ledger_entries (the view doesn't expose
        // them). Separate query so an un-migrated DB just shows auto numbers.
        const { data: serials, error: serialErr } = await supabase
          .from("ledger_entries").select("id, serial_no").eq("agency_id", entityId).not("serial_no", "is", null).limit(10000);
        const serialMap = serialErr ? {} : Object.fromEntries((serials || []).map((x) => [x.id, x.serial_no]));
        setRowsState(withDrafts.map((x) => ({ ...x, serial_no: serialMap[x.id] ?? null })));
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

  // When the table is sorted by Draft No, the server's running_balance (built
  // in date order) no longer matches what's on screen. Rebuild it by walking
  // the rows in Draft No order (blank draft nos last, ties by date), starting
  // from the same opening balance the server used. Derived from a row whose
  // date is unique, since such a row's server balance doesn't depend on how
  // same-day rows were ordered. Balance = opening + debit - credit, which is
  // how the server view builds it.
  const draftBalanceById = useMemo(() => {
    if (sortKey !== "draft_code" || !rows.length) return null;
    const dayOf = (r) => String(r.entry_date).slice(0, 10);
    const perDay = {};
    rows.forEach((r) => { perDay[dayOf(r)] = (perDay[dayOf(r)] || 0) + 1; });
    const unique = rows.filter((r) => perDay[dayOf(r)] === 1).sort((a, b) => (dayOf(a) < dayOf(b) ? 1 : -1))[0];
    if (!unique) return null; // can't derive the opening safely — keep the server's order
    const prefix = rows.reduce((acc, r) => (dayOf(r) <= dayOf(unique) ? acc + Number(r.debit || 0) - Number(r.credit || 0) : acc), 0);
    let bal = Number(unique.running_balance || 0) - prefix;
    const asc = [...rows].sort((a, b) => {
      if (!a.draft_code && !b.draft_code) { /* fall through to date */ }
      else if (!a.draft_code) return 1;
      else if (!b.draft_code) return -1;
      else {
        const c = String(a.draft_code).localeCompare(String(b.draft_code), undefined, { numeric: true, sensitivity: "base" });
        if (c !== 0) return c;
      }
      const d = dayOf(a).localeCompare(dayOf(b));
      return d !== 0 ? d : String(a.entry_code).localeCompare(String(b.entry_code));
    });
    const map = {};
    asc.forEach((r) => { bal += Number(r.debit || 0) - Number(r.credit || 0); map[r.id] = Math.round(bal * 100) / 100; });
    return map;
  }, [rows, sortKey]);

  // Rows within the selected date range (inclusive).
  const periodRows = useMemo(() => {
    const withBal = draftBalanceById
      ? sortedRows.map((r) => ({ ...r, running_balance: draftBalanceById[r.id] ?? r.running_balance }))
      : sortedRows;
    if (!periodFrom && !periodTo) return withBal;
    // entry_date and the period inputs are plain calendar dates, so compare
    // them as "YYYY-MM-DD" strings. Building Date objects from them mixed UTC
    // midnight (entry_date) with local midnight (the range), which is only
    // right by accident in IST.
    return withBal.filter((r) => {
      const day = String(r.entry_date).slice(0, 10);
      if (periodFrom && day < periodFrom) return false;
      if (periodTo && day > periodTo) return false;
      return true;
    });
  }, [sortedRows, draftBalanceById, periodFrom, periodTo]);

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
          <button
            onClick={() => setEntityMode("cash")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${
              entityMode === "cash" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            }`}
          >
            Cash
          </button>
        </div>
      )}

      {(only === "bank" || (!only && entityMode === "bank")) && <BankTab />}
      {!only && entityMode === "cash" && <CashTab />}

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
              <button onClick={() => exportLedgerCSV(entityName, entityMode === "agency" ? periodRows.map((r) => ({ ...r, serial: serialById[r.id] })) : periodRows, entityMode === "agency")} className="text-sm font-semibold text-slate-500 hover:text-blue-600">
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
            <button
              type="button"
              onClick={toggleHideCodes}
              title="Hide Draft No, Entry Code & Delete — handy for a clean screenshot to send to a dealer"
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600"
            >
              {hideCodes ? "Show Draft No, Entry Code & Delete" : "Hide Draft No, Entry Code & Delete"}
            </button>
          </div>
          <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-5">
            <Card>
              <p className="text-xs text-slate-400 dark:text-slate-500">Balance</p>
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

          {draftBalanceById && (
            <p className="no-print text-xs text-slate-400 dark:text-slate-500 mb-2">Balance Draft No order ke hisaab se dikh raha hai.</p>
          )}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
            <table className="m-scroll w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
                <tr>
                  {entityMode === "agency" ? (
                    <SortableTh label="Sr. No." sortKeyName="serial" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  ) : (
                    !hideCodes && <SortableTh label="Draft No" sortKeyName="draft_code" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  )}
                  <SortableTh label="Date" sortKeyName="entry_date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  {!hideCodes && <SortableTh label="Entry Code" sortKeyName="entry_code" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />}
                  <th className="px-3 py-2 text-left">Type</th>
                  <SortableTh label="Name" sortKeyName="display_name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Debit" sortKeyName="debit" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  <SortableTh label="Credit" sortKeyName="credit" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  <SortableTh label="Balance" sortKeyName="running_balance" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  {isAdmin && !hideCodes && <th className="px-3 py-2 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {periodRows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                    {entityMode === "agency" ? (
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">
                        {isAdmin ? (
                          serialEditId === r.id ? (
                            <span className="inline-flex items-center gap-1">
                              <input
                                autoFocus
                                inputMode="numeric"
                                value={serialEditValue}
                                onChange={(e) => setSerialEditValue(e.target.value.replace(/[^0-9]/g, ""))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveSerial(r);
                                  if (e.key === "Escape") { setSerialEditId(null); setSerialEditValue(""); }
                                }}
                                placeholder="auto"
                                className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                              />
                              <button type="button" onClick={() => saveSerial(r)} disabled={serialSaving} className="text-xs font-semibold text-emerald-600 disabled:opacity-50">
                                {serialSaving ? "…" : "Save"}
                              </button>
                              <button type="button" onClick={() => { setSerialEditId(null); setSerialEditValue(""); }} className="text-xs text-slate-400">✕</button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setSerialEditId(r.id); setSerialEditValue(r.serial_no != null ? String(r.serial_no) : String(serialById[r.id] ?? "")); }}
                              className="hover:underline decoration-dotted hover:text-blue-600"
                              title="Edit Sr. No. (blank = automatic)"
                            >
                              {serialById[r.id]}
                            </button>
                          )
                        ) : (
                          serialById[r.id]
                        )}
                      </td>
                    ) : !hideCodes && (
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">
                        {isAdmin && (r.entry_type === "PAYMENT" || (r.entry_type === "SERVICE" && r.source_application_id)) ? (
                          draftEditId === r.id ? (
                            <span className="inline-flex items-center gap-1">
                              <input
                                autoFocus
                                value={draftEditValue}
                                onChange={(e) => setDraftEditValue(e.target.value.toUpperCase())}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveDraftCode(r);
                                  if (e.key === "Escape") { setDraftEditId(null); setDraftEditValue(""); }
                                }}
                                placeholder={r.entry_type === "SERVICE" ? "GVD0993" : "ANK020"}
                                className="w-24 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                              />
                              <button type="button" onClick={() => saveDraftCode(r)} disabled={draftSaving} className="text-xs font-semibold text-emerald-600 disabled:opacity-50">
                                {draftSaving ? "…" : "Save"}
                              </button>
                              <button type="button" onClick={() => { setDraftEditId(null); setDraftEditValue(""); }} className="text-xs text-slate-400">✕</button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setDraftEditId(r.id); setDraftEditValue(r.draft_code || ""); }}
                              className="hover:underline decoration-dotted hover:text-blue-600"
                              title="Edit draft no"
                            >
                              {r.draft_code || "— ✎"}
                            </button>
                          )
                        ) : (
                          r.draft_code || "—"
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">{fmtDate(r.entry_date)}</td>
                    {!hideCodes && <td className="px-3 py-2 text-slate-500 dark:text-slate-500 whitespace-nowrap">{r.entry_code}</td>}
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
                    {isAdmin && !hideCodes && (
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
                  <tr><td colSpan={hideCodes ? (entityMode === "agency" ? 7 : 6) : (isAdmin ? 8 : 7)} className="text-center text-slate-400 dark:text-slate-500 py-8">No transactions yet</td></tr>
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
              <Row label="Submitted" value={appDetail.submitted_at ? fmtDate(appDetail.submitted_at) : null} />
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
// RTO fee + PCC fee paid out vs. money collected via UPI (Cash never touches
// the bank), with a running Bank Balance.
//
// UPI received and the opening balance still come from the bank_ledger view
// (009_bank_ledger_view.sql). The FEE side is rebuilt here straight from the
// applications so each fee lands on the day it was actually paid:
//   • RTO Fee — the day the Fee was filled in (fee_entered_at), falling back
//     to application_date, then submitted_at.
//   • PCC Fee — the day the application was submitted on the PCC portal (the
//     "Pending" step of the synced timeline); if there's no sync yet, the day
//     the PCC No was first written (pcc_no_entered_at, migration 022); then
//     application_date, then submitted_at.
// The running balance is the view's balance with its own fee figures swapped
// for these, so whatever else the view accounts for is preserved.
// Clicking a date opens everything that happened on that day.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Portal timeline dates look like "14 Jun 2026, 10:30 AM" -> "2026-06-14".
function portalDateToISO(text) {
  const t = String(text || "").trim();
  let m = t.match(/(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
const tsToDay = (ts) => (ts ? todayIST(new Date(ts)) : null);
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

function rtoFeeDate(r) {
  return tsToDay(r.fee_entered_at) || (r.application_date ? String(r.application_date).slice(0, 10) : null) || tsToDay(r.submitted_at);
}
// Returns { date, source }.
function pccFeeDate(r) {
  const tl = Array.isArray(r.pcc_timeline) ? r.pcc_timeline : [];
  const first = tl.find((t) => t?.stage === "Pending") || tl[0];
  const fromPortal = portalDateToISO(first?.date);
  if (fromPortal) return { date: fromPortal, source: "PCC portal (application submitted)" };
  const typed = tsToDay(r.pcc_no_entered_at);
  if (typed) return { date: typed, source: "day PCC No was written" };
  const d = (r.application_date ? String(r.application_date).slice(0, 10) : null) || tsToDay(r.submitted_at);
  return { date: d, source: "application date (no PCC date recorded)" };
}

const APP_FEE_COLS = "id, draft_code, applicant_name, rto_fee, pcc_fee, pcc_no, fee_entered_at, application_date, submitted_at, pcc_timeline, dealers(name)";

async function loadFeeApplications() {
  const build = (cols) => () =>
    supabase.from("applications").select(cols).or("rto_fee.gt.0,pcc_fee.gt.0").order("id");
  // pcc_no_entered_at only exists after migration 022 — fall back without it.
  let res = await fetchAllRows(build(APP_FEE_COLS + ", pcc_no_entered_at"));
  if (res.error) res = await fetchAllRows(build(APP_FEE_COLS));
  if (res.error) throw res.error;
  return res.data || [];
}

function BankTab() {
  const [viewRows, setViewRows] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [openDate, setOpenDate] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [{ data, error }, appRows] = await Promise.all([
          supabase.from("bank_ledger").select("*").order("entry_date", { ascending: false }),
          loadFeeApplications(),
        ]);
        if (error) throw error;
        setViewRows(data || []);
        setApps(appRows);
        setLoadError(null);
      } catch (e) {
        setLoadError(e?.message || "Couldn't load bank ledger");
      }
      setLoading(false);
    })();
  }, []);

  const today = todayIST();

  // Day-wise build: fees from applications, UPI + balance baseline from the view.
  const { dayRows, feeItemsByDate } = useMemo(() => {
    const days = new Map();
    const ensure = (d) => {
      if (!days.has(d)) days.set(d, { entry_date: d, rto: 0, pcc: 0, upi: 0, viewFee: 0, viewBalance: null });
      return days.get(d);
    };
    const items = new Map(); // date -> { rto: [], pcc: [] }
    const addItem = (d, kind, item) => {
      if (!items.has(d)) items.set(d, { rto: [], pcc: [] });
      items.get(d)[kind].push(item);
    };
    viewRows.forEach((v) => {
      const d = ensure(v.entry_date);
      d.upi = Number(v.upi_received || 0);
      d.viewFee = Number(v.fee_paid || 0);
      d.viewBalance = Number(v.bank_balance || 0);
    });
    apps.forEach((a) => {
      const base = { id: a.id, draft: a.draft_code, name: a.applicant_name, dealer: a.dealers?.name };
      if (Number(a.rto_fee) > 0) {
        const d = rtoFeeDate(a);
        if (d) { ensure(d).rto += Number(a.rto_fee); addItem(d, "rto", { ...base, amount: Number(a.rto_fee) }); }
      }
      if (Number(a.pcc_fee) > 0) {
        const { date, source } = pccFeeDate(a);
        if (date) { ensure(date).pcc += Number(a.pcc_fee); addItem(date, "pcc", { ...base, amount: Number(a.pcc_fee), pccNo: a.pcc_no, source }); }
      }
    });
    const asc = [...days.values()].sort((x, y) => x.entry_date.localeCompare(y.entry_date));
    let carry = 0, cumViewFee = 0, cumNewFee = 0;
    asc.forEach((d) => {
      if (d.viewBalance !== null) carry = d.viewBalance;
      cumViewFee += d.viewFee;
      cumNewFee += d.rto + d.pcc;
      d.net = d.upi - d.rto - d.pcc;
      d.balance = carry + cumViewFee - cumNewFee;
    });
    return { dayRows: asc.reverse(), feeItemsByDate: items }; // newest first
  }, [viewRows, apps]);

  const todayRow = dayRows.find((r) => r.entry_date === today);
  const latestBalance = dayRows[0]?.balance ?? 0;

  const filteredRows = dayRows.filter((r) => {
    if (rangeFrom && r.entry_date < rangeFrom) return false;
    if (rangeTo && r.entry_date > rangeTo) return false;
    return true;
  });
  const periodTotals = filteredRows.reduce(
    (acc, r) => ({ rto: acc.rto + r.rto, pcc: acc.pcc + r.pcc, upi: acc.upi + r.upi }),
    { rto: 0, pcc: 0, upi: 0 }
  );

  return (
    <div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">RTO Fee Today</p>
          <p className="text-xl font-bold text-rose-600 mt-1">{inr(todayRow?.rto)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">PCC Fee Today</p>
          <p className="text-xl font-bold text-rose-600 mt-1">{inr(todayRow?.pcc)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Received in Bank Today (UPI)</p>
          <p className="text-xl font-bold text-emerald-600 mt-1">{inr(todayRow?.upi)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Bank Balance</p>
          <p className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">{inr(latestBalance)}</p>
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
            Period total — RTO Fee: <span className="text-rose-600 font-semibold">{inr(periodTotals.rto)}</span>
            {" · "}PCC Fee: <span className="text-rose-600 font-semibold">{inr(periodTotals.pcc)}</span>
            {" · "}UPI Received: <span className="text-emerald-600 font-semibold">{inr(periodTotals.upi)}</span>
          </span>
        )}
      </div>

      <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2">Click a date to see everything that happened that day.</p>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
        <table className="m-scroll w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-right">RTO Fee</th>
              <th className="px-3 py-2 text-right">PCC Fee</th>
              <th className="px-3 py-2 text-right">UPI Received</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-right">Bank Balance</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center text-slate-400 dark:text-slate-500 py-8">Loading…</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td colSpan={6} className="text-center text-slate-400 dark:text-slate-500 py-8">No activity yet</td></tr>
            ) : (
              filteredRows.map((r) => (
                <tr key={r.entry_date} className={`border-t border-slate-100 dark:border-slate-800 ${r.entry_date === today ? "bg-blue-50 dark:bg-blue-500/10" : ""}`}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button
                      onClick={() => setOpenDate(r.entry_date)}
                      title="See what happened this day"
                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                    >
                      {fmtDate(r.entry_date)}{r.entry_date === today ? " (Today)" : ""}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right text-rose-600 font-medium whitespace-nowrap">{r.rto > 0 ? inr(r.rto) : "—"}</td>
                  <td className="px-3 py-2 text-right text-rose-600 font-medium whitespace-nowrap">{r.pcc > 0 ? inr(r.pcc) : "—"}</td>
                  <td className="px-3 py-2 text-right text-emerald-600 font-medium whitespace-nowrap">{r.upi > 0 ? inr(r.upi) : "—"}</td>
                  <td className={`px-3 py-2 text-right font-medium whitespace-nowrap ${r.net < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {r.net >= 0 ? "+" : "-"}{inr(Math.abs(r.net))}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">{inr(r.balance)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openDate && (
        <BankDayModal
          date={openDate}
          day={dayRows.find((r) => r.entry_date === openDate)}
          feeItems={feeItemsByDate.get(openDate) || { rto: [], pcc: [] }}
          onClose={() => setOpenDate(null)}
        />
      )}
    </div>
  );
}

// Everything that moved the bank on one day: RTO fees, PCC fees and the UPI
// payments received (loaded on open, since the view only has day totals).
function BankDayModal({ date, day, feeItems, onClose }) {
  const [upi, setUpi] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("id, amount, payment_mode, created_at, dealer_id, dealers(name), applications(draft_code, applicant_name)")
        .eq("payment_mode", "UPI")
        .not("dealer_id", "is", null)
        .gte("created_at", istDayStart(date))
        .lt("created_at", istNextDayStart(date))
        .order("created_at");
      if (cancelled) return;
      if (error) { setErr(error.message); setUpi([]); return; }
      setUpi(data || []);
    })();
    return () => { cancelled = true; };
  }, [date]);

  const time = (ts) => new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const Section = ({ title, total, tone, children, empty }) => (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-sm font-bold text-slate-700 dark:text-slate-200">{title}</h4>
        <span className={`text-sm font-bold ${tone}`}>{inr(total)}</span>
      </div>
      {empty ? <p className="text-xs text-slate-400 dark:text-slate-500">Nothing</p> : <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">{children}</div>}
    </div>
  );
  const Row = ({ left, sub, amount, tone }) => (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="text-slate-700 dark:text-slate-200 truncate">{left}</div>
        {sub && <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{sub}</div>}
      </div>
      <div className={`font-semibold whitespace-nowrap ${tone}`}>{inr(amount)}</div>
    </div>
  );
  const upiTotal = (upi || []).reduce((a, p) => a + Number(p.amount || 0), 0);

  return (
    <Modal title={`${fmtDate(date)} — Bank activity`} onClose={onClose} wide>
      {day && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5 text-center">
          {[
            ["RTO Fee", inr(day.rto), "text-rose-600"],
            ["PCC Fee", inr(day.pcc), "text-rose-600"],
            ["UPI In", inr(day.upi), "text-emerald-600"],
            ["Balance", inr(day.balance), "text-slate-800 dark:text-slate-100"],
          ].map(([l, v, c]) => (
            <div key={l} className="rounded-lg border border-slate-200 dark:border-slate-800 py-2">
              <div className="text-[11px] text-slate-400 dark:text-slate-500">{l}</div>
              <div className={`font-bold ${c}`}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <Section title={`RTO Fee (${feeItems.rto.length})`} total={day?.rto || 0} tone="text-rose-600" empty={!feeItems.rto.length}>
        {feeItems.rto.map((i) => (
          <Row key={`r-${i.id}`} left={`${i.draft || "Application"}${i.name ? ` — ${i.name}` : ""}`} sub={i.dealer} amount={i.amount} tone="text-rose-600" />
        ))}
      </Section>
      <Section title={`PCC Fee (${feeItems.pcc.length})`} total={day?.pcc || 0} tone="text-rose-600" empty={!feeItems.pcc.length}>
        {feeItems.pcc.map((i) => (
          <Row key={`p-${i.id}`} left={`${i.draft || "Application"}${i.name ? ` — ${i.name}` : ""}`} sub={`${i.pccNo ? `PCC ${i.pccNo} · ` : ""}${i.source}`} amount={i.amount} tone="text-rose-600" />
        ))}
      </Section>
      <Section title={`UPI Received${upi ? ` (${upi.length})` : ""}`} total={upi ? upiTotal : day?.upi || 0} tone="text-emerald-600" empty={upi !== null && !upi.length}>
        {upi === null ? <p className="px-3 py-2 text-xs text-slate-400">Loading…</p> : upi.map((p) => (
          <Row
            key={p.id}
            left={`${p.dealers?.name || "Dealer"}${p.applications?.draft_code ? ` — ${p.applications.draft_code}` : ""}`}
            sub={`${time(p.created_at)}${p.applications?.applicant_name ? ` · ${p.applications.applicant_name}` : ""}`}
            amount={p.amount}
            tone="text-emerald-600"
          />
        ))}
      </Section>
      {err && <p className="text-xs text-amber-600">Couldn't load UPI payments: {err}</p>}
    </Modal>
  );
}

// Cash tab — physical cash through the counter, built straight from payments
// (mode = Cash), dated by the day the payment was recorded:
//   • Cash IN  — a dealer paid cash (shows WHICH DEALER).
//   • Cash OUT — cash handed to an agency (shows WHICH AGENCY).
// A dealer paying cash straight to an agency counts in both (net zero), so
// it still shows "from dealer X → agency Y". Cash Balance is the running
// total of in minus out over everything recorded here (no opening balance).
function CashTab() {
  const [pays, setPays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [openDate, setOpenDate] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await fetchAllRows(() =>
        supabase
          .from("payments")
          .select("id, amount, payment_mode, created_at, dealer_id, paid_at_agency_id, reference_no, receipt_no, remarks, dealers(name), applications(draft_code, applicant_name), paid_at_agency:paid_at_agency_id(name)")
          .ilike("payment_mode", "cash")
          .order("created_at")
          .order("id")
      );
      if (error) setLoadError(error.message);
      else { setLoadError(null); setPays(data || []); }
      setLoading(false);
    })();
  }, []);

  const today = todayIST();

  const dayRows = useMemo(() => {
    const days = new Map();
    pays.forEach((p) => {
      const d = tsToDay(p.created_at);
      if (!d) return;
      if (!days.has(d)) days.set(d, { entry_date: d, cashIn: 0, cashOut: 0, from: new Map(), to: new Map(), items: [] });
      const row = days.get(d);
      const amt = Number(p.amount || 0);
      if (p.dealer_id) {
        row.cashIn += amt;
        const n = p.dealers?.name || "Dealer";
        row.from.set(n, (row.from.get(n) || 0) + amt);
      }
      if (p.paid_at_agency_id) {
        row.cashOut += amt;
        const n = p.paid_at_agency?.name || "Agency";
        row.to.set(n, (row.to.get(n) || 0) + amt);
      }
      row.items.push(p);
    });
    const asc = [...days.values()].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
    let bal = 0;
    asc.forEach((r) => { bal += r.cashIn - r.cashOut; r.net = r.cashIn - r.cashOut; r.balance = bal; });
    return asc.reverse();
  }, [pays]);

  const todayRow = dayRows.find((r) => r.entry_date === today);
  const latestBalance = dayRows[0]?.balance ?? 0;
  const filteredRows = dayRows.filter((r) => (!rangeFrom || r.entry_date >= rangeFrom) && (!rangeTo || r.entry_date <= rangeTo));
  const totals = filteredRows.reduce((a, r) => ({ i: a.i + r.cashIn, o: a.o + r.cashOut }), { i: 0, o: 0 });

  const names = (m, tone) =>
    m.size === 0 ? "—" : [...m.entries()].map(([n, a]) => `${n} ${inr(a)}`).join(", ");
  const inputCls = "rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Cash In Today (from dealers)</p>
          <p className="text-xl font-bold text-emerald-600 mt-1">{inr(todayRow?.cashIn)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Cash Out Today (to agencies)</p>
          <p className="text-xl font-bold text-rose-600 mt-1">{inr(todayRow?.cashOut)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Net Today</p>
          <p className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">{inr(todayRow?.net)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-400 dark:text-slate-500">Cash Balance</p>
          <p className="text-xl font-bold text-slate-800 dark:text-slate-100 mt-1">{inr(latestBalance)}</p>
          {loadError && <p className="text-[11px] text-amber-600 mt-1">Error: {loadError}</p>}
        </Card>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <label className="text-xs text-slate-400 dark:text-slate-500">From</label>
        <input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className={inputCls} />
        <label className="text-xs text-slate-400 dark:text-slate-500">To</label>
        <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className={inputCls} />
        {(rangeFrom || rangeTo) && (
          <>
            <button onClick={() => { setRangeFrom(""); setRangeTo(""); }} className="text-sm font-semibold text-slate-500 hover:text-blue-600">Clear</button>
            <span className="text-xs text-slate-400 dark:text-slate-500 ml-2">
              Period total — Cash In: <span className="text-emerald-600 font-semibold">{inr(totals.i)}</span>
              {" · "}Cash Out: <span className="text-rose-600 font-semibold">{inr(totals.o)}</span>
            </span>
          </>
        )}
      </div>

      <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2">Click a date to see every cash entry of that day.</p>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
        <table className="m-scroll w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">From Dealer</th>
              <th className="px-3 py-2 text-right">Cash In</th>
              <th className="px-3 py-2 text-left">To Agency</th>
              <th className="px-3 py-2 text-right">Cash Out</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-right">Cash Balance</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="text-center text-slate-400 dark:text-slate-500 py-8">Loading…</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td colSpan={7} className="text-center text-slate-400 dark:text-slate-500 py-8">No cash activity yet</td></tr>
            ) : (
              filteredRows.map((r) => (
                <tr key={r.entry_date} className={`border-t border-slate-100 dark:border-slate-800 ${r.entry_date === today ? "bg-blue-50 dark:bg-blue-500/10" : ""}`}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button onClick={() => setOpenDate(r.entry_date)} className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                      {fmtDate(r.entry_date)}{r.entry_date === today ? " (Today)" : ""}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-300 max-w-[260px] truncate" title={names(r.from)}>{names(r.from)}</td>
                  <td className="px-3 py-2 text-right text-emerald-600 font-medium whitespace-nowrap">{r.cashIn > 0 ? inr(r.cashIn) : "—"}</td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-300 max-w-[260px] truncate" title={names(r.to)}>{names(r.to)}</td>
                  <td className="px-3 py-2 text-right text-rose-600 font-medium whitespace-nowrap">{r.cashOut > 0 ? inr(r.cashOut) : "—"}</td>
                  <td className={`px-3 py-2 text-right font-medium whitespace-nowrap ${r.net < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {r.net >= 0 ? "+" : "-"}{inr(Math.abs(r.net))}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">{inr(r.balance)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openDate && <CashDayModal date={openDate} day={dayRows.find((r) => r.entry_date === openDate)} onClose={() => setOpenDate(null)} />}
    </div>
  );
}

function CashDayModal({ date, day, onClose }) {
  const time = (ts) => new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const items = day?.items || [];
  return (
    <Modal title={`${fmtDate(date)} — Cash activity`} onClose={onClose} wide>
      {day && (
        <div className="grid grid-cols-3 gap-2 mb-5 text-center">
          {[
            ["Cash In", inr(day.cashIn), "text-emerald-600"],
            ["Cash Out", inr(day.cashOut), "text-rose-600"],
            ["Balance", inr(day.balance), "text-slate-800 dark:text-slate-100"],
          ].map(([l, v, c]) => (
            <div key={l} className="rounded-lg border border-slate-200 dark:border-slate-800 py-2">
              <div className="text-[11px] text-slate-400 dark:text-slate-500">{l}</div>
              <div className={`font-bold ${c}`}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((p) => {
          const dealer = p.dealer_id ? (p.dealers?.name || "Dealer") : null;
          const agency = p.paid_at_agency_id ? (p.paid_at_agency?.name || "Agency") : null;
          const title = dealer && agency ? `${dealer} → ${agency}` : dealer ? `From ${dealer}` : agency ? `To ${agency}` : "Cash";
          const out = !!agency && !dealer; // pure agency payout
          const through = !!agency && !!dealer; // dealer paid straight to agency
          const tone = through ? "text-slate-600 dark:text-slate-300" : out ? "text-rose-600" : "text-emerald-600";
          const sub = [time(p.created_at), p.applications?.draft_code && `${p.applications.draft_code}${p.applications.applicant_name ? ` (${p.applications.applicant_name})` : ""}`, p.receipt_no && `Receipt ${p.receipt_no}`, p.remarks]
            .filter(Boolean).join(" · ");
          return (
            <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="text-slate-700 dark:text-slate-200 truncate">{title}</div>
                <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{sub}{through ? " · paid straight to agency (net zero)" : ""}</div>
              </div>
              <div className={`font-semibold whitespace-nowrap ${tone}`}>{out ? "−" : through ? "" : "+"}{inr(p.amount)}</div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
