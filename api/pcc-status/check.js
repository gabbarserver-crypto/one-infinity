// api/pcc-status/check.js
// Vercel Serverless Function — the "click to fetch" button in
// PCCStatusCheckModal.jsx calls this. Runs server-side so the browser never
// has to call pcccvr.delhipolice.gov.in directly (blocked by their CORS
// policy).
//
// Once this is deployed, point PCCStatusCheckModal.jsx at it directly
// (same-origin "/api/pcc-status/check") instead of a separately-hosted
// server — no VITE_PCC_STATUS_API_BASE env var needed.
import { lookupPccStatus } from "../_lib/pccClient.js";
import { applyCors } from "../_lib/cors.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return; // Android app preflight
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { applicationNumber, applicantName, guardianName } = req.body || {};
  if (!applicationNumber || !applicantName) {
    return res.status(400).json({ success: false, error: "applicationNumber and applicantName are required" });
  }

  try {
    const result = await lookupPccStatus({ applicationNumber, applicantName, guardianName });
    res.json(result);
  } catch (err) {
    console.error("PCC check failed:", err.message);
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.message,
      details: err.response?.data,
    });
  }
}
