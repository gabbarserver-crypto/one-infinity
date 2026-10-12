// src/pages/Reports.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, Input, Select, PrimaryButton } from "../components/UI";
import FollowUpReport from "../components/FollowUpReport";
import { fetchAllRows } from "../lib/fetchAll";
import { todayIST, firstOfMonthIST } from "../lib/dates";

// IST business dates -- the old toISOString().slice(0, 10) versions returned
// the last day of the PREVIOUS month for firstOfMonth(), and "yesterday" for
// today() between 00:00 and 05:30 IST (see lib/dates.js).
const firstOfMonth = firstOfMonthIST;
const today = todayIST;

function serviceLabel(s) {
  if (!s) return "";
  return s.short_name || `${s.parent_service}${s.sub_service ? ` — ${s.sub_service}` : ""}`;
}
function dealerLabel(d) {
  if (!d) return "";
  return d.short_name || d.name;
}

export default function Reports() {
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd] = useState(today());
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  // Single-service report (point 20) — pick one service, see every
  // application for it with Customer Name, Dealer, and Remark.
  const [serviceList, setServiceList] = useState([]);
  const [serviceId, setServiceId] = useState("");
  const [serviceRows, setServiceRows] = useState([]);
  const [serviceLoading, setServiceLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("services").select("id, parent_service, sub_service, short_name").order("parent_service");
      setServiceList(data || []);
    })();
  }, []);

  const runServiceReport = async () => {
    if (!serviceId) return;
    setServiceLoading(true);
    // Paged: a busy service easily has more than Supabase's 1000-row cap.
    const { data, error } = await fetchAllRows(() =>
      supabase
        .from("applications")
        .select("id, applicant_name, remarks, status, submitted_at, dealers(name, short_name)")
        .eq("service_id", serviceId)
        .order("submitted_at", { ascending: false })
        .order("id", { ascending: false })
    );
    if (error) console.error("Service report failed:", error);
    setServiceRows(data || []);
    setServiceLoading(false);
  };

  // PCC Report (point: dealer/staff asked for blank/pending/issued/rejected
  // breakdown, across EVERY service that requires PCC — not just the
  // standalone "PCC" service — so LL RIC etc. show up too).
  const [pccRows, setPccRows] = useState([]);
  const [pccLoading, setPccLoading] = useState(false);
  const [pccRan, setPccRan] = useState(false);

  const runPccReport = async () => {
    setPccLoading(true);
    // Paged: the Blank/Pending/Issued/Rejected tile counts are computed from
    // these rows, so a silent 1000-row cap would make every tile wrong.
    const { data, error } = await fetchAllRows(() =>
      supabase
        .from("applications")
        .select("id, applicant_name, pcc_no, pcc_status, submitted_at, dealers(name, short_name), services!inner(parent_service, short_name, pcc_required)")
        .eq("services.pcc_required", true)
        .order("submitted_at", { ascending: false })
        .order("id", { ascending: false })
    );
    if (error) console.error("PCC report failed:", error);
    setPccRows(data || []);
    setPccRan(true);
    setPccLoading(false);
  };

  const pccBucket = (r) => {
    if (!r.pcc_no && !r.pcc_status) return "Blank";
    if (r.pcc_status === "Certificate Issued") return "Issued";
    if (r.pcc_status === "Rejected") return "Rejected";
    return "Pending"; // Under Verification, Police Case, or has pcc_no but no status yet
  };
  const pccCounts = pccRows.reduce(
    (acc, r) => { acc[pccBucket(r)] = (acc[pccBucket(r)] || 0) + 1; return acc; },
    { Blank: 0, Pending: 0, Issued: 0, Rejected: 0 }
  );
  const PCC_TILE_STYLES = {
    Blank: "bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700",
    Pending: "bg-yellow-50 dark:bg-yellow-950/40 text-yellow-800 dark:text-yellow-300 border-yellow-300 dark:border-yellow-800",
    Issued: "bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300 border-green-300 dark:border-green-800",
    Rejected: "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800",
  };


  const run = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("get_profit_summary", { p_start: start, p_end: end });
    setLoading(false);
    if (!error && data?.[0]) setSummary(data[0]);
  };

  const rows = summary
    ? [
        { label: "Total Collection", value: summary.total_collection, color: "text-slate-800 dark:text-slate-100" },
        { label: "Government Fee Paid", value: -summary.govt_fee_paid, color: "text-rose-600" },
        { label: "Agency Paid", value: -summary.agency_paid, color: "text-rose-600" },
        { label: "Expenses", value: -summary.total_expenses, color: "text-rose-600" },
        { label: "Net Profit", value: summary.net_profit, color: "text-emerald-600", bold: true },
      ]
    : [];

  return (
    <div>
      <div className="mb-5">
        <FollowUpReport showDealerColumn />
      </div>

      <Card title="Service Report" className="mb-5">
        <div className="grid sm:grid-cols-3 gap-4 items-end">
          <Field label="Service">
            <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">Select a service</option>
              {serviceList.map((s) => <option key={s.id} value={s.id}>{serviceLabel(s)}</option>)}
            </Select>
          </Field>
          <PrimaryButton onClick={runServiceReport} disabled={!serviceId || serviceLoading} className="mb-4">
            {serviceLoading ? "Loading..." : "Run Report"}
          </PrimaryButton>
        </div>

        {serviceRows.length > 0 && (
          <div className="mt-4 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
            <table className="m-scroll w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Customer Name</th>
                  <th className="text-left font-medium px-3 py-2">Dealer</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Remark</th>
                </tr>
              </thead>
              <tbody>
                {serviceRows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{r.applicant_name}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{dealerLabel(r.dealers)}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.status}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{r.remarks || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {serviceId && !serviceLoading && serviceRows.length === 0 && (
          <p className="text-sm text-slate-400 mt-3">No applications yet for this service.</p>
        )}
      </Card>

      <Card title="PCC Report" className="mb-5">
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
          Covers every service that requires a PCC step (e.g. LL RIC and the standalone PCC service together) — not just one service.
        </p>
        <PrimaryButton onClick={runPccReport} disabled={pccLoading}>
          {pccLoading ? "Loading..." : "Run PCC Report"}
        </PrimaryButton>

        {pccRan && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
              {["Blank", "Pending", "Issued", "Rejected"].map((label) => (
                <div key={label} className={`rounded-xl border px-4 py-3 text-center ${PCC_TILE_STYLES[label]}`}>
                  <p className="text-2xl font-bold">{pccCounts[label]}</p>
                  <p className="text-xs font-semibold uppercase tracking-wide">{label}</p>
                </div>
              ))}
            </div>

            {pccRows.length > 0 ? (
              <div className="mt-4 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
                <table className="m-scroll w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">Applicant</th>
                      <th className="text-left font-medium px-3 py-2">Dealer</th>
                      <th className="text-left font-medium px-3 py-2">Service</th>
                      <th className="text-left font-medium px-3 py-2">PCC No</th>
                      <th className="text-left font-medium px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pccRows.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{r.applicant_name}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{dealerLabel(r.dealers)}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{serviceLabel(r.services)}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.pcc_no || "—"}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.pcc_status || (r.pcc_no ? "—" : "Blank")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-400 mt-3">No PCC-required applications found.</p>
            )}
          </>
        )}
      </Card>

      <Card title="Profit Report" className="mb-5">
        <div className="grid sm:grid-cols-3 gap-4 items-end">
          <Field label="From">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <PrimaryButton onClick={run} disabled={loading} className="mb-4">
            {loading ? "Loading..." : "Run Report"}
          </PrimaryButton>
        </div>
      </Card>

      {summary && (
        <Card title={`Summary: ${start} to ${end}`}>
          {rows.map((r) => (
            <div key={r.label} className={`flex justify-between py-2.5 ${r.bold ? "border-t border-slate-200 dark:border-slate-800 mt-2 pt-3" : "border-b border-slate-100 dark:border-slate-800"}`}>
              <span className={`text-sm ${r.bold ? "font-bold text-slate-800 dark:text-slate-100" : "text-slate-600 dark:text-slate-300"}`}>{r.label}</span>
              <span className={`text-sm font-semibold ${r.color}`}>
                {r.value < 0 ? "-" : ""}₹{Math.abs(Number(r.value)).toLocaleString("en-IN")}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
