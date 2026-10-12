// src/pages/Settings.jsx
import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { Card, Select, Toast } from "../components/UI";
import NotificationSettings from "../components/NotificationSettings";

const RIGHTS = ["can_view", "can_add", "can_edit", "can_delete", "can_approve", "can_print", "can_export"];
const RIGHT_LABELS = { can_view: "View", can_add: "Add", can_edit: "Edit", can_delete: "Delete", can_approve: "Approve", can_print: "Print", can_export: "Export" };

const TABS = [
  { key: "permissions", label: "Permissions" },
  { key: "notifications", label: "Notifications" },
];

function PermissionsTab() {
  const [roles, setRoles] = useState([]);
  const [roleId, setRoleId] = useState("");
  const [rows, setRows] = useState([]);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    const { data: r } = await supabase.from("roles").select("*").order("id");
    setRoles(r || []);
    if (r?.length && !roleId) setRoleId(r[0].id);
  }, [roleId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      if (!roleId) return;
      const { data } = await supabase.from("permissions").select("*").eq("role_id", roleId).order("module");
      setRows(data || []);
    })();
  }, [roleId]);

  const toggleRight = async (row, right) => {
    const updated = { ...row, [right]: !row[right] };
    setRows((rs) => rs.map((r) => (r.id === row.id ? updated : r)));
    const { error } = await supabase.from("permissions").update({ [right]: updated[right] }).eq("id", row.id);
    if (error) setToast("Failed to save: " + error.message);
  };

  return (
    <div>
      <p className="text-sm text-slate-400 dark:text-slate-500 mb-5">Control what each role can see and do across the ERP</p>

      <Card className="mb-5">
        <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Role</label>
        <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.role_name}</option>)}
        </Select>
      </Card>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl dark:bg-slate-900 dark:border-slate-800 overflow-x-auto">
        <table className="m-scroll w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
            <tr>
              <th className="text-left font-medium px-4 py-3">Module</th>
              {RIGHTS.map((r) => <th key={r} className="text-center font-medium px-3 py-3">{RIGHT_LABELS[r]}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-3 font-medium text-slate-700 dark:text-slate-300 capitalize">{row.module}</td>
                {RIGHTS.map((right) => (
                  <td key={right} className="text-center px-3 py-3">
                    <input
                      type="checkbox"
                      checked={!!row[right]}
                      onChange={() => toggleRight(row, right)}
                      className="w-4 h-4 accent-blue-600"
                    />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={RIGHTS.length + 1} className="text-center text-slate-400 dark:text-slate-500 py-8">No permission rows for this role yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

export default function Settings() {
  const [tab, setTab] = useState("permissions");

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-1">Settings</h2>

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "permissions" ? <PermissionsTab /> : <NotificationSettings />}
    </div>
  );
}
