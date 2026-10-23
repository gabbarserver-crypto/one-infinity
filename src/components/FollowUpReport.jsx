import React, { useEffect, useState } from "react";
import { Card, StatusBadge } from "./UI";
import { fetchFollowUpReport } from "../lib/nextService";
import { fmtDate } from "../lib/dates";

// Every Accepted application whose service has a configured "Next Service"
// (Masters > Service > Next Service), 30+ days on from acceptance — the
// point at which the follow-up (e.g. Learner's → Driving Licence) becomes
// eligible. "Done" means a follow-up draft already exists for it; "Pending"
// means it's eligible but nobody's created that draft yet.
//
// dealerId: pass it in the Dealer Portal to scope to just that dealer;
// leave undefined for the system-wide admin/staff Reports view.
export default function FollowUpReport({ dealerId, showDealerColumn = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("All"); // All | Pending | Done

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { rows: r, error: e } = await fetchFollowUpReport(dealerId);
      setError(e ? e.message : "");
      setRows(r);
      setLoading(false);
    })();
  }, [dealerId]);

  const visible = rows.filter((r) => filter === "All" || (filter === "Done") === r.done);
  const pendingCount = rows.filter((r) => !r.done).length;

  return (
    <Card title="LL → DL Follow-ups (30+ Days)">
      <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">
        Applications whose next service (e.g. Driving Licence) is now due, 30+ days after their Learner's Licence was completed.
      </p>
      <div className="flex gap-2 mb-3">
        {["All", "Pending", "Done"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border flex items-center gap-1.5 ${
              filter === f ? "bg-slate-900 text-white border-slate-900" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700"
            }`}
          >
            {f}
            {f === "Pending" && pendingCount > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && <p className="text-rose-500 text-xs mb-2">{error}</p>}
      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Nothing here.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="m-scroll w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-500">
              <tr>
                <th className="text-left font-medium px-3 py-2">Application No.</th>
                <th className="text-left font-medium px-3 py-2">Applicant</th>
                {showDealerColumn && <th className="text-left font-medium px-3 py-2">Dealer</th>}
                <th className="text-left font-medium px-3 py-2">Service</th>
                <th className="text-left font-medium px-3 py-2">Completed</th>
                <th className="text-left font-medium px-3 py-2">Days</th>
                <th className="text-left font-medium px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.application_no || <span className="text-slate-400 dark:text-slate-500 italic">Not yet assigned</span>}</td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.applicant_name}</td>
                  {showDealerColumn && (
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.dealers?.short_name || r.dealers?.name}</td>
                  )}
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.services?.short_name || r.services?.parent_service}</td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-500">{fmtDate(r.completed_at)}</td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-500">{r.daysSince}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${r.done ? "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/30" : "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30"}`}>
                      {r.done ? "Done" : "Pending"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
