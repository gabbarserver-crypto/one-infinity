import React, { useRef, useState } from "react";
import { readAadhaar } from "../lib/aadhaarScan";

// "Upload Aadhaar to auto-fill" button. Reads the Aadhaar photo (QR first,
// OCR as fallback) and hands back only the fields it actually found, with
// the date already in DD-MM-YYYY to match the app's text DOB boxes:
//   onFill({ applicant_name, father_husband_name, date_of_birth, address })
// Nothing is saved here — the parent decides what to do with the values.
export default function AadhaarFillButton({ onFill, hint = "Please double-check everything before saving.", compact = false }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const pick = async (file) => {
    if (!file) return;
    setBusy(true); setPct(0); setNote(""); setErr("");
    try {
      const r = await readAadhaar(file, setPct);
      const patch = {};
      if (r.name) patch.applicant_name = r.name;
      if (r.fatherHusbandName) patch.father_husband_name = r.fatherHusbandName;
      if (r.dateOfBirth) patch.date_of_birth = r.dateOfBirth.split("-").reverse().join("-");
      if (r.address) patch.address = r.address;
      onFill(patch);
      const missing = [!r.name && "name", !r.fatherHusbandName && "father name", !r.dateOfBirth && "DOB", !r.address && "address"].filter(Boolean);
      const how = r.source === "ocr" ? "Read from the photo (text recognition)" : "Read from the Aadhaar QR";
      setNote(missing.length ? `${how}. Couldn't find: ${missing.join(", ")} — fill those in and check the rest.` : `${how}. ${hint}`);
    } catch (e) {
      setErr(e.message || "Couldn't read this Aadhaar");
    } finally {
      setBusy(false); setPct(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className={compact ? "mb-2" : "mb-3"}>
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="w-full border-2 border-dashed border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-blue-700 dark:text-blue-300 font-semibold py-2 rounded-xl text-sm disabled:opacity-50"
      >
        {busy ? `Reading Aadhaar…${pct ? ` ${pct}%` : ""}` : "📄 Aadhaar upload karke auto-fill karein"}
      </button>
      {note && <p className="text-xs text-emerald-600 mt-1.5">{note}</p>}
      {err && <p className="text-xs text-rose-600 mt-1.5">{err}</p>}
    </div>
  );
}
