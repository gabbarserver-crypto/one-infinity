// src/lib/aadhaarOcr.js
//
// Fallback for when the Aadhaar QR can't be read (newer compressed Secure
// QR, or a blurry/cut QR) — runs OCR over the card photo instead and pulls
// Name / DOB / Father-Guardian name / Address out of the recognized text
// with regex heuristics.
//
// REQUIRES the `tesseract.js` package, which is NOT installed yet — this
// sandbox has no network access to add it, so add it yourself on a machine
// with internet before building:
//     npm install tesseract.js
// It's loaded via dynamic import() only when this is actually used (not at
// app startup), so it doesn't add to the normal page-load bundle size —
// but the import will fail with a clear error until that install is done.
//
// OCR is inherently less reliable than the QR path (misreads on blur/
// glare/angle, and Aadhaar's exact layout varies slightly card to card) —
// every field here is a best-effort regex match over noisy recognized
// text. Unlike a cleanly-decoded QR, this should always be treated as a
// starting point for the dealer to review, not trusted blindly.
export async function scanAadhaarImage(file, onProgress) {
  let Tesseract;
  try {
    Tesseract = (await import("tesseract.js")).default;
  } catch (e) {
    throw new Error("OCR isn't set up yet — the tesseract.js package needs to be installed first.");
  }

  const input = await preprocessForOcr(file);
  const { data } = await Tesseract.recognize(input, "eng", {
    logger: (m) => {
      if (onProgress && m.status === "recognizing text") onProgress(Math.round((m.progress || 0) * 100));
    },
  });
  const text = data.text || "";
  if (!text.trim()) {
    throw new Error("Couldn't read any text from this image — try a clearer, well-lit photo.");
  }

  return parseAadhaarText(text);
}

// Phone photos are often small, dim or colour-cast. Upscale to ~2200px on the
// long side, convert to grayscale and stretch the contrast — this alone
// noticeably improves Tesseract's accuracy. Falls back to the original file
// if anything about the canvas step fails.
async function preprocessForOcr(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(2.5, 2200 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  } catch {
    return file;
  }
}

function extractGuardianName(text) {
  const m = text.match(/(?:S\/O|D\/O|W\/O|C\/O)[:.]?\s*([A-Za-z][A-Za-z\s]{2,60})/i);
  return m ? m[1].trim().replace(/\s{2,}/g, " ") : "";
}

// Unlike the QR (year only), Aadhaar's printed "DOB: DD/MM/YYYY" label
// gives us the FULL date, so this one can safely prefill the date field
// directly — it's reading an explicit label, not inferring anything.
function extractDob(text) {
  const m = text.match(/(?:DOB|Date of Birth)[:\s]*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})/i);
  if (!m) return "";
  const parts = m[1].split(/[\/\-]/);
  if (parts.length !== 3) return "";
  const [d, mo, y] = parts;
  if (y.length !== 4) return "";
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`; // yyyy-mm-dd, for <input type="date">
}

function extractGender(text) {
  if (/female/i.test(text)) return "Female";
  if (/\bmale\b/i.test(text)) return "Male";
  if (/transgender/i.test(text)) return "Transgender";
  return "";
}

// Aadhaar's printed Name line is, on virtually every real card, the line
// immediately above the DOB line in the English block — a common,
// reasonably-reliable heuristic (used by most open-source Aadhaar-OCR
// tools), not an officially documented layout rule.
function extractName(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const dobIdx = lines.findIndex((l) => /DOB|Date of Birth/i.test(l));
  if (dobIdx > 0) {
    const candidate = lines[dobIdx - 1];
    if (candidate.length >= 3 && /^[A-Za-z\s.]+$/.test(candidate)) return candidate;
  }
  return "";
}

// Grabs everything after an "Address" label up through a 6-digit PIN code
// — Aadhaar's printed address block always ends with one.
function extractAddress(text) {
  const clean = (t) => t.replace(/\s*\n\s*/g, ", ").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim();
  // 1) "Address: ..." label up to the 6-digit PIN
  let m = text.match(/Address[:\s]*([\s\S]{10,300}?\b\d{6}\b)/i);
  if (m) return clean(m[1]);
  // 2) No readable label (common when the label is only in Hindi): the
  // address block starts with C/O, S/O, D/O or W/O and also ends at the PIN.
  m = text.match(/((?:C\/O|S\/O|D\/O|W\/O)[:.\s][\s\S]{10,300}?\b\d{6}\b)/i);
  if (m) return clean(m[1]);
  return "";
}

function extractPincode(text) {
  const m = text.match(/\b(\d{6})\b/);
  return m ? m[1] : "";
}

function parseAadhaarText(text) {
  return {
    name: extractName(text),
    fatherHusbandName: extractGuardianName(text),
    dateOfBirth: extractDob(text),
    gender: extractGender(text),
    address: extractAddress(text),
    pincode: extractPincode(text),
    rawText: text, // kept for debugging, never shown to the dealer
  };
}
