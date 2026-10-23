// src/components/PCCLetterModal.jsx
import React, { useEffect, useState } from "react";
import { GhostButton, PrimaryButton, Field, Input, Select } from "./UI";
import SearchableSelect from "./SearchableSelect";
import { DELHI_POLICE_STATIONS } from "../lib/delhiPoliceStations";
import { todayIST } from "../lib/dates";

function isoToDDMMYYYY(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// Given a stay_since date (ISO, YYYY-MM-DD), how many whole years has the
// applicant been at that address as of today — used to phrase "resident for
// the past N years" on the letter without asking anyone to type a number
// that immediately goes stale.
function yearsSince(iso) {
  if (!iso) return "";
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return "";
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  const monthDiff = now.getMonth() - start.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < start.getDate())) years--;
  return Math.max(0, years);
}

const DEFAULT_ADDRESSEE =
  "The Deputy Commissioner of Police,\nSpecial Branch\nDelhi Police Bhawan\nNew Delhi 110002";

// Police Clearance Certificate request letter for a vehicle registration —
// same wording/layout as the office's existing PCC request template, but
// auto-filled from the application (name, father/husband name, address,
// mobile, police station, and years resident computed from "stay since") —
// no more retyping resident years or police station by hand at print time.
// The handful of details the app doesn't store (addressee, vehicle type)
// stay editable right above the letter.
// Printing uses a "print-isolate" trick (see index.css) so it comes out
// clean even though this lives inside a scrolling modal.
export default function PCCLetterModal({ app, onClose }) {
  const today = todayIST();
  const [date, setDate] = useState(app.application_date || today);
  const [relation, setRelation] = useState("S/o.");
  const [vehicleType, setVehicleType] = useState("");
  const [policeStation, setPoliceStation] = useState(app.police_station || "");
  const [residentYears, setResidentYears] = useState(() => {
    const computed = yearsSince(app.stay_since);
    return computed === "" ? "" : String(computed);
  });
  const [addressee, setAddressee] = useState(DEFAULT_ADDRESSEE);

  const signatureDoc = (app.docs || []).find((d) => /sign/i.test(d.name) && d.file_url);

  useEffect(() => {
    const cleanup = () => document.body.classList.remove("print-isolate");
    window.addEventListener("afterprint", cleanup);
    return () => {
      window.removeEventListener("afterprint", cleanup);
      cleanup();
    };
  }, []);

  const handlePrint = () => {
    document.body.classList.add("print-isolate");
    // Let the class apply before the print dialog snapshots the page.
    setTimeout(() => window.print(), 50);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-900 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="no-print flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h3 className="font-bold text-slate-800 dark:text-slate-100">PCC Request Letter — {app.draft_code}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl leading-none">×</button>
        </div>

        <div className="no-print p-6 border-b border-slate-200 dark:border-slate-800 grid sm:grid-cols-2 gap-x-4">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Relation">
            <Select value={relation} onChange={(e) => setRelation(e.target.value)}>
              <option>S/o.</option>
              <option>D/o.</option>
              <option>W/o.</option>
            </Select>
          </Field>
          <Field label="Vehicle Type">
            <Input value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} placeholder="e.g. E-Rickshaw" />
          </Field>
          <Field label="Police Station">
            <SearchableSelect
              value={policeStation}
              options={DELHI_POLICE_STATIONS.map((name) => ({ id: name, name }))}
              onChange={setPoliceStation}
              placeholder="Search police station…"
            />
          </Field>
          <Field label="Years Resident in Delhi">
            <Input value={residentYears} onChange={(e) => setResidentYears(e.target.value)} placeholder="e.g. 10" />
          </Field>
          {app.stay_since && (
            <p className="sm:col-span-2 -mt-2 mb-2 text-xs text-slate-400">
              Auto-calculated from "Staying at Address Since" ({isoToDDMMYYYY(app.stay_since)}) — edit above if it needs adjusting.
            </p>
          )}
          <div className="sm:col-span-2">
            <Field label="Addressed To">
              <Input as="textarea" rows={4} preserveCase value={addressee} onChange={(e) => setAddressee(e.target.value)} />
            </Field>
          </div>
          {!signatureDoc && (
            <p className="sm:col-span-2 -mt-2 text-xs text-amber-600">
              No signature on file yet — upload one under this application's Documents and it'll appear on the letter automatically.
            </p>
          )}
        </div>

        {/* This block is what actually prints — everything above is just
            the editor and gets hidden via .no-print during printing. */}
        <div className="print-target p-8 text-sm text-slate-800 leading-relaxed">
          <p className="mb-6">Dated: {isoToDDMMYYYY(date)}</p>
          <p className="mb-1">To,</p>
          {addressee.split("\n").map((line, i) => (
            <p key={i} className="mb-1">{line}</p>
          ))}
          <p className="mt-6 mb-4 font-semibold">
            Subject: Request for issuance of Police Clearance Certificate (PCC) for Vehicle Registration.
          </p>
          <p className="mb-3">Sir/Madam,</p>
          <p className="mb-3">
            I, {app.applicant_name || "____________________"} {relation} {app.father_husband_name || "____________________"}, resident of{" "}
            {app.address || "____________________"}
            {policeStation ? `, falling under the jurisdiction of ${policeStation} Police Station,` : ""} wish to apply for a Police Clearance Certificate (PCC).
          </p>
          <p className="mb-3">
            I require this Police Clearance Certificate for the purpose of Registration of my vehicle
            {vehicleType ? ` (${vehicleType})` : ""} with the Transport Department.
          </p>
          <p className="mb-3">
            I am a resident of Delhi for the past {residentYears || "____"} Years, and I have no criminal record or
            pending cases against me in any police station in Delhi or elsewhere.
          </p>
          <p className="mb-6">Kindly issue the PCC at your earliest convenience.</p>
          <p className="mb-1 font-semibold">Documents Attached:</p>
          <p className="mb-8">1. Copy of Aadhaar Card (Address Proof)</p>
          <p className="mb-1">Thanking You,</p>
          <p className="mb-1">Yours Sincerely,</p>
          {signatureDoc && (
            // mix-blend-mode: multiply drops out the signature photo's
            // white/light background against this letter's white page —
            // dark ink stays dark, white (or near-white) turns invisible.
            // No image processing needed; works for the vast majority of
            // signature photos which are shot on a plain light background.
            // If a signature was scanned on a colored/dark background this
            // won't help — re-upload it on a plain white sheet instead.
            <img
              src={signatureDoc.file_url}
              alt="Signature"
              className="h-14 my-1 object-contain"
              style={{ mixBlendMode: "multiply" }}
            />
          )}
          <p className="mb-1 font-semibold">{app.applicant_name}</p>
          <p>Phone : {app.mobile || ""}</p>
        </div>

        <div className="no-print flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800">
          <GhostButton onClick={onClose}>Close</GhostButton>
          <PrimaryButton onClick={handlePrint}>🖶 Print / Save as PDF</PrimaryButton>
        </div>
      </div>
    </div>
  );
}
