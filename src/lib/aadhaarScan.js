// src/lib/aadhaarScan.js
//
// One entry point for "upload an Aadhaar photo and fill the form":
//   1. Try the QR code first (exact data incl. full DOB on newer cards).
//   2. If there's no readable QR, fall back to OCR over the printed text.
// Returns the same shape either way, plus `source` ("secure-qr" | "old-qr"
// | "ocr") so the UI can tell the user how much to trust it.
import { scanAadhaarQr } from "./aadhaarQr";
import { scanAadhaarImage } from "./aadhaarOcr";

export async function readAadhaar(file, onProgress) {
  let qrError = null;
  try {
    return await scanAadhaarQr(file);
  } catch (e) {
    qrError = e;
  }
  try {
    const r = await scanAadhaarImage(file, onProgress);
    return { ...r, source: "ocr" };
  } catch (e) {
    // Show the OCR error, but keep the QR one in the message if OCR isn't set up.
    throw new Error(e.message || qrError?.message || "Couldn't read this Aadhaar image");
  }
}
