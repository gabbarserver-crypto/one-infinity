// src/components/PCCStatusCheckModal.jsx
// Extracted out of Applications.jsx so the Dealer Portal's Documents modal
// can offer the same "Download Certificate" flow next to a PCC document
// (mirroring the "Download Learning" / Sarathi button), not just the
// admin-side PCC No column.
import React, { useState, useEffect } from "react";
import { Modal, Field, Input, PrimaryButton } from "./UI";
import { supabase } from "../lib/supabase";

// Same-origin by default — this hits the Vercel serverless function at
// api/pcc-status/check.js, deployed alongside the frontend, so it works
// wherever the app itself is hosted (no separate server needed). Only set
// VITE_PCC_STATUS_API_BASE if you're intentionally pointing at a different,
// separately-hosted proxy (e.g. the old server/index.js during local dev
// against "http://localhost:5000").
const PCC_STATUS_API_BASE = import.meta.env.VITE_PCC_STATUS_API_BASE || "";

/**
 * Confirmed from the real get-pcc-application-status response: the API's
 * timeline entries use a "stage" key (Pending, Assigned, Field Verified,
 * Approved, Verified, Certificate Issued) which we map to the friendlier
 * labels the portal's own UI displays.
 */
const PCC_STAGE_ORDER = ["Pending", "Assigned", "Field Verified", "Approved", "Verified", "Certificate Issued"];
const PCC_STAGE_LABELS = {
  Pending: "Application Submitted",
  Assigned: "Assigned for Field Verification",
  "Field Verified": "Field Verified",
  Approved: "Approved",
  Verified: "Verified",
  "Certificate Issued": "Certificate Issued",
};

function mapToSteps(status) {
  const timeline = status?.timeline || [];
  const byStage = {};
  timeline.forEach((entry) => { byStage[entry.stage] = entry; });

  return PCC_STAGE_ORDER.map((stage) => ({
    label: PCC_STAGE_LABELS[stage] || stage,
    done: Boolean(byStage[stage]),
    timestamp: byStage[stage]?.date || null,
    description: byStage[stage]?.description || null,
  }));
}

// Delhi Police's portal expects the FULL application number including the
// "DLSB-PCC/" prefix (e.g. "DLSB-PCC/202605030627"). Our pcc_no field is often
// stored as just the trailing number, so add the prefix back if it's missing.
export function normalizePccApplicationNumber(pccNo) {
  if (!pccNo) return pccNo;
  const trimmed = pccNo.trim();
  return /^DLSB-PCC\//i.test(trimmed) ? trimmed : `DLSB-PCC/${trimmed}`;
}

// Strip any leading "S/O", "W/O", "D/O", "C/O" (with or without punctuation)
// in case it was typed into the Father/Husband field — the portal expects
// just the plain name, with no relation prefix.
function stripKinPrefix(name) {
  if (!name) return name;
  return name.replace(/^\s*(s\/o|w\/o|d\/o|c\/o)[\s:.]*?/i, "").trim();
}

// Mirrors the Delhi Police portal's own "Track Application" form: application
// number (with the fixed DLSB-PCC/ prefix), applicant name, guardian name —
// prefilled from our record, but editable, with an explicit "Search
// Application" button. Nothing fires until the user clicks it.
// Auto-sync (server cron) fetches status and the certificate PDF by itself.
// The manual path (Download Certificate, then Save Certificate to DB) stays
// as a fallback for when the automatic download fails.
async function saveCertificateFile(applicationId, file) {
  const path = `pcc-certificates/${applicationId}.pdf`;
  const { error: uploadError } = await supabase.storage
    .from("application-documents")
    .upload(path, file, { upsert: true, contentType: "application/pdf" });
  if (uploadError) throw uploadError;

  const { error: updateError } = await supabase
    .from("applications")
    .update({ pcc_certificate_path: path, pcc_stage: "Certificate Issued", pcc_status: "Certificate Issued" })
    .eq("id", applicationId);
  if (updateError) throw updateError;

  return path;
}

// Saves what the portal just told us onto the application row, so the status
// dropdown / stepper update right away instead of waiting for the cron sync.
// Same mapping as api/_lib/pccClient.js (mapStageToDropdownStatus). Rejected /
// Police Case are never overwritten, matching the server sync.
async function persistPccStatus(row, status) {
  const timeline = status?.timeline || [];
  if (!timeline.length) return null;
  const reached = new Set(timeline.map((t) => t.stage));
  let currentStage = null;
  for (const stage of PCC_STAGE_ORDER) if (reached.has(stage)) currentStage = stage;

  const updates = { pcc_timeline: timeline, pcc_last_synced_at: new Date().toISOString() };
  if (currentStage) updates.pcc_stage = currentStage;
  if (row.pcc_status !== "Rejected" && row.pcc_status !== "Police Case") {
    updates.pcc_status = reached.has("Certificate Issued") ? "Certificate Issued" : "Under Verification";
  }
  const { error } = await supabase.from("applications").update(updates).eq("id", row.id);
  if (error) throw error;
  return updates;
}

