// api/remove-bg.js
//
// Vercel Serverless Function — removes the background from an uploaded
// signature (or any) image using the remove.bg API. The remove.bg API key
// only ever lives here as a server-side env var; the browser never sees it.
//
// Request  (POST, JSON):  { accessToken, imageBase64 }
//   imageBase64 = the raw base64 of a JPEG/PNG (no "data:...;base64," prefix needed,
//   but it is stripped if present). Keep it small — the client downsizes to
//   ~1200px before sending, because Vercel functions cap request bodies at ~4.5 MB.
// Response (200):         { imageBase64, mime: "image/png" }  — transparent PNG
// Errors:                 { error } with a normal 4xx/5xx status
//
// Required Vercel env var (Project Settings → Environment Variables):
//   REMOVE_BG_API_KEY   (remove.bg → Dashboard → API Key)
//
// Auth: any signed-in staff / dealer / dealer_staff (same resolveCaller()
// rule as the other endpoints). Without this, anyone on the internet could
// burn the remove.bg credits.
import { applyCors } from "./_lib/cors.js";
import { resolveCaller } from "./_lib/adminAuth.js";

const REMOVE_BG_API_KEY = (process.env.REMOVE_BG_API_KEY || "").trim();
const MAX_BYTES = 3 * 1024 * 1024; // decoded image cap (base64 JSON body must stay < 4.5 MB)

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!REMOVE_BG_API_KEY) {
    return res.status(500).json({ error: "Server isn't configured with REMOVE_BG_API_KEY" });
  }

  try {
    const { accessToken, imageBase64 } = req.body || {};

    const caller = await resolveCaller(accessToken);
    if (!caller) return res.status(403).json({ error: "Not signed in" });

    if (typeof imageBase64 !== "string" || !imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }
    const clean = imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(clean, "base64");
    if (!buf.length) return res.status(400).json({ error: "Invalid image data" });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: "Image is too large" });

    const form = new FormData();
    form.append("image_file", new Blob([buf]), "signature.jpg");
    form.append("size", "auto");   // full resolution up to 0.25 MP on free credits; larger on paid
    form.append("format", "png");  // PNG keeps the transparency

    const r = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVE_BG_API_KEY },
      body: form,
    });

    if (!r.ok) {
      // remove.bg returns { errors: [{ title, detail, code }] }
      const j = await r.json().catch(() => ({}));
      const detail = j?.errors?.[0]?.title || j?.errors?.[0]?.detail || `remove.bg error (${r.status})`;
      console.error("remove-bg failed:", r.status, JSON.stringify(j));
      // 402 = out of credits; pass something clear to the UI.
      const status = r.status === 402 ? 402 : r.status === 429 ? 429 : 502;
      return res.status(status).json({ error: detail });
    }

    const out = Buffer.from(await r.arrayBuffer());
    res.json({ imageBase64: out.toString("base64"), mime: "image/png" });
  } catch (e) {
    console.error("remove-bg failed:", e);
    res.status(500).json({ error: e.message || "Unexpected server error" });
  }
}
