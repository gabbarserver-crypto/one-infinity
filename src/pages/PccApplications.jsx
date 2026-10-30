// src/pages/PccApplications.jsx
//
// "PCC" sidebar page: only the applications whose RTO is PCC — i.e. exactly
// the rows that show the grey "PCC" badge in the RTO column of the main
// Applications table (PCC-required service, RTO unset or the PCC marker,
// and not marked "PCC not required"). Father Name can be edited inline,
// clicking a PCC No checks that one application, and the list exports to Excel.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, StatusBadge, GhostButton } from "../components/UI";
import { fetchAllRows } from "../lib/fetchAll";
import { todayIST } from "../lib/dates";
import { SERVER_API_BASE } from "../lib/serverApi";
import PCCStatusCheckModal, { normalizePccApplicationNumber, stripKinPrefix, persistPccStatus } from "../components/PCCStatusCheckModal";
import * as XLSX from "xlsx";
import { ArrowUp, ArrowDown, ArrowUpDown, RefreshCw, Pencil, Download, Loader2, Upload } from "lucide-react";
import {
  PCC_STATUS_STYLES,
  getProcessingStage,
  stageTextClass,
  pccNeeded,
  rtoIsPccMarker,
  isPccService,
  serviceLabel,
  dealerLabel,
  isoToDDMMYYYY,
} from "./Applications";

const PAGE_SIZE = 50;

// Only applications from 2026 onwards are listed (older ones are hidden).
const MIN_DATE_ISO = "2026-01-01";

// Same endpoint (and same-origin default) as the per-application modal.
const PCC_CHECK_URL = `${import.meta.env.VITE_PCC_STATUS_API_BASE || SERVER_API_BASE}/api/pcc-status/check`;
// A couple of portal lookups at a time — fast enough, still polite to the
// Delhi Police site (the server-side cron sync is fully sequential).
const CHECK_CONCURRENCY = 2;
// Never re-checked: Certificate Issued is final, Police Case is manual-only
// (matches the server sync, which never overwrites Police Case).
const SKIP_STATUSES = new Set(["Certificate Issued", "Police Case"]);

