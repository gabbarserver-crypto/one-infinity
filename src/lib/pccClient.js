// api/_lib/pccClient.js
// Shared by the PCC status serverless functions below. Not itself a route —
// files/folders starting with "_" are ignored by Vercel's file-based routing.
//
// This replaces server/index.js's PCC proxy for Vercel deployments: instead
// of needing a separately-hosted Express server, these run as Vercel
// Serverless Functions right alongside the frontend.
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { fetchAllRows } from "./fetchAll";

const DELHI_PCC_BASE_URL =
  process.env.DELHI_PCC_BASE_URL || "https://pcccvr.delhipolice.gov.in/api/PccForm";

const delhiClient = axios.create({
  baseURL: DELHI_PCC_BASE_URL,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

export const supabaseSync =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

// Delhi Police's portal expects the FULL application number including the
// "DLSB-PCC/" prefix. Mirrors normalizePccApplicationNumber() in
// PCCStatusCheckModal.jsx.
export function normalizePccApplicationNumber(pccNo) {
  if (!pccNo) return pccNo;
  const trimmed = pccNo.trim();
  return /^DLSB-PCC\//i.test(trimmed) ? trimmed : `DLSB-PCC/${trimmed}`;
}

function stripKinPrefix(name) {
  if (!name) return name;
  return name.replace(/^\s*(s\/o|w\/o|d\/o|c\/o)[\s:.]*?/i, "").trim();
}

/**
 * Mirrors exactly what the Delhi Police portal's own public "Track
 * Application" page calls:
 *   1. POST /search-pcc-application    { applicationNumber, applicantName, guardianName }
 *   2. POST /get-pcc-applicant-details { applicationID }   <- capital ID
 *   3. POST /get-pcc-application-status { applicationId }  <- lowercase d
 */
export async function lookupPccStatus({ applicationNumber, applicantName, guardianName }) {
  const searchResult = await delhiClient.post("/search-pcc-application", {
    applicationNumber,
    applicantName,
    guardianName,
  });

  const application = searchResult.data?.data?.[0] || null;
  if (!application?.applicationID) {
    return { success: false, stage: "search", raw: searchResult.data };
  }

  const id = String(application.applicationID);

  const [detailsResult, statusResult] = await Promise.allSettled([
    delhiClient.post("/get-pcc-applicant-details", { applicationID: id }),
    delhiClient.post("/get-pcc-application-status", { applicationId: id }),
  ]);

  return {
    success: true,
    application,
    details: detailsResult.status === "fulfilled" ? detailsResult.value.data?.data || null : null,
    status: statusResult.status === "fulfilled" ? statusResult.value.data?.data || null : null,
    statusError: statusResult.status === "rejected"
      ? { message: statusResult.reason.message, body: statusResult.reason.response?.data || null }
      : null,
  };
}

// Delhi Police's timeline "stage" values (Pending, Assigned, Field Verified,
// Approved, Verified, Certificate Issued) are more granular than the
// dropdown in Applications.jsx (Under Verification, Certificate Issued,
// Rejected, Police Case). Anything before "Certificate Issued" maps to
// "Under Verification" — there's no confirmed API signal yet for Rejected /
// Police Case, so those two stay manual until we see a real example.
export function mapStageToDropdownStatus(status) {
  const timeline = status?.timeline || [];
  const stages = new Set(timeline.map((t) => t.stage));
  if (stages.has("Certificate Issued")) return "Certificate Issued";
  if (timeline.length > 0) return "Under Verification";
  return null; // no timeline data back — don't overwrite whatever's there
}

// The 6 stages, in order, exactly as PCCStatusCheckModal.jsx renders them.
// Kept here too so the auto-sync can persist "how far did it get" without
// the frontend having to re-call the portal just to show the stepper.
export const PCC_STAGE_ORDER = ["Pending", "Assigned", "Field Verified", "Approved", "Verified", "Certificate Issued"];

// Given a status response, returns the furthest stage reached (or null if no
// timeline came back) plus the raw timeline array to store as-is.
export function buildStageSnapshot(status) {
  const timeline = status?.timeline || [];
  const stagesReached = new Set(timeline.map((t) => t.stage));
  let currentStage = null;
  for (const stage of PCC_STAGE_ORDER) {
    if (stagesReached.has(stage)) currentStage = stage;
  }
  return { currentStage, timeline };
}

// Downloads the certificate PDF and stores it in the same
// "application-documents" Supabase Storage bucket the rest of the app
// already uses (see src/lib/chat.js), under pcc-certificates/<applicationId>.pdf.
//
// IMPORTANT CAVEAT: the certificateUrl the portal returns is, per
// PCCStatusCheckModal.jsx, only good for someone with an active logged-in
// browser session on pcccvr.delhipolice.gov.in. This serverless function has
// no such session, so this will very likely fail with a 401 until/unless a
// portal service-account login is wired in here too (not yet confirmed —
// same "needs a real example from you" situation as the status endpoint
// originally was). It's still worth attempting on every sync in case the
// portal ever serves it without auth, but don't rely on it — the manual
// "Upload Certificate" fallback in the UI is the reliable path today.
export async function downloadAndStoreCertificate({ applicationId, url }) {
  if (!supabaseSync) throw new Error("Supabase not configured");

  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
  const path = `pcc-certificates/${applicationId}.pdf`;

  const { error } = await supabaseSync.storage
    .from("application-documents")
    .upload(path, resp.data, { contentType: "application/pdf", upsert: true });

  if (error) throw new Error(error.message);
  return path;
}

// Vercel's serverless functions have a hard wall-clock limit (maxDuration
// below, currently 60s — see vercel.json/this file's config export). With
// enough open applications, checking every single one in one run — each a
// real round trip to the Delhi Police portal plus a deliberate delay so we
// don't hammer it — can easily exceed that and get killed mid-run
// (FUNCTION_INVOCATION_TIMEOUT), silently dropping every update from that
// run, including any DB writes.
//
// Fix: process oldest-synced-first (so a never-yet-checked row always wins
// over one we already know the status of), and stop with time to spare
// rather than letting Vercel kill us — whatever's left over just gets
// picked up on the next cron run a couple hours later. Over a few runs,
// every application still gets covered; no single run risks timing out.
const TIME_BUDGET_MS = 45_000; // leaves ~15s headroom under the 60s cap
const REQUEST_DELAY_MS = 200; // politeness delay between portal hits

/**
 * Re-checks open applications (oldest-synced first, time-budgeted so a run
 * never times out) and writes the current stage/timeline (and pcc_status,
 * kept in sync for the existing dropdown/filters/reports) back onto each
 * row. Once a row reaches "Certificate Issued" AND the certificate has
 * actually been captured (pcc_certificate_path set), it's left alone —
 * until then it keeps getting re-checked every run, specifically so a
 * Certificate Issued row whose auto-download failed (see
 * downloadAndStoreCertificate's caveat) gets retried on a later run instead
 * of being dropped.
 */
export async function runPccAutoSync() {
  if (!supabaseSync) {
    console.error("PCC auto-sync skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return { checked: 0, updated: 0, errors: ["Supabase not configured"] };
  }

  // Paged: a single request stops at Supabase's 1000-row cap, so only the
  // first 1000 PCC applications would ever have been re-checked.
  const { data: allRows, error: fetchError } = await fetchAllRows(() =>
    supabaseSync
      .from("applications")
      .select("id, pcc_no, applicant_name, father_husband_name, pcc_status, pcc_stage, pcc_certificate_path, pcc_last_synced_at")
      .not("pcc_no", "is", null)
      .not("pcc_status", "in", '("Rejected","Police Case")')
      .order("pcc_last_synced_at", { ascending: true, nullsFirst: true })
      .order("id", { ascending: true })
  );

  if (fetchError) {
    console.error("PCC auto-sync: failed to load applications", fetchError.message);
    return { checked: 0, updated: 0, errors: [fetchError.message] };
  }

  // Fully done = certificate issued AND we already have the PDF stored — no
  // point re-hitting the portal for those every run forever.
  const pending = (allRows || []).filter(
    (r) => !(r.pcc_stage === "Certificate Issued" && r.pcc_certificate_path)
  );

  const startedAt = Date.now();
  let processed = 0;
  let updated = 0;
  let certificatesCaptured = 0;
  const errors = [];

  for (const row of pending) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      console.log(`PCC auto-sync: stopping early at time budget — ${pending.length - processed} rows left for next run`);
      break;
    }

    processed += 1;
    const applicationNumber = normalizePccApplicationNumber(row.pcc_no);
    const guardianName = stripKinPrefix(row.father_husband_name || "");

    try {
      const result = await lookupPccStatus({
        applicationNumber,
        applicantName: row.applicant_name,
        guardianName,
      });

      if (!result.success) {
        // Still touch pcc_last_synced_at so a row that's consistently not
        // found on the portal doesn't permanently hog the front of the
        // oldest-first queue — it'll cycle back after everything else does.
        await supabaseSync.from("applications").update({ pcc_last_synced_at: new Date().toISOString() }).eq("id", row.id);
        continue;
      }

      const { currentStage, timeline } = buildStageSnapshot(result.status);
      const newDropdownStatus = mapStageToDropdownStatus(result.status);

      const updates = { pcc_last_synced_at: new Date().toISOString() };
      if (currentStage && currentStage !== row.pcc_stage) updates.pcc_stage = currentStage;
      if (timeline.length) updates.pcc_timeline = timeline;
      if (newDropdownStatus && newDropdownStatus !== row.pcc_status) updates.pcc_status = newDropdownStatus;

      if (currentStage === "Certificate Issued" && !row.pcc_certificate_path && result.status?.certificateUrl) {
        try {
          updates.pcc_certificate_path = await downloadAndStoreCertificate({
            applicationId: row.id,
            url: result.status.certificateUrl,
          });
          certificatesCaptured += 1;
        } catch (certErr) {
          // Expected to fail without a portal session (see caveat on
          // downloadAndStoreCertificate) — logged, not fatal, retried next run.
          errors.push(`row ${row.id} certificate download: ${certErr.message}`);
        }
      }

      const { error: updateError } = await supabaseSync
        .from("applications")
        .update(updates)
        .eq("id", row.id);

      if (updateError) {
        errors.push(`row ${row.id}: ${updateError.message}`);
      } else if (Object.keys(updates).length > 1) {
        updated += 1;
      }
    } catch (err) {
      errors.push(`row ${row.id} (${row.pcc_no}): ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  console.log(
    `PCC auto-sync: ${processed}/${pending.length} checked this run, ${updated} updated, ${certificatesCaptured} certificates captured, ${errors.length} errors`
  );
  return { totalPending: pending.length, checked: processed, updated, certificatesCaptured, errors };
}
