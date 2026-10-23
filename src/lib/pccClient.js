// api/_lib/pccClient.js
// Shared by the PCC status serverless functions below. Not itself a route —
// files/folders starting with "_" are ignored by Vercel's file-based routing.
//
// This replaces server/index.js's PCC proxy for Vercel deployments: instead
// of needing a separately-hosted Express server, these run as Vercel
// Serverless Functions right alongside the frontend.
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { fetchAllRows } from "./paging.js";

const DELHI_PCC_BASE_URL =
  process.env.DELHI_PCC_BASE_URL || "https://pcccvr.delhipolice.gov.in/api/PccForm";
const PORTAL_ORIGIN = process.env.DELHI_PCC_ORIGIN || "https://pcccvr.delhipolice.gov.in";
const CSRF_URL = `${PORTAL_ORIGIN}/api/Authorization/get-csrf-token`;

// The portal's public Track Application page now fetches a CSRF token first
// and sends it back on every PccForm call. We don't know for sure which
// header name it uses, so unless PCC_CSRF_HEADER is set we send the token
// under the usual names -- extra headers are harmless to the server.
const CSRF_HEADER_NAMES = process.env.PCC_CSRF_HEADER
  ? [process.env.PCC_CSRF_HEADER]
  : ["X-CSRF-TOKEN", "X-XSRF-TOKEN", "RequestVerificationToken", "CSRF-TOKEN"];

const BROWSER_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Origin: PORTAL_ORIGIN,
  Referer: `${PORTAL_ORIGIN}/login`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