// Two kinds of PCC numbers are stored here:
//  - Drafted: 14 digits (e.g. 20261030619207) — created when the PCC is only
//    drafted; the Delhi Police portal doesn't know it yet.
//  - Actual:  12 digits (e.g. 202605032881) — generated after the PCC fee
//    (350) is paid; only this one can be tracked on the portal.
function isDraftPcc(pccNo) {
  const digits = String(pccNo || "").replace(/^DLSB-PCC\//i, "").trim();
  return /^\d{13,}$/.test(digits);
}

const CERT_BUCKET = "application-documents";

// "DLSBPCC_202610025858_Certificate.pdf" / "202610025858.pdf" -> "202610025858"
function pccNoFromFilename(name) {
  return String(name || "").match(/(?<!\d)\d{12}(?!\d)/)?.[0] || null;
}
function plainPccNo(pccNo) {
  return String(pccNo || "").replace(/^DLSB-PCC\//i, "").trim();
}
function certificateUrl(path) {
  return path ? supabase.storage.from(CERT_BUCKET).getPublicUrl(path).data.publicUrl : "";
}

// Download the stored certificate as "<PCC No>.pdf". Falls back to opening it
// in a new tab if the browser blocks the blob download.
async function downloadCertificate(row) {
  const url = certificateUrl(row.pcc_certificate_path);
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blobUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `${plainPccNo(row.pcc_no) || row.draft_code || "PCC"}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

// Same storage path / columns the app already uses for a certificate
// (pcc-certificates/<applicationId>.pdf), so every existing download link works.
async function saveCertificate(row, file) {
  const path = `pcc-certificates/${row.id}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(CERT_BUCKET)
    .upload(path, file, { upsert: true, contentType: "application/pdf" });
  if (upErr) throw upErr;

  const updates = { pcc_certificate_path: path, pcc_stage: "Certificate Issued", pcc_status: "Certificate Issued" };
  const { error: dbErr } = await supabase.from("applications").update(updates).eq("id", row.id);
  if (dbErr) throw dbErr;

  // Mirror onto the Documents "CERTIFICATE" row, like the Applications page does.
  const { data: docRow } = await supabase
    .from("application_documents")
    .select("id")
    .eq("application_id", row.id)
    .ilike("name", "certificate")
    .maybeSingle();
  if (docRow) {
    await supabase
      .from("application_documents")
      .update({ file_url: certificateUrl(path), status: "Pending", reject_reason: null })
      .eq("id", docRow.id);
  }
  return updates;
}

// Same CVR / CVR A check the Applications page uses (those never need the PCC RTO).
function isCvr(service) {
  const label = String(service?.short_name || service?.parent_service || "").trim().toLowerCase();
  return label === "cvr" || label === "cvr a";
}

// PCC is "due": the service needs a PCC (PCC / LL RIC ...), it isn't marked
// "PCC not required", and no PCC No has been entered yet.
function isPccDue(r) {
  return pccNeeded(r) && !String(r.pcc_no || "").trim() && !isCvr(r.services);
}

// One application: ask the portal, then save the result on the row exactly
// like the "Check PCC status" modal does.
async function checkOnePcc(row) {
  const res = await fetch(PCC_CHECK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      applicationNumber: normalizePccApplicationNumber(row.pcc_no),
      applicantName: row.applicant_name,
      guardianName: stripKinPrefix(row.father_husband_name || ""),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.error || "Not found on the PCC portal");
  }
  return persistPccStatus(row, data.status); // null when the portal sent no timeline yet
}

const PCC_FILTERS = [
  { key: "", label: "All" },
  { key: "__none__", label: "PCC Due" },
  { key: "Under Verification", label: "Under Verification" },
  { key: "Certificate Issued", label: "Certificate Issued" },
  { key: "Rejected", label: "Rejected" },
  { key: "Police Case", label: "Police Case" },
  { key: "__draft__", label: "PCC Drafted" },
];

// Application date if set, otherwise the day it was submitted (in IST).
function rowDateISO(r) {
  if (r.application_date) return String(r.application_date).slice(0, 10);
  if (r.submitted_at) return todayIST(new Date(r.submitted_at));
  return "";
}

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

// Inline-editable Father Name. Empty value shows an "Add" prompt; filled values
// get a small pencil on hover. Enter / blur saves, Esc cancels.
function FatherCell({ row, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const start = () => { setVal(row.father_husband_name || ""); setErr(""); setEditing(true); };
  const commit = async () => {
    if (saving) return;
    const next = stripKinPrefix(val).trim().toUpperCase();
    if (next === (row.father_husband_name || "")) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(row, next || null);
      setEditing(false);
    } catch (e) {
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div>
        <input
          autoFocus
          value={val}
          disabled={saving}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { setVal(row.father_husband_name || ""); setEditing(false); }
          }}
          placeholder="Father name"
          className="w-44 rounded border border-blue-400 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        {err && <div className="text-[10px] text-red-500 mt-0.5">{err}</div>}
      </div>
    );
  }

  if (!row.father_husband_name) {
    return (
      <button
        onClick={start}
        title="Add father name"
        className="text-xs text-slate-400 dark:text-slate-500 hover:text-blue-500 border border-dashed border-slate-300 dark:border-slate-700 rounded px-2 py-0.5"
      >
        + Add father name
      </button>
    );
  }

  return (
    <span className="group inline-flex items-center gap-1.5">
      {row.father_husband_name}
      <button onClick={start} title="Edit father name" className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-blue-500 transition-opacity">
        <Pencil size={12} />
      </button>
    </span>
  );
}