export default function PCCStatusCheckModal({ row, onClose, onCertificateSaved, onStatusSynced }) {
  const [applicationNumber, setApplicationNumber] = useState(
    normalizePccApplicationNumber(row.pcc_no)?.replace(/^DLSB-PCC\//i, "") || ""
  );
  const [applicantName, setApplicantName] = useState(row.applicant_name || "");
  const [guardianName, setGuardianName] = useState(stripKinPrefix(row.father_husband_name) || "");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [savingCert, setSavingCert] = useState(false);
  const [certSaved, setCertSaved] = useState(Boolean(row.pcc_certificate_path));
  const fileInputRef = React.useRef(null);
  // Data the portal returned for the issued certificate (saved by auto-sync).
  const [certData, setCertData] = useState(null);
  useEffect(() => {
    let alive = true;
    supabase
      .from("applications")
      .select("pcc_certificate_data")
      .eq("id", row.id)
      .maybeSingle()
      .then(({ data }) => { if (alive) setCertData(data?.pcc_certificate_data || null); });
    return () => { alive = false; };
  }, [row.id]);

  const handleCertFileChosen = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    setSavingCert(true);
    setError(null);
    try {
      await saveCertificateFile(row.id, file);
      setCertSaved(true);
      onCertificateSaved?.(row.id);
    } catch (err) {
      setError(err.message || "Failed to save certificate");
    } finally {
      setSavingCert(false);
    }
  };

  const runCheck = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${PCC_STATUS_API_BASE}/api/pcc-status/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationNumber: normalizePccApplicationNumber(applicationNumber),
          applicantName,
          guardianName,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || "Application not found on the PCC portal");
      }
      setResult(data);
      // Best effort: a failed save must not hide the status we just fetched.
      persistPccStatus(row, data.status)
        .then((updates) => { if (updates) onStatusSynced?.(row.id, updates); })
        .catch((e) => console.warn("Could not save PCC status:", e.message));
      return data;
    } catch (err) {
      setError(err.message || "Failed to reach the PCC status server");
      return null;
    } finally {
      setLoading(false);
    }
  };

  // The certificate link's token appears to be short-lived, so instead of
  // reusing whatever certificateUrl came back from the earlier search, we
  // re-run the check right at click time and open the freshest possible link
  // immediately — minimizing the gap between "token issued" and "token used".
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const fresh = await runCheck();
      const url = fresh?.status?.certificateUrl;
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        setError("Couldn't get a fresh certificate link — try Search Application again.");
      }
    } finally {
      setDownloading(false);
    }
  };

  const application = result?.application || null;
  // Before the user clicks "Search Application", show whatever the last
  // auto-sync run stored on the row (pcc_timeline / pcc_last_synced_at)
  // instead of a blank stepper — it's already what the admin table shows.
  const liveStatus = result?.status || null;
  const status = liveStatus || (row.pcc_timeline?.length ? { timeline: row.pcc_timeline } : null);
  const steps = mapToSteps(status);
  const lastStep = steps[steps.length - 1];
  // Show the stored (auto-sync) progress whenever the live search didn't
  // return one -- either before searching, or when the portal's status call
  // came back empty.
  const usingStoredTimeline = !liveStatus && row.pcc_timeline?.length > 0;

  return (
    <Modal title="Track Application" onClose={onClose} wide>
      <div className="max-w-lg">
        <Field label="Application Number">
          <div className="flex">
            <span className="shrink-0 inline-flex items-center px-3 rounded-l-lg bg-blue-900 text-white text-sm font-semibold">
              DLSB-PCC/
            </span>
            <input
              type="text"
              value={applicationNumber}
              onChange={(e) => setApplicationNumber(e.target.value)}
              className="flex-1 rounded-r-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Applicant Name">
            <Input value={applicantName} onChange={(e) => setApplicantName(e.target.value)} />
          </Field>
          <Field label="Guardian Name">
            <Input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} />
          </Field>
        </div>

        <PrimaryButton disabled={loading} onClick={runCheck} className="w-full mt-2">
          {loading ? "Searching…" : "Search Application"}
        </PrimaryButton>

        {error && (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-4">
            {error}
          </div>
        )}

        {result && !application && (
          <p className="text-sm text-slate-400 dark:text-slate-500 py-4 text-center">No matching application found.</p>
        )}

        {usingStoredTimeline && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-slate-700 dark:text-slate-300">
                Application Progress <span className="text-xs font-normal text-slate-400">(as of last auto-sync)</span>
              </h4>
              {row.pcc_last_synced_at && (
                <span className="text-xs text-slate-400">
                  Synced {new Date(row.pcc_last_synced_at).toLocaleString()}
                </span>
              )}
            </div>
            <ul>
              {steps.map((s) => (
                <li key={s.label} className="flex items-start gap-2 py-1.5 text-sm">
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${
                    s.done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-400 dark:text-slate-500"
                  }`}>
                    {s.done ? "✓" : ""}
                  </span>
                  <div>
                    <div className={s.done ? "text-slate-800 dark:text-slate-100 font-medium" : "text-slate-400 dark:text-slate-500"}>{s.label}</div>
                    {s.timestamp && <div className="text-xs text-blue-600">{s.timestamp}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {application && (
          <div className="mt-4">
            <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
              <div className="text-sm">
                <div className="text-xs text-slate-400 dark:text-slate-500">Application Number</div>
                <div className="font-semibold text-slate-700 dark:text-slate-300">{applicationNumber}</div>
              </div>
              <div className="text-sm">
                <div className="text-xs text-slate-400 dark:text-slate-500">Applicant Name</div>
                <div className="font-semibold text-slate-700 dark:text-slate-300">{application.applicantName}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {status?.certificateUrl && (
                  <button
                    type="button"
                    disabled={downloading}
                    onClick={handleDownload}
                    className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-lg px-4 py-2 text-sm"
                  >
                    {downloading ? "Getting link…" : "⬇ Download Certificate"}
                  </button>
                )}
                <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleCertFileChosen} />
                <button
                  type="button"
                  disabled={savingCert}
                  onClick={() => fileInputRef.current?.click()}
                  title="After downloading the PDF above, upload it here to save it in our own database"
                  className={`inline-flex items-center gap-1.5 font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-60 ${
                    certSaved
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-300"
                      : "bg-blue-900 hover:bg-blue-800 text-white"
                  }`}
                >
                  {savingCert ? "Saving…" : certSaved ? "✓ Saved to our records" : "📤 Save Certificate to DB"}
                </button>
              </div>
            </div>
            {status?.certificateUrl && (
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1.5">
                "Download Certificate" opens the PDF on the Delhi Police portal, which only works
                while you are logged in to the portal in this browser (otherwise it shows HTTP 401).
                Download the PDF there, then use "Save Certificate to DB" to keep it in our records.
              </p>
            )}

            {certData && (
              <div className="mt-4 rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-sm">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-slate-700 dark:text-slate-300">PCC Details (from portal)</h4>
                  <span className="text-xs text-slate-400 dark:text-slate-500">Record only — not the official certificate</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {[
                    ["Certificate No.", certData.pccNo],
                    ["Issued On", certData.issuedOn],
                    ["Applicant", certData.applicantName],
                    ["Father's Name", certData.fatherName],
                    ["Purpose", certData.purposeOfPcc],
                    ["Criminal Record", certData.hasCriminalRecord ? "Yes" : "None found"],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs text-slate-400 dark:text-slate-500">{k}</dt>
                      <dd className="font-medium text-slate-700 dark:text-slate-300">{v || "—"}</dd>
                    </div>
                  ))}
                </dl>
                {Array.isArray(certData.addressDetails) && certData.addressDetails.map((a, i) => (
                  <div key={i} className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Address: {a.Address || a.address} {(a.From || a.To) && `(${a.From || "?"} – ${a.To || "?"})`}
                  </div>
                ))}
              </div>
            )}

            {liveStatus && (
              <>
                <h4 className="font-semibold text-slate-700 dark:text-slate-300 mt-5 mb-3">Application Progress</h4>
                <ul>
                  {steps.map((s) => (
                    <li key={s.label} className="flex items-start gap-2 py-1.5 text-sm">
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${
                        s.done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-400 dark:text-slate-500"
                      }`}>
                        {s.done ? "✓" : ""}
                      </span>
                      <div>
                        <div className={s.done ? "text-slate-800 dark:text-slate-100 font-medium" : "text-slate-400 dark:text-slate-500"}>{s.label}</div>
                        {s.timestamp && <div className="text-xs text-blue-600">{s.timestamp}</div>}
                        {s.description && <div className="text-xs text-slate-400 dark:text-slate-500">{s.description}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {!liveStatus && result && (
              <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-4">
                Found the application, but the portal didn't send its progress this time
                {row.pcc_timeline?.length ? " (showing the last saved progress below)" : ""}. Try Search Application again.
                {(result.statusError || result.statusRaw) && (
                  <div className="mt-1 break-all text-[11px] text-amber-700/80">
                    {result.statusError
                      ? `Portal error: ${result.statusError.message}`
                      : `Portal reply: ${JSON.stringify(result.statusRaw).slice(0, 300)}`}
                  </div>
                )}
              </div>
            )}

            {lastStep.done && !status?.certificateUrl && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
                Certificate Issued — but no download link came back this time.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