const delhiClient = axios.create({
  baseURL: DELHI_PCC_BASE_URL,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

// ---- Portal session (CSRF token + cookies) -------------------------------
// This is the same anonymous handshake the public page does. No login, no
// captcha involved. One session can be reused for many lookups.
function mergeSetCookie(jar, setCookie) {
  for (const line of setCookie || []) {
    const [pair] = String(line).split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function createPortalSession() {
  const session = { token: null, jar: new Map() };
  session.refresh = async () => {
    session.jar.clear();
    const r = await axios.get(CSRF_URL, { timeout: 15000, headers: BROWSER_HEADERS });
    const token = r.data?.token;
    if (!token) throw new Error("Portal did not return a CSRF token");
    session.token = token;
    mergeSetCookie(session.jar, r.headers["set-cookie"]);
  };
  await session.refresh();
  return session;
}

function sessionHeaders(session) {
  const headers = { ...BROWSER_HEADERS };
  for (const name of CSRF_HEADER_NAMES) headers[name] = session.token;
  if (session.jar.size) headers.Cookie = cookieHeader(session.jar);
  return headers;
}

// POST to a PccForm endpoint inside a session. If the portal rejects the
// token (expired / mismatched), fetch a fresh one and retry exactly once.
async function portalPost(session, path, body) {
  const attempt = async () => {
    const r = await delhiClient.post(path, body, { headers: sessionHeaders(session) });
    mergeSetCookie(session.jar, r.headers["set-cookie"]);
    return r;
  };
  try {
    return await attempt();
  } catch (e) {
    const code = e.response?.status;
    if (code === 400 || code === 401 || code === 403 || code === 419) {
      await session.refresh();
      return await attempt();
    }
    throw e;
  }
}

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
 * Mirrors what the Delhi Police portal's public "Track Application" page
 * does (no login, no captcha):
 *   0. GET  /api/Authorization/get-csrf-token
 *   1. POST /search-pcc-application     { applicationNumber, applicantName, guardianName }
 *   2. POST /get-pcc-application-status { applicationId, applicationNumber, applicantName, guardianName }
 * Pass an existing `session` (from createPortalSession) to reuse it across
 * many applications; otherwise one is created for this call.
 */
export async function lookupPccStatus({ applicationNumber, applicantName, guardianName }, session = null) {
  const s = session || (await createPortalSession());

  const searchResult = await portalPost(s, "/search-pcc-application", {
    applicationNumber,
    applicantName,
    guardianName,
  });

  const application = searchResult.data?.data?.[0] || null;
  if (!application?.applicationID) {
    return { success: false, stage: "search", raw: searchResult.data };
  }

  const statusOutcome = await fetchApplicationStatus(s, application);

  return {
    success: true,
    application,
    status: statusOutcome.data,
    statusError: statusOutcome.error,
    // When the portal answered OK but without a usable "data" object, hand its
    // raw reply back so the UI can show what actually came back.
    statusRaw: statusOutcome.data ? null : statusOutcome.raw,
  };
}

async function fetchApplicationStatus(session, application) {
  const id = String(application.applicationID);
  // First shape is exactly what the portal's own page sends now; the second
  // is the older id-only shape, kept as a fallback.
  const variants = [
    {
      applicationId: id,
      applicationNumber: application.applicationNumber,
      applicantName: application.applicantName,
      guardianName: application.guardianName,
    },
    { applicationId: id },
  ];

  let raw = null;
  let error = null;
  for (const body of variants) {
    try {
      const r = await portalPost(session, "/get-pcc-application-status", body);
      if (r.data?.data) return { data: r.data.data, raw: null, error: null };
      raw = r.data ?? null;
    } catch (e) {
      error = { message: e.message, body: e.response?.data || null };
    }
  }
  return { data: null, raw, error: raw ? null : error };
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
// The certificateUrl carries a short-lived token, so call this right after
// the status lookup that returned it, with the same session. It is not yet
// confirmed that the portal serves this URL without a login: whatever comes
// back is only stored if it really is a PDF (a login/error page is rejected),
// and on failure the manual "Save Certificate to DB" upload still works.
export async function downloadAndStoreCertificate({ applicationId, url, session = null }) {
  if (!supabaseSync) throw new Error("Supabase not configured");

  const headers = session ? sessionHeaders(session) : BROWSER_HEADERS;
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 20000, headers });

  const buf = Buffer.from(resp.data);
  if (buf.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error(`portal did not return a PDF (HTTP ${resp.status}, ${resp.headers["content-type"] || "unknown type"})`);
  }

  const path = `pcc-certificates/${applicationId}.pdf`;
  const { error } = await supabaseSync.storage
    .from("application-documents")
    .upload(path, buf, { contentType: "application/pdf", upsert: true });

  if (error) throw new Error(error.message);
  return path;
}

/**
 * Re-checks every application that has a PCC number and isn't already fully
 * done, and writes the current stage/timeline (and pcc_status, kept in sync
 * for the existing dropdown/filters/reports) back onto the row. Once a row
 * reaches "Certificate Issued" AND the certificate has actually been
 * captured (pcc_certificate_path set), it's left alone — until then it
 * keeps getting re-checked every run, specifically so a Certificate Issued
 * row whose auto-download failed (see downloadAndStoreCertificate's caveat)
 * gets retried on the next run instead of being dropped.
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
      .select("id, pcc_no, applicant_name, father_husband_name, pcc_status, pcc_stage, pcc_certificate_path")
      .not("pcc_no", "is", null)
      .not("pcc_status", "in", '("Rejected","Police Case")')
      .order("id", { ascending: true })
  );

  if (fetchError) {
    console.error("PCC auto-sync: failed to load applications", fetchError.message);
    return { checked: 0, updated: 0, errors: [fetchError.message] };
  }

  // Fully done = certificate issued AND we already have the PDF stored — no
  // point re-hitting the portal for those every 2 hours forever.
  const rows = (allRows || []).filter(
    (r) => !(r.pcc_stage === "Certificate Issued" && r.pcc_certificate_path)
  );

  let updated = 0;
  let certificatesCaptured = 0;
  const errors = [];

  let session;
  try {
    session = await createPortalSession();
  } catch (e) {
    console.error("PCC auto-sync: could not start a portal session:", e.message);
    return { checked: 0, updated: 0, errors: [`portal session: ${e.message}`] };
  }

  for (const row of rows) {
    const applicationNumber = normalizePccApplicationNumber(row.pcc_no);
    const guardianName = stripKinPrefix(row.father_husband_name || "");

    try {
      const result = await lookupPccStatus(
        { applicationNumber, applicantName: row.applicant_name, guardianName },
        session
      );

      if (!result.success) continue; // not found on portal this round, leave as-is

      // Portal found the application but sent no status: leave the row alone,
      // including pcc_last_synced_at, so "Synced ..." only ever means real data.
      if (!result.status) {
        errors.push(`row ${row.id} (${row.pcc_no}): portal returned no status`);
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
            session,
          });
          certificatesCaptured += 1;
        } catch (certErr) {
          // Logged, not fatal -- retried on the next run (see the note on
          // downloadAndStoreCertificate).
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

    // Small delay between requests so we don't hammer the portal.
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(
    `PCC auto-sync: checked ${rows.length}, updated ${updated}, certificates captured ${certificatesCaptured}, errors ${errors.length}`
  );
  return { checked: rows.length, updated, certificatesCaptured, errors };
}