export default function PccApplications({ isAdmin = false, visibleNav = [] } = {}) {
  const [rows, setRows] = useState([]);
  const [rtoList, setRtoList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [pccFilter, setPccFilter] = useState("");
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  // Bulk "check all PCC status" run: { done, total } while running.
  const [checkProgress, setCheckProgress] = useState(null);
  const [checkSummary, setCheckSummary] = useState(null);
  const stopRef = useRef(false);
  // Bulk certificate upload: { done, total } while running, then a summary.
  const fileInputRef = useRef(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploadSummary, setUploadSummary] = useState(null);
  // Clicking a PCC No opens the same "Track Application" modal as the Applications page.
  const [pccCheckRow, setPccCheckRow] = useState(null);
  const [rowNotice, setRowNotice] = useState(null); // { ok, text } (used for drafted numbers)

  // Staff who only have the restricted "Applications (Staff View)" tab never
  // see Amount, so this page hides it for them too.
  const showAmount = isAdmin || visibleNav.some((n) => n.key === "applications");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      const SELECT_COLS =
        "id, draft_code, application_date, submitted_at, amount, status, applicant_name, father_husband_name, application_no, ll_dl_no, pcc_no, pcc_status, pcc_stage, pcc_certificate_path, pcc_not_required, rto_id, dealers(name,code,short_name), services(parent_service,short_name,pcc_required,ll_dl_no_required)";
      const [{ data: rt }, res, withNo] = await Promise.all([
        supabase.from("rtos").select("id, name, code, type").order("name"),
        fetchAllRows(() =>
          supabase
            .from("applications")
            .select(
              "id, draft_code, application_date, submitted_at, amount, status, applicant_name, father_husband_name, application_no, ll_dl_no, pcc_no, pcc_status, pcc_stage, pcc_certificate_path, pcc_not_required, rto_id, dealers(name,code,short_name), services!inner(parent_service,short_name,pcc_required,ll_dl_no_required)"
            )
            .eq("services.pcc_required", true)
            .order("submitted_at", { ascending: false })
            .order("id", { ascending: false })
        ),
        // Every application that has a PCC No, whatever its service / flags;
        // the page then keeps only those whose RTO is PCC (see pccRows).
        fetchAllRows(() =>
          supabase
            .from("applications")
            .select(SELECT_COLS)
            .not("pcc_no", "is", null)
            .neq("pcc_no", "")
            .order("submitted_at", { ascending: false })
            .order("id", { ascending: false })
        ),
      ]);
      if (cancelled) return;
      if (res.error) {
        setError("Couldn't load PCC applications: " + res.error.message);
        setRows([]);
      } else {
        // Merge both result sets, de-duplicated by id.
        const byId = new Map();
        for (const r of res.data || []) byId.set(r.id, r);
        for (const r of withNo?.data || []) if (!byId.has(r.id)) byId.set(r.id, r);
        setRows([...byId.values()]);
      }
      setRtoList(rt || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // RTO = PCC. A blank RTO only counts as PCC for the PCC service itself
  // (that's how its rows are stored); for any other service (LL RIC, ...)
  // the RTO must actually be set to PCC, otherwise it's just "RTO not
  // filled in yet" and not a PCC application.
  const pccRows = useMemo(
    () => rows.filter((r) => {
      if (rowDateISO(r) < MIN_DATE_ISO) return false;
      // PCC due (needed, not marked "not required", no PCC No yet), whatever the RTO.
      if (isPccDue(r)) return true;
      // A PCC No plus RTO explicitly set to PCC (e.g. CVR / CVR A rows whose
      // RTO was changed to PCC) belongs here. A PCC No alone does not.
      if (String(r.pcc_no || "").trim() && r.rto_id) {
        const rtoName = (rtoList.find((x) => x.id === r.rto_id)?.name || "").trim().toLowerCase();
        if (rtoName.includes("pcc")) return true;
      }
      return (
        pccNeeded(r) &&
        rtoIsPccMarker(r, rtoList) &&
        (isPccService(r.services) || !!r.rto_id)
      );
    }),
    [rows, rtoList]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pccRows.filter((r) => {
      if (pccFilter === "__none__") {
        if (r.pcc_no) return false;
      } else if (pccFilter === "__draft__") {
        if (!isDraftPcc(r.pcc_no)) return false;
      } else if (pccFilter && (!r.pcc_no || r.pcc_status !== pccFilter)) {
        return false;
      }
      if (!q) return true;
      return [
        r.draft_code, r.applicant_name, r.father_husband_name, r.application_no,
        r.ll_dl_no, r.pcc_no, dealerLabel(r.dealers), serviceLabel(r.services),
      ].some((v) => String(v || "").toLowerCase().includes(q));
    });
  }, [pccRows, search, pccFilter]);

  const accessors = {
    draft: (r) => r.draft_code || "",
    date: (r) => rowDateISO(r),
    amount: (r) => Number(r.amount || 0),
    dealer: (r) => dealerLabel(r.dealers).toLowerCase(),
    service: (r) => serviceLabel(r.services).toLowerCase(),
    applicant: (r) => (r.applicant_name || "").toLowerCase(),
    father: (r) => (r.father_husband_name || "").toLowerCase(),
    application: (r) => r.application_no || "",
    lldl: (r) => r.ll_dl_no || "",
    pccno: (r) => r.pcc_no || "",
    status: (r) => getProcessingStage(r) || r.status || "",
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
  }, [filtered, sortKey, sortDir]);

  useEffect(() => { setPage(1); }, [search, pccFilter, sortKey, sortDir]);

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

  const countFor = (key) => {
    if (key === "") return pccRows.length;
    if (key === "__none__") return pccRows.filter((r) => !r.pcc_no).length;
    if (key === "__draft__") return pccRows.filter((r) => isDraftPcc(r.pcc_no)).length;
    return pccRows.filter((r) => r.pcc_no && r.pcc_status === key).length;
  };

  // Rows the bulk check will actually look up.
  const checkable = useMemo(
    () => pccRows.filter((r) => r.pcc_no && !isDraftPcc(r.pcc_no) && !SKIP_STATUSES.has(r.pcc_status)),
    [pccRows]
  );
  const running = checkProgress !== null;

  const runBulkCheck = async () => {
    if (running || checkable.length === 0) return;
    const skipped = pccRows.filter((r) => r.pcc_no && !isDraftPcc(r.pcc_no)).length - checkable.length;
    const ok = window.confirm(
      `Check PCC status for ${checkable.length} application${checkable.length === 1 ? "" : "s"} on the Delhi Police portal?` +
      (skipped > 0 ? `\n\n(${skipped} already Certificate Issued / Police Case will be skipped.)` : "") +
      "\n\nThis can take a few minutes — keep this page open."
    );
    if (!ok) return;

    stopRef.current = false;
    setCheckSummary(null);
    setCheckProgress({ done: 0, total: checkable.length });
    const queue = [...checkable];
    let done = 0;
    let changed = 0;
    let unchanged = 0;
    const failures = [];

    const worker = async () => {
      while (!stopRef.current) {
        const row = queue.shift();
        if (!row) return;
        try {
          const updates = await checkOnePcc(row);
          if (!updates) {
            unchanged += 1; // portal had no progress timeline yet
          } else {
            if (updates.pcc_status && updates.pcc_status !== row.pcc_status) changed += 1;
            else unchanged += 1;
            setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...updates } : r)));
          }
        } catch (e) {
          failures.push({ draft: row.draft_code, name: row.applicant_name, pcc: row.pcc_no, message: e?.message || "Failed" });
        }
        done += 1;
        setCheckProgress({ done, total: checkable.length });
      }
    };

    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
    setCheckProgress(null);
    setCheckSummary({
      total: checkable.length,
      checked: done,
      changed,
      unchanged,
      failures,
      stopped: stopRef.current && done < checkable.length,
    });
  };

  const saveFatherName = async (row, name) => {
    const { error: err } = await supabase
      .from("applications")
      .update({ father_husband_name: name })
      .eq("id", row.id);
    if (err) throw err;
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, father_husband_name: name } : r)));
  };

  const checkRowPcc = (row) => {
    if (running || !row.pcc_no) return;
    if (isDraftPcc(row.pcc_no)) {
      setRowNotice({ ok: false, text: `${row.draft_code} (${row.pcc_no}): this is a drafted PCC number — the portal can't track it. Once the PCC fee is paid and the actual PCC number is generated, update the PCC No and check again.` });
      return;
    }
    setRowNotice(null);
    setPccCheckRow(row);
  };

  // Same as the Applications page: after a certificate is saved from the
  // modal, mirror it onto the Documents "CERTIFICATE" row.
  const onCertificateSaved = async (id) => {
    const path = `pcc-certificates/${id}.pdf`;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, pcc_certificate_path: path, pcc_stage: "Certificate Issued", pcc_status: "Certificate Issued" } : r)));
    const { data: docRow } = await supabase
      .from("application_documents")
      .select("id")
      .eq("application_id", id)
      .ilike("name", "certificate")
      .maybeSingle();
    if (docRow) {
      await supabase
        .from("application_documents")
        .update({ file_url: certificateUrl(path), status: "Pending", reject_reason: null })
        .eq("id", docRow.id);
    }
  };

  const uploadCertificates = async (fileList) => {
    const files = Array.from(fileList || []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (files.length === 0 || uploadProgress) return;

    // PCC No (12 digits) -> application row
    const byNo = new Map();
    for (const r of rows) {
      const no = plainPccNo(r.pcc_no);
      if (no && !byNo.has(no)) byNo.set(no, r);
    }

    const jobs = [];
    const seen = new Set();
    const noMatch = [];
    let alreadyHave = 0;
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name)) { noMatch.push(`${f.name} (not a PDF)`); continue; }
      const no = pccNoFromFilename(f.name);
      const row = no ? byNo.get(no) : null;
      if (!row) { noMatch.push(f.name); continue; }
      if (seen.has(row.id)) continue; // same certificate twice
      seen.add(row.id);
      if (row.pcc_certificate_path) { alreadyHave += 1; continue; }
      jobs.push({ file: f, row });
    }

    setUploadSummary(null);
    setUploadProgress({ done: 0, total: jobs.length });
    let done = 0;
    let uploaded = 0;
    const failed = [];
    const queue = [...jobs];
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        try {
          const updates = await saveCertificate(job.row, job.file);
          uploaded += 1;
          setRows((rs) => rs.map((r) => (r.id === job.row.id ? { ...r, ...updates } : r)));
        } catch (e) {
          failed.push(`${job.file.name}: ${e?.message || "upload failed"}`);
        }
        done += 1;
        setUploadProgress({ done, total: jobs.length });
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    setUploadProgress(null);
    setUploadSummary({ total: files.length, uploaded, alreadyHave, noMatch, failed });
  };

  const exportExcel = () => {
    const headers = [
      "Draft ID", "Date", ...(showAmount ? ["Amount"] : []), "Dealer", "Service",
      "Applicant", "Father Name", "Application", "LL/DL No.", "PCC No", "PCC No Type",
      "PCC Status", "PCC Stage", "Status",
    ];
    const data = sorted.map((r) => [
      r.draft_code || "",
      isoToDDMMYYYY(rowDateISO(r)),
      ...(showAmount ? [r.amount ?? ""] : []),
      dealerLabel(r.dealers),
      serviceLabel(r.services),
      r.applicant_name || "",
      r.father_husband_name || "",
      r.application_no || "",
      r.ll_dl_no || "",
      r.pcc_no || "",
      r.pcc_no ? (isDraftPcc(r.pcc_no) ? "Drafted" : "Actual") : "",
      r.pcc_status || "",
      r.pcc_stage || "",
      getProcessingStage(r) || r.status || "",
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(1, data.length + 1)}` };
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    ws["!cols"] = headers.map((h) => ({ wch: Math.max(12, Math.min(28, h.length + 6)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "PCC");
    XLSX.writeFile(wb, `pcc-applications-${todayIST()}.xlsx`);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">PCC</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">Applications with RTO = PCC (2026 onwards)</span>
        <div className="ml-auto flex items-center gap-2">
          {running && (
            <GhostButton onClick={() => { stopRef.current = true; }} className="!px-3 !py-1.5 !text-xs">Stop</GhostButton>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={(e) => uploadCertificates(e.target.files)}
          />
          <GhostButton
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || !!uploadProgress}
            title="Select many certificate PDFs at once — each is matched to its application by the 12-digit PCC number in the file name"
            className="!px-3 !py-2 !text-sm inline-flex items-center gap-1.5"
          >
            {uploadProgress ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploadProgress ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…` : "Upload certificates"}
          </GhostButton>
          <GhostButton
            onClick={exportExcel}
            disabled={loading || sorted.length === 0}
            title="Export the currently filtered and sorted list as Excel"
            className="!px-3 !py-2 !text-sm inline-flex items-center gap-1.5"
          >
            <Download size={14} /> Export Excel
          </GhostButton>
          <button
            onClick={runBulkCheck}
            disabled={running || loading || checkable.length === 0}
            title="Look up every application's PCC status on the Delhi Police portal and update it here"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 transition-colors"
          >
            <RefreshCw size={14} className={running ? "animate-spin" : ""} />
            {running ? `Checking ${checkProgress.done}/${checkProgress.total}…` : `Check all PCC status (${checkable.length})`}
          </button>
        </div>
      </div>

      {running && (
        <div className="mb-3 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-blue-600 transition-all"
            style={{ width: `${Math.round((checkProgress.done / Math.max(1, checkProgress.total)) * 100)}%` }}
          />
        </div>
      )}

      {uploadSummary && (
        <div className="mb-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm text-slate-700 dark:text-slate-200">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="font-semibold">Certificates:</span> {uploadSummary.total} file{uploadSummary.total === 1 ? "" : "s"} selected —{" "}
              <span className="text-green-600 dark:text-green-400 font-semibold">{uploadSummary.uploaded} uploaded</span>,{" "}
              {uploadSummary.alreadyHave} already had a certificate (skipped)
              {uploadSummary.noMatch.length > 0 && <>, <span className="text-amber-600 dark:text-amber-400 font-semibold">{uploadSummary.noMatch.length} no matching application</span></>}
              {uploadSummary.failed.length > 0 && <>, <span className="text-red-600 dark:text-red-400 font-semibold">{uploadSummary.failed.length} failed</span></>}
              .
            </div>
            <button onClick={() => setUploadSummary(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg leading-none" aria-label="Dismiss">×</button>
          </div>
          {(uploadSummary.noMatch.length > 0 || uploadSummary.failed.length > 0) && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-slate-500 dark:text-slate-400">Show details</summary>
              <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                {uploadSummary.noMatch.map((n, i) => <li key={"n" + i} className="text-amber-600 dark:text-amber-400">No match: {n}</li>)}
                {uploadSummary.failed.map((n, i) => <li key={"f" + i} className="text-red-500">{n}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {rowNotice && (
        <div className={`mb-3 flex items-start justify-between gap-3 rounded-lg border px-4 py-2 text-sm ${
          rowNotice.ok
            ? "border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300"
            : "border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300"
        }`}>
          <span>{rowNotice.text}</span>
          <button onClick={() => setRowNotice(null)} className="text-lg leading-none opacity-60 hover:opacity-100" aria-label="Dismiss">×</button>
        </div>
      )}

      {checkSummary && (
        <div className="mb-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm text-slate-700 dark:text-slate-200">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="font-semibold">{checkSummary.stopped ? "Stopped" : "Done"}:</span>{" "}
              {checkSummary.checked} of {checkSummary.total} checked —{" "}
              <span className="text-green-600 dark:text-green-400 font-semibold">{checkSummary.changed} status changed</span>,{" "}
              {checkSummary.unchanged} unchanged
              {checkSummary.failures.length > 0 && (
                <>, <span className="text-red-600 dark:text-red-400 font-semibold">{checkSummary.failures.length} not found / failed</span></>
              )}
              .
            </div>
            <button onClick={() => setCheckSummary(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg leading-none" aria-label="Dismiss">×</button>
          </div>
          {checkSummary.failures.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-slate-500 dark:text-slate-400">Show not found / failed</summary>
              <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                {checkSummary.failures.map((f, i) => (
                  <li key={i} className="text-slate-600 dark:text-slate-300">
                    <span className="font-semibold">{f.draft}</span> · {f.name} · {f.pcc} — <span className="text-red-500">{f.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {PCC_FILTERS.map((f) => (
          <button
            key={f.key || "all"}
            onClick={() => setPccFilter(f.key)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
              pccFilter === f.key
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:border-slate-400"
            }`}
          >
            {f.label} <span className="opacity-70">{countFor(f.key)}</span>
          </button>
        ))}
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search draft ID, name, father name, PCC No, application…"
          className="w-full max-w-md rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
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
                {th("father", "Father Name")}
                {th("application", "Application")}
                {th("lldl", "LL/DL No.")}
                {th("pccno", "PCC No")}
                {th("status", "Status")}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">Loading…</td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">No PCC applications found.</td></tr>
              ) : (
                pageRows.map((r) => {
                  const stage = getProcessingStage(r);
                  return (
                    <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-blue-600 dark:text-blue-400">{r.draft_code}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{isoToDDMMYYYY(rowDateISO(r))}</td>
                      {showAmount && <td className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-200">{r.amount ?? ""}</td>}
                      <td className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-200">{dealerLabel(r.dealers)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-200">{serviceLabel(r.services)}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-slate-800 dark:text-slate-100">{r.applicant_name}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300"><FatherCell row={r} onSave={saveFatherName} /></td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{r.application_no || ""}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{r.ll_dl_no || ""}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.pcc_no ? (
                          <>
                          <button
                            onClick={() => (r.pcc_certificate_path ? downloadCertificate(r) : checkRowPcc(r))}
                            disabled={running && !r.pcc_certificate_path}
                            title={
                              r.pcc_certificate_path
                                ? "PCC certificate uploaded — click to download"
                                : isDraftPcc(r.pcc_no)
                                  ? "Drafted PCC number — not trackable until the actual PCC number is generated"
                                  : "Click to track this application on the Delhi Police portal"
                            }
                            className={`inline-flex items-center gap-1 text-xs font-semibold hover:underline ${
                              r.pcc_certificate_path
                                ? "text-blue-600 dark:text-blue-400"
                                : PCC_STATUS_STYLES[r.pcc_status] || "text-blue-600 dark:text-blue-300"
                            }`}
                          >
                            {r.pcc_no}
                          </button>
                          {isDraftPcc(r.pcc_no) && (
                            <span className="ml-1.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px] font-semibold px-1.5 py-0.5">Drafted</span>
                          )}
                          </>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={r.status} />
                          {stage && <span className={`text-[11px] font-medium whitespace-nowrap ${stageTextClass(r)}`}>{stage}</span>}
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

      {pccCheckRow && (
        <PCCStatusCheckModal
          row={pccCheckRow}
          onClose={() => setPccCheckRow(null)}
          onStatusSynced={(id, updates) =>
            setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...updates } : r)))
          }
          onCertificateSaved={onCertificateSaved}
        />
      )}
    </div>
  );
}
