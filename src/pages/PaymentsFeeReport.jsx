// src/pages/PaymentsFeeReport.jsx
//
// The NEW "Payments" nav tab — separate from Receipts (the renamed old
// Payments.jsx, which records/verifies actual money received). This one
// is a read-only report: for every application, its Fee on one side and
// its PCC Fee on the other, next to who it's for. Nothing here is
// editable — go to Applications to change a Fee or PCC Fee; this is just
// for scanning/reconciling them at a glance.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, Input } from "../components/UI";

const money = (v) => `₹${Number(v || 0).toLocaleString("en-IN")}`;

export default function PaymentsFeeReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("applications")
        .select("id, applicant_name, application_no, draft_code, submitted_at, rto_fee, pcc_fee, pcc_no, pcc_status, dealers(name, short_name)")
        .order("submitted_at", { ascending: false })
        .limit(500);
      setRows(data || []);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.applicant_name || "").toLowerCase().includes(q) ||
      (r.application_no || "").toLowerCase().includes(q) ||
      (r.draft_code || "").toLowerCase().includes(q) ||
      (r.pcc_no || "").toLowerCase().includes(q) ||
      (r.dealers?.name || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totals = useMemo(
    () => filtered.reduce((acc, r) => ({ fee: acc.fee + Number(r.rto_fee || 0), pccFee: acc.pccFee + Number(r.pcc_fee || 0) }), { fee: 0, pccFee: 0 }),
    [filtered]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Input
          preserveCase
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search applicant, application no., PCC no., dealer…"
          className="sm:max-w-sm"
        />
        <p className="text-xs text-slate-400 dark:text-slate-500">
          Showing {filtered.length} of {rows.length} most recent applications
        </p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="m-scroll w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-500">
              <tr>
                <th className="text-left font-medium px-3 py-2">Date</th>
                <th className="text-left font-medium px-3 py-2">Applicant</th>
                <th className="text-left font-medium px-3 py-2">Application No.</th>
                <th className="text-left font-medium px-3 py-2">Dealer</th>
                <th className="text-right font-medium px-3 py-2">Fee</th>
                <th className="text-right font-medium px-3 py-2">PCC Fee</th>
                <th className="text-left font-medium px-3 py-2">PCC</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-center text-slate-400 dark:text-slate-500 py-10">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="text-center text-slate-400 dark:text-slate-500 py-10">No applications match your search</td></tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400 whitespace-nowrap">{r.submitted_at ? new Date(r.submitted_at).toLocaleDateString("en-IN") : "—"}</td>
                    <td className="px-3 py-2 font-medium text-slate-700 dark:text-slate-300">{r.applicant_name || "—"}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{r.application_no || r.draft_code || "—"}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{r.dealers?.short_name || r.dealers?.name || "—"}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300">{money(r.rto_fee)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300">{money(r.pcc_fee)}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                      {r.pcc_no ? <span>{r.pcc_no}</span> : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      {r.pcc_status && <span className="ml-1.5 text-xs">({r.pcc_status})</span>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-slate-200 dark:border-slate-700 font-bold text-slate-800 dark:text-slate-100">
                  <td className="px-3 py-2" colSpan={4}>Total</td>
                  <td className="px-3 py-2 text-right">{money(totals.fee)}</td>
                  <td className="px-3 py-2 text-right">{money(totals.pccFee)}</td>
                  <td className="px-3 py-2"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>
    </div>
  );
}
