// api/pcc-status/sync-all.js
// Vercel Serverless Function — re-checks every open PCC application and
// updates pcc_status. Triggered on a schedule by Vercel Cron (see
// vercel.json), and protected by CRON_SECRET so no one else can call it.
//
// Required Vercel env vars (Project Settings → Environment Variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   CRON_SECRET            (any random string you generate — Vercel Cron
//                            automatically sends it as a Bearer token)
//
// NOTE ON PLAN LIMITS: Vercel's Hobby (free) plan only allows cron jobs to
// run once per day, not every 2 hours — that restriction is Vercel's, not
// something this code can get around. If you're on Hobby, leave the
// schedule in vercel.json as-is but also set up a free external scheduler
// (e.g. cron-job.org) to POST to this same URL every 2 hours with the
// header:  Authorization: Bearer <your CRON_SECRET>
import { timingSafeEqual } from "node:crypto";
import { runPccAutoSync } from "../_lib/pccClient.js";

export const config = { maxDuration: 60 };

function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  // Only the Bearer secret is accepted. Vercel Cron sends it automatically
  // as `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET env var is
  // set. The `x-vercel-cron` header is NOT proof of anything -- any client
  // can send it -- so it is deliberately not checked here.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("sync-all: CRON_SECRET is not set; refusing to run");
    return res.status(500).json({ error: "Server isn't configured with CRON_SECRET" });
  }
  const authHeader = req.headers.authorization || "";
  const providedSecret = authHeader.replace(/^Bearer\s+/i, "");
  if (!secretMatches(providedSecret, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await runPccAutoSync();
    res.json(result);
  } catch (err) {
    console.error("PCC auto-sync crashed:", err.message);
    res.status(500).json({ error: err.message });
  }
}
