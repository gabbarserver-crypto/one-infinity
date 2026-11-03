// src/pages/LicenceApplications.jsx
//
// "Learning" and "DL" sidebar pages. Same look as the PCC page, but each one
// lists only the applications whose SERVICE name contains LL (Learning:
// LL RIC, LL Cart, ...) or DL (DL services). Read-only list with search,
// sort, paging and Excel export.
//
// Amount is hidden for staff who only have the restricted "Applications
// (Staff View)" tab — same rule as the PCC page.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, GhostButton, Toast } from "../components/UI";
import { fetchAllRows } from "../lib/fetchAll";
import { todayIST } from "../lib/dates";
import * as XLSX from "xlsx";
import { ArrowUp, ArrowDown, ArrowUpDown, Download } from "lucide-react";
import {
  serviceLabel,
  dealerLabel,
  isoToDDMMYYYY,
} from "./Applications";

const PAGE_SIZE = 50;

// Whole-word match so "LL RIC" / "LL Cart" count but words like "Bill" or
// "All" never do. Checks both the short name and the parent service name.
const LL_RE = /(^|[^a-z0-9])ll([^a-z0-9]|$)|learning/i;
const DL_RE = /(^|[^a-z0-9])dl([^a-z0-9]|$)/i;

function serviceText(s) {
  return `${s?.short_name || ""} ${s?.parent_service || ""}`;
}

// Application date if set, otherwise the day it was submitted (in IST).
function rowDateISO(r) {
  if (r.application_date) return String(r.application_date).slice(0, 10);
  if (r.submitted_at) return todayIST(new Date(r.submitted_at));
  return "";
}

// Parse the free-text Slot field (usually DD-MM-YYYY) into an ISO date.
function slotISO(v) {
  const t = String(v || "").trim();
  if (!t) return null;
  let m = t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

// LL/DL No. counts as issued only when it holds a real number (has digits) —
// a plain remark like "ALREADY DL" is not an issued licence.
function isIssued(r) {
  return /\d/.test(String(r.ll_dl_no || ""));
}
function feePaid(r) {
  return Number(r.rto_fee) > 0;
}

// Amount counts as filled only when it is above 0 (0 = nothing charged yet).
function amountFilled(r) {
  return Number(r.amount) > 0;
}
// LL/DL No. holds a typed reason (no digits at all) such as "ALREADY DL",
// "BY DL", "cancelled", "NA" — the licence was not issued for that reason.
function hasReasonText(r) {
  const t = String(r.ll_dl_no || "").trim();
  return !!t && !/\d/.test(t);
}
// A typed "HOLD" in LL/DL No. means the same as the On Hold status.
function isHoldText(r) {
  return /^\s*hold\b/i.test(String(r.ll_dl_no || ""));
}

// One bucket per application, checked top to bottom.
//  Learning: Issued -> Hold -> Closed (reason typed + amount filled)
//            -> Under Process (RTO fee unpaid) -> Pending (no number yet)
//  DL:       Issued -> Hold -> Closed (reason typed + amount filled)
//            -> Pending (amount not filled) -> Under Process (RTO fee unpaid)
//            -> Waiting for Slot Booking (amount + RTO fee paid, no slot yet)
//            -> Slot Pending (waits until the slot date)
//            -> Waiting for RTO Approval (slot date is over)
function bucketOf(r, isDl, today) {
  if (isIssued(r)) return "issued";
  if (r.status === "On Hold" || isHoldText(r)) return "hold";
  if (hasReasonText(r) && amountFilled(r)) return "closed";
  if (isDl) {
    if (!amountFilled(r)) return "pending";
    if (!feePaid(r)) return "process";
    if (!String(r.slot_time || "").trim()) return "slotbooking";
    const iso = slotISO(r.slot_time);
    return iso && iso < today ? "approval" : "slotwait";
  }
  return feePaid(r) ? "pending" : "process";
}

const BUCKET_LABEL = {
  issued: "Issued",
  closed: "Closed",
  pending: "Pending",
  process: "Under Process",
  slotbooking: "Waiting for Slot Booking",
  slotwait: "Slot Pending",
  approval: "Waiting for RTO Approval",
  hold: "Hold",
};
const BUCKET_STYLE = {
  closed: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  issued: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  process: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  slotbooking: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  slotwait: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  approval: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  hold: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
};
const FILTERS_LL = ["", "issued", "closed", "pending", "process", "hold"];
const FILTERS_DL = ["", "issued", "closed", "pending", "slotbooking", "process", "slotwait", "approval", "hold"];

function SortTh({ column, label, sortKey, sortDir, onSort }) {
  const active = sortKey === column;
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th className="text-left font-medium px-3 py-2 whitespace-nowrap">
      <button
        onClick={() => onSort(column)}
        className={`flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 ${active ? "text-slate-800 dark:text-slate-100 font-semibold" : ""}`}
      >
        {label}
        <Icon size={12} className={active ? "" : "opacity-40"} />
      </button>
    </th>
  );
}

