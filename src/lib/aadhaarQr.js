// src/lib/aadhaarQr.js
//
// Reads the QR code printed on an Aadhaar card / e-Aadhaar and pulls out
// Name, DOB, Father/Guardian name and Address — used to prefill the New
// Application form instead of the dealer typing it all by hand.
//
// Aadhaar cards carry one of two QR formats:
//
//   1. NEWER "Secure QR" (all cards/e-Aadhaar for several years now). The QR
//      holds one very long DECIMAL NUMBER (digits only). UIDAI's published
//      scheme: number -> big integer -> bytes -> GZip-decompress -> text
//      fields separated by byte 255 (name, full DOB dd-mm-yyyy, gender,
//      care-of, district, landmark, house, location, pincode, post office,
//      state, street, sub-district, VTC, then photo bytes). Because the QR
//      text is just digits, nothing is lost reading it as a string, so this
//      is fully decodable in the browser, and it gives the FULL date of birth.
//
//   2. OLDER plain-text QR — a "|"-delimited string with year of birth only.
//
// Reading the QR image: the browser's built-in BarcodeDetector is used when
// present (Chrome on Android / Mac). Desktop Chrome on Windows/Linux doesn't
// have it, so we fall back to the small `jsqr` library (loaded only when
// needed).
//
// Anything that doesn't validate (bad DOB shape, no name, ...) throws rather
// than returning guessed data — this is an official RTO application, so a
// clear "couldn't read" is better than silently wrong details.
const FIELD_ORDER = [
  "referenceId", // Aadhaar reference no. / last digits — often blank on masked cards
  "name",
  "gender",
  "yob", // year of birth only — old format doesn't carry the full DOB
  "careOf", // "S/O: ...", "D/O: ...", "W/O: ...", "C/O: ..." — father/husband/guardian name
  "district",
  "landmark",
  "house",
  "location",
  "pincode",
  "postOffice",
  "state",
];

export function isAadhaarQrScanSupported() {
  // Always offered now: BarcodeDetector if present, jsqr fallback otherwise.
  return typeof window !== "undefined";
}

// Strips a "S/O: X", "D/O: X", "W/O: X", "C/O: X" (or without the colon)
// prefix off Aadhaar's careOf field, returning just the name.
function extractGuardianName(careOf) {
  if (!careOf) return "";
  const m = careOf.match(/^\s*(?:S\/O|D\/O|W\/O|C\/O)[:.]?\s*(.+)$/i);
  return (m ? m[1] : careOf).trim();
}

function buildAddress(fields) {
  const seen = new Set();
  return [fields.house, fields.street, fields.landmark, fields.location, fields.vtc, fields.postOffice, fields.subDistrict, fields.district, fields.state, fields.pincode]
    .map((x) => (x || "").trim())
    .filter((x) => {
      if (!x) return false;
      const k = x.toLowerCase();
      if (seen.has(k)) return false; // district/sub-district/VTC often repeat each other
      seen.add(k);
      return true;
    })
    .join(", ");
}

// ---- Secure QR (digits -> gzip -> 255-delimited fields) -------------------

const SECURE_FIELDS = [
  "indicator", "referenceId", "name", "dob", "gender", "careOf", "district",
  "landmark", "house", "location", "pincode", "postOffice", "state", "street",
  "subDistrict", "vtc",
];

async function gunzip(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't open the newer Aadhaar QR — please update Chrome or fill the details manually.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function digitsToBytes(digits) {
  let hex = BigInt(digits).toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Exported separately so it can be unit-tested without a camera/QR image.
export async function decodeSecureQrDigits(digits) {
  let bytes;
  try {
    bytes = await gunzip(digitsToBytes(digits));
  } catch (e) {
    if (e?.message?.includes("update Chrome")) throw e;
    throw new Error("Couldn't read this Aadhaar QR — please try a clearer photo or fill the details manually.");
  }

  // Split the text fields on byte 255 (stop once we have all 16; the rest is
  // the photo and hashes).
  const decoder = new TextDecoder("utf-8");
  const parts = [];
  let from = 0;
  for (let i = 0; i < bytes.length && parts.length < SECURE_FIELDS.length + 1; i++) {
    if (bytes[i] === 255) {
      parts.push(decoder.decode(bytes.slice(from, i)));
      from = i + 1;
    }
  }
  if (parts[0] && /^V\d+$/.test(parts[0].trim())) parts.shift(); // version marker on newer cards

  const f = {};
  SECURE_FIELDS.forEach((k, i) => { f[k] = (parts[i] || "").trim(); });

  const dobMatch = f.dob.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const yearOnly = /^\d{4}$/.test(f.dob);
  if (!f.name || !(dobMatch || yearOnly) || !/^\d{6}$/.test(f.pincode)) {
    throw new Error("Couldn't read this Aadhaar QR reliably — please try a clearer photo or fill the details manually.");
  }

  return {
    name: f.name,
    fatherHusbandName: extractGuardianName(f.careOf),
    dateOfBirth: dobMatch ? `${dobMatch[3]}-${dobMatch[2]}-${dobMatch[1]}` : "", // yyyy-mm-dd for <input type="date">
    yearOfBirth: dobMatch ? dobMatch[3] : f.dob,
    gender: f.gender === "M" ? "Male" : f.gender === "F" ? "Female" : f.gender === "T" ? "Transgender" : f.gender,
    address: buildAddress(f),
    pincode: f.pincode,
    source: "secure-qr",
  };
}

// ---- Old plain-text QR ------------------------------------------------------

function parseOldQr(raw) {
  const parts = raw.split("|");
  if (parts.length < 6) {
    throw new Error("Couldn't recognize this QR's format — please fill the details manually.");
  }
  const fields = {};
  FIELD_ORDER.forEach((key, i) => { fields[key] = (parts[i] || "").trim(); });
  return {
    name: fields.name || "",
    fatherHusbandName: extractGuardianName(fields.careOf),
    dateOfBirth: "", // old format has year only — never invent a day/month
    yearOfBirth: /^\d{4}$/.test(fields.yob) ? fields.yob : "",
    gender: fields.gender || "",
    address: buildAddress(fields),
    pincode: fields.pincode || "",
    source: "old-qr",
  };
}

// ---- Getting the QR text out of the photo ------------------------------------

async function readQrText(file) {
  const bitmap = await createImageBitmap(file);

  if ("BarcodeDetector" in window) {
    try {
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const results = await detector.detect(bitmap);
      if (results.length && results[0].rawValue) return results[0].rawValue;
    } catch { /* fall through to jsqr */ }
  }

  const jsQR = (await import("jsqr")).default;
  for (const maxSide of [2400, 1600, 1000]) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const hit = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
    if (hit?.data) return hit.data;
  }
  return "";
}

// Throws with a message meant to be shown directly to the dealer — keep
// these short and actionable, not technical.
export async function scanAadhaarQr(file) {
  const raw = (await readQrText(file)).trim();
  if (!raw) {
    throw new Error("No QR code found in this image. Make sure the QR on the Aadhaar is clearly visible and try again.");
  }
  if (/^\d{100,}$/.test(raw)) return await decodeSecureQrDigits(raw);
  if (raw.includes("|")) return parseOldQr(raw);
  throw new Error("This doesn't look like an Aadhaar QR — please try again or fill the details manually.");
}