const SELECT_COLS =
  "id, draft_code, date_of_birth, application_date, submitted_at, amount, rto_fee, status, applicant_name, application_no, ll_dl_no, slot_time, remarks, rto_id, service_id, pcc_no, pcc_status, pcc_stage, pcc_timeline, pcc_not_required, dealers(name,code,short_name), services(parent_service,short_name,pcc_required,ll_dl_no_required)";

// Same stored-file link the Applications page uses: keep the public URL but
// ask the browser to save it as "application.<ext>".
function learningDownloadUrl(fileUrl) {
  if (!fileUrl) return "";
  try {
    const url = new URL(fileUrl);
    const ext = (url.pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "pdf").toLowerCase();
    url.searchParams.set("download", `application.${ext}`);
    return url.toString();
  } catch {
    return fileUrl;
  }
}

function LicenceList({ kind, isAdmin = false, visibleNav = [] }) {
  const isDl = kind === "dl";
  const matcher = isDl ? DL_RE : LL_RE;
  const emptyText = isDl ? "No DL applications found." : "No Learning applications found.";

  const [rows, setRows] = useState([]);
  const [rtoList, setRtoList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState(null);
  const [learningDocs, setLearningDocs] = useState({}); // { [applicationId]: file_url }
  const today = todayIST();

  // Staff with only the restricted Staff View never see Amount.
  const showAmount = isAdmin || visibleNav.some((n) => n.key === "applications");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      setRows([]);
      const [{ data: rt }, { data: svc, error: svcErr }] = await Promise.all([
        supabase.from("rtos").select("id, name").order("name"),
        supabase.from("services").select("id, parent_service, short_name"),
      ]);
      if (cancelled) return;
      if (svcErr) { setError("Couldn't load services: " + svcErr.message); setLoading(false); return; }
      setRtoList(rt || []);

      const ids = (svc || []).filter((s) => matcher.test(serviceText(s))).map((s) => s.id);
      if (ids.length === 0) { setLoading(false); return; }

      const res = await fetchAllRows(() =>
        supabase
          .from("applications")
          .select(SELECT_COLS)
          .in("service_id", ids)
          .order("submitted_at", { ascending: false })
          .order("id", { ascending: false })
      );
      if (cancelled) return;
      if (res.error) setError("Couldn't load applications: " + res.error.message);
      else setRows(res.data || []);
      setLoading(false);

      // Uploaded Learning files for the rows that already have an LL/DL No.,
      // so that number becomes a direct download link (same as Applications).
      try {
        const appIds = (res.data || []).filter((r) => r.ll_dl_no).map((r) => r.id);
        const docs = {};
        for (let i = 0; i < appIds.length; i += 200) {
          const { data } = await supabase
            .from("application_documents")
            .select("application_id, file_url")
            .in("application_id", appIds.slice(i, i + 200))
            .ilike("name", "%learning%")
            .not("file_url", "is", null);
          for (const d of data || []) if (d.file_url && !docs[d.application_id]) docs[d.application_id] = d.file_url;
        }
        if (!cancelled) setLearningDocs(docs);
      } catch {
        if (!cancelled) setLearningDocs({});
      }
    })();
    return () => { cancelled = true; };
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Application No -> Sarathi application status page (DOB copied for pasting).
  const openSarathi = async (row) => {
    if (!row.application_no) { setToast("Enter Application No first"); return; }
    if (row.date_of_birth) {
      const dob = isoToDDMMYYYY(row.date_of_birth);
      try { await navigator.clipboard.writeText(dob); setToast("DOB copied: " + dob); } catch { /* clipboard may be blocked */ }
    }
    window.open(
      `https://sarathi.parivahan.gov.in/sarathiservice/applicationredirect.do?as=${encodeURIComponent(row.application_no)}`,
      "_blank", "noopener,noreferrer"
    );
  };

  // LL/DL No with no stored file -> Sarathi's Learning download page.
  const openLearningDownloadPage = async (row) => {
    if (!row.application_no) { setToast("Enter Application No first"); return; }
    try { await navigator.clipboard.writeText(row.ll_dl_no); setToast("Learning No copied: " + row.ll_dl_no); } catch { /* clipboard may be blocked */ }
    window.open(
      `https://sarathi.parivahan.gov.in/sarathiservice/applicationredirect.do?q=${encodeURIComponent(row.application_no)}`,
      "_blank", "noopener,noreferrer"
    );
  };

  const rtoName = (id) => rtoList.find((x) => x.id === id)?.name || "";

  const bucketOfRow = (r) => bucketOf(r, isDl, today);
  const countFor = (key) => (key === "" ? rows.length : rows.filter((r) => bucketOfRow(r) === key).length);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = filter ? rows.filter((r) => bucketOfRow(r) === filter) : rows;
    if (!q) return base;
    return base.filter((r) =>
      [r.draft_code, r.applicant_name, r.application_no, r.ll_dl_no, dealerLabel(r.dealers), serviceLabel(r.services), rtoName(r.rto_id), r.slot_time]
        .some((v) => String(v || "").toLowerCase().includes(q))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, rtoList, filter, today]);

  const accessors = {
    draft: (r) => r.draft_code || "",
    date: (r) => rowDateISO(r),
    amount: (r) => Number(r.amount || 0),
    dealer: (r) => dealerLabel(r.dealers).toLowerCase(),
    service: (r) => serviceLabel(r.services).toLowerCase(),
    applicant: (r) => (r.applicant_name || "").toLowerCase(),
    application: (r) => r.application_no || "",
    rtofee: (r) => Number(r.rto_fee || 0),
    lldl: (r) => r.ll_dl_no || "",
    rto: (r) => rtoName(r.rto_id).toLowerCase(),
    slot: (r) => r.slot_time || "",
    status: (r) => BUCKET_LABEL[bucketOfRow(r)] || "",
  };

  const sorted = useMemo(() => {
    const get = accessors[sortKey] || accessors.date;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir, rtoList, today]);

  useEffect(() => { setFilter(""); }, [kind]);
  useEffect(() => { setPage(1); }, [search, sortKey, sortDir, kind, filter]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const onSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };
  const th = (column, label) => (
    <SortTh column={column} label={label} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
  );

  const exportExcel = () => {
    const head = [
      "Draft ID", "Date", ...(showAmount ? ["Amount"] : []), "Dealer", "Service", "Applicant",
      "Application", "RTO Fee", "LL/DL No.", ...(isDl ? ["RTO Name", "Slot Date"] : []), "Status",
    ];
    const body = sorted.map((r) => [
      r.draft_code || "",
      isoToDDMMYYYY(rowDateISO(r)),
      ...(showAmount ? [r.amount ?? ""] : []),
      dealerLabel(r.dealers),
      serviceLabel(r.services),
      r.applicant_name || "",
      r.application_no || "",
      r.rto_fee ?? "",
      r.ll_dl_no || "",
      ...(isDl ? [rtoName(r.rto_id), r.slot_time || ""] : []),
      BUCKET_LABEL[bucketOfRow(r)] || "",
    ]);
    const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, isDl ? "DL" : "Learning");
    XLSX.writeFile(wb, `${isDl ? "DL" : "Learning"}-${todayIST()}.xlsx`);
  };

  const colCount = 9 + (showAmount ? 1 : 0) + (isDl ? 2 : 0);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {(isDl ? FILTERS_DL : FILTERS_LL).map((key) => (
          <button
            key={key || "all"}
            onClick={() => setFilter(key)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
              filter === key
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:border-slate-400"
            }`}
          >
            {key ? BUCKET_LABEL[key] : "All"} <span className="opacity-70">{countFor(key)}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search draft ID, name, application, LL/DL No…"
          className="flex-1 min-w-[220px] max-w-md rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <GhostButton onClick={exportExcel} disabled={loading || sorted.length === 0} className="!px-3 !py-2 !text-xs inline-flex items-center gap-1.5">
          <Download size={14} /> Export Excel
        </GhostButton>
      </div>

      <Card className="!p-0 overflow-hidden">
        {error && <p className="text-rose-500 text-sm p-4">{error}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400">
                {th("draft", "Draft ID")}
                {th("date", "Date")}
                {showAmount && th("amount", "Amount")}
                {th("dealer", "Dealer")}
                {th("service", "Service")}
                {th("applicant", "Applicant")}
                {th("application", "Application")}
                {th("rtofee", "RTO Fee")}
                {th("lldl", "LL/DL No.")}
                {isDl && th("rto", "RTO Name")}
                {isDl && th("slot", "Slot Date")}
                {th("status", "Status")}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={colCount} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">Loading…</td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={colCount} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">{emptyText}</td></tr>
              ) : (
                pageRows.map((r) => {
                  const bucket = bucketOfRow(r);
                  return (
                    <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-blue-600 dark:text-blue-400">{r.draft_code}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{isoToDDMMYYYY(rowDateISO(r))}</td>
                      {showAmount && <td className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-200">{r.amount ?? ""}</td>}
                      <td className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-200">{dealerLabel(r.dealers)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-200">{serviceLabel(r.services)}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-slate-800 dark:text-slate-100">{r.applicant_name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.application_no ? (
                          <button
                            type="button"
                            onClick={() => openSarathi(r)}
                            title="Open application status on Sarathi Parivahan (also copies DOB)"
                            className="font-medium text-blue-600 hover:underline text-left"
                          >
                            {r.application_no}
                          </button>
                        ) : ""}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{r.rto_fee ?? ""}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.ll_dl_no && learningDocs[r.id] ? (
                          <a
                            href={learningDownloadUrl(learningDocs[r.id])}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Download uploaded Learning file"
                            className="font-medium text-blue-600 hover:underline"
                          >
                            {r.ll_dl_no}
                          </a>
                        ) : r.ll_dl_no ? (
                          <button
                            type="button"
                            onClick={() => openLearningDownloadPage(r)}
                            title="Download from Sarathi (copies the number)"
                            className="font-medium text-amber-600 hover:underline"
                          >
                            {r.ll_dl_no}
                          </button>
                        ) : ""}
                      </td>
                      {isDl && <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{rtoName(r.rto_id)}</td>}
                      {isDl && <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{r.slot_time || ""}</td>}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${BUCKET_STYLE[bucket]}`}>{BUCKET_LABEL[bucket]}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {sorted.length === 0
              ? "0 applications"
              : `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, sorted.length)} of ${sorted.length}`}
          </span>
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} className="!px-2.5 !py-1 !text-xs">Prev</GhostButton>
            <span>Page {safePage} of {totalPages}</span>
            <GhostButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} className="!px-2.5 !py-1 !text-xs">Next</GhostButton>
          </div>
        </div>
      </Card>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

export function LearningApplications(props) {
  return <LicenceList kind="ll" {...props} />;
}

export function DlApplications(props) {
  return <LicenceList kind="dl" {...props} />;
}
