// src/pages/Masters.jsx
import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, Input, Select, PrimaryButton, GhostButton, Modal, Toast } from "../components/UI";
import ApplicationChatModal from "../components/ApplicationChatModal";
import { identityFor } from "../lib/chat";
import { Phone, MessageCircle } from "lucide-react";
import { createDealerLogin, createDealerStaffLogin } from "../lib/serverApi";

const TABS = ["RTO", "Staff", "Service", "Dealer", "Agency"];

export default function Masters({ call, staff }) {
  const [tab, setTab] = useState("RTO");
  const [toast, setToast] = useState(null);

  const notify = (msg) => setToast(msg);

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4">Masters</h2>
      <div className="flex gap-2 mb-5 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold border ${
              tab === t ? "bg-slate-900 text-white border-slate-900" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "RTO" && <RTOMaster notify={notify} />}
      {tab === "Staff" && <StaffMaster notify={notify} call={call} myStaffId={staff?.id} />}
      {tab === "Service" && <ServiceMaster notify={notify} />}
      {tab === "Dealer" && <DealerMaster notify={notify} call={call} />}
      {tab === "Agency" && <AgencyMaster notify={notify} />}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/* ---------------- Generic list table ---------------- */
function ListTable({ rows, columns, onEdit, onAdd, addLabel }) {
  const [q, setQ] = useState("");
  const filteredRows = q.trim()
    ? rows.filter((r) =>
        Object.values(r)
          .filter((v) => typeof v === "string" || typeof v === "number")
          .join(" ")
          .toLowerCase()
          .includes(q.trim().toLowerCase())
      )
    : rows;

  return (
    <div>
      <div className="flex justify-between items-center gap-3 mb-3">
        <div className="relative flex-1 max-w-xs">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-sm">🔍</span>
        </div>
        <PrimaryButton onClick={onAdd}>{addLabel}</PrimaryButton>
      </div>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl dark:bg-slate-900 dark:border-slate-800 overflow-x-auto">
        <table className="m-scroll w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-500">
            <tr>
              {columns.map((c) => <th key={c.key} className="text-left font-medium px-3 py-2">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                {columns.map((c, i) => {
                  const content = c.render ? c.render(r) : r[c.key];
                  return (
                    <td key={c.key} className="px-3 py-2 text-slate-700 dark:text-slate-300">
                      {i === 0 ? (
                        <button
                          type="button"
                          onClick={() => onEdit(r)}
                          title="Click to edit"
                          className="text-left font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {content || "—"}
                        </button>
                      ) : content}
                    </td>
                  );
                })}
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length} className="text-center text-slate-400 dark:text-slate-500 py-8">{q ? "No matches" : "No records yet"}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Update + Delete buttons shown at the bottom of every form ---------------- */
function FormActions({ isEdit, label, onSave, onDelete }) {
  return (
    <div className="flex items-center gap-3">
      <PrimaryButton onClick={onSave}>{isEdit ? `Update ${label}` : `Save ${label}`}</PrimaryButton>
      {isEdit && onDelete && (
        <GhostButton onClick={onDelete} className="!text-rose-500">Delete</GhostButton>
      )}
    </div>
  );
}

/* ---------------- RTO Master ---------------- */
function RTOMaster({ notify }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("rtos").select("*").order("name");
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (form) => {
    const payload = { name: form.name, code: form.code, type: form.type, address: form.address, phone: form.phone, slot_booking: form.slot_booking, status: form.status };
    const { error } = editing
      ? await supabase.from("rtos").update(payload).eq("id", editing.id)
      : await supabase.from("rtos").insert(payload);
    if (error) { notify("Failed: " + error.message); return; }
    notify("RTO saved");
    setOpen(false); setEditing(null); load();
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.name}?`)) return;
    const { error } = await supabase.from("rtos").delete().eq("id", row.id);
    if (error) { notify("Couldn't delete: " + error.message); return; }
    notify("Deleted");
    setOpen(false); setEditing(null); load();
  };

  return (
    <>
      <ListTable
        rows={rows}
        columns={[
          { key: "name", label: "RTO Name" }, { key: "code", label: "Code" },
          { key: "type", label: "Type" }, { key: "status", label: "Status" },
        ]}
        onAdd={() => { setEditing(null); setOpen(true); }}
        onEdit={(r) => { setEditing(r); setOpen(true); }}
        addLabel="Add RTO"
      />
      {open && <RTOForm initial={editing} onSave={save} onDelete={editing ? () => remove(editing) : undefined} onClose={() => setOpen(false)} />}
    </>
  );
}

function RTOForm({ initial, onSave, onDelete, onClose }) {
  const [f, setF] = useState(initial || { name: "", code: "", type: "RTO Office", address: "", phone: "", slot_booking: true, status: "Active" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Modal title={initial ? "Edit RTO" : "Create New RTO"} onClose={onClose}>
      <Field label="RTO Name" required><Input value={f.name} onChange={set("name")} /></Field>
      <Field label="RTO Code" required><Input value={f.code} onChange={set("code")} /></Field>
      <Field label="Type">
        <Select value={f.type} onChange={set("type")}>
          <option>RTO Office</option><option>Track / Test Center</option><option>Sub-Regional Office</option>
        </Select>
      </Field>
      <Field label="Address"><Input value={f.address} onChange={set("address")} /></Field>
      <Field label="Phone"><Input value={f.phone} onChange={set("phone")} /></Field>
      <Field label="Status">
        <Select value={f.status} onChange={set("status")}><option>Active</option><option>Inactive</option></Select>
      </Field>
      <FormActions isEdit={!!initial} label="RTO" onSave={() => onSave(f)} onDelete={onDelete} />
    </Modal>
  );
}

/* ---------------- Staff Master ---------------- */
function StaffMaster({ notify, call, myStaffId }) {
  const [rows, setRows] = useState([]);
  const [roles, setRoles] = useState([]);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("staff").select("*, roles(role_name)").order("full_name");
    setRows(data || []);
    const { data: r } = await supabase.from("roles").select("*");
    setRoles(r || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (form) => {
    const payload = {
      full_name: form.full_name, role: form.role, role_id: form.role_id || null, mobile: form.mobile,
      email: form.email, joining_date: form.joining_date || null, username: form.username,
      grant_app_access: form.grant_app_access, allow_ledger_view: form.allow_ledger_view,
    };
    const { error } = editing
      ? await supabase.from("staff").update(payload).eq("id", editing.id)
      : await supabase.from("staff").insert(payload);
    if (error) { notify("Failed: " + error.message); return; }
    notify("Staff saved — link their login separately once they've signed up");
    setOpen(false); setEditing(null); load();
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.full_name}?`)) return;
    const { error } = await supabase.from("staff").delete().eq("id", row.id);
    if (error) { notify("Couldn't delete: " + error.message); return; }
    notify("Deleted");
    setOpen(false); setEditing(null); load();
  };

  return (
    <>
      <ListTable
        rows={rows}
        columns={[
          { key: "full_name", label: "Name" }, { key: "role", label: "Designation" },
          { key: "roles", label: "Permission Role", render: (r) => r.roles?.role_name || "—" },
          { key: "mobile", label: "Mobile" }, { key: "username", label: "Username" },
          { key: "call", label: "Call", render: (r) => {
            const isSelf = myStaffId && r.id === myStaffId;
            return (
              <button
                onClick={() => call?.startCall({ type: "staff", id: r.id, name: r.full_name }, "audio")}
                disabled={!call || call.status !== "idle" || isSelf}
                title={isSelf ? "That's you" : `Call ${r.full_name}`}
                className="w-8 h-8 rounded-full flex items-center justify-center text-emerald-600 hover:bg-emerald-50 disabled:opacity-30"
              >
                <Phone size={16} />
              </button>
            );
          } },
        ]}
        onAdd={() => { setEditing(null); setOpen(true); }}
        onEdit={(r) => { setEditing(r); setOpen(true); }}
        addLabel="Add Staff"
      />
      {open && <StaffForm initial={editing} roles={roles} onSave={save} onDelete={editing ? () => remove(editing) : undefined} onClose={() => setOpen(false)} />}
    </>
  );
}

function StaffForm({ initial, roles, onSave, onDelete, onClose }) {
  const [f, setF] = useState(initial || {
    full_name: "", role: "", role_id: "", mobile: "", email: "", joining_date: "",
    username: "", grant_app_access: true, allow_ledger_view: true,
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const [linkEmail, setLinkEmail] = useState("");

  const linkAccount = async () => {
    if (!initial?.id || !linkEmail) return;
    const { error } = await supabase.rpc("link_staff_account", { p_staff_id: initial.id, p_email: linkEmail });
    alert(error ? "Failed: " + error.message : "Account linked");
  };

  return (
    <Modal title={initial ? "Edit Staff" : "Create New Staff"} onClose={onClose}>
      <Field label="Full Name" required><Input value={f.full_name} onChange={set("full_name")} /></Field>
      <Field label="Designation"><Input value={f.role} onChange={set("role")} placeholder="e.g. Manager" /></Field>
      <Field label="Permission Role">
        <Select value={f.role_id} onChange={set("role_id")}>
          <option value="">— None —</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.role_name}</option>)}
        </Select>
      </Field>
      <Field label="Mobile"><Input value={f.mobile} onChange={set("mobile")} /></Field>
      <Field label="Email"><Input type="email" value={f.email} onChange={set("email")} /></Field>
      <Field label="Joining Date"><Input type="date" value={f.joining_date || ""} onChange={set("joining_date")} /></Field>
      <Field label="Username"><Input value={f.username} onChange={set("username")} /></Field>
      <FormActions isEdit={!!initial} label="Staff" onSave={() => onSave(f)} onDelete={onDelete} />

      {initial && (
        <div className="mt-5 pt-4 border-t border-slate-200 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-500 mb-2">
            Link this profile to a Supabase Auth login (they must have signed up first, e.g. via a Dashboard invite).
          </p>
          <div className="flex gap-2">
            <Input placeholder="their-login@email.com" value={linkEmail} onChange={(e) => setLinkEmail(e.target.value)} />
            <GhostButton onClick={linkAccount}>Link</GhostButton>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Service Master ---------------- */
function ServiceMaster({ notify }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("services").select("*").order("parent_service");
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (form, documents) => {
    if (!form.parent_service?.trim()) { notify("Name is required"); return; }
    if (!form.short_name?.trim()) { notify("Short Name is required"); return; }
    const payload = {
      parent_service: form.parent_service.trim(), short_name: form.short_name.trim(),
      pcc_required: form.pcc_required, slot_booking_required: form.slot_booking_required,
      rto_required: form.rto_required, agency_required: form.agency_required,
      application_no_required: form.application_no_required, ll_dl_no_required: form.ll_dl_no_required,
      previous_ll_required: form.previous_ll_required,
      otp_required: form.otp_required, chat_in_app: form.chat_in_app,
      age_limit_required: !!form.age_limit_required,
      min_age: form.age_limit_required ? (parseInt(form.min_age, 10) || null) : null,
      next_service_id: form.next_service_id || null,
      next_service_wait_days: parseInt(form.next_service_wait_days, 10) || 30,
    };
    let serviceId = editing?.id;
    if (editing) {
      const { error } = await supabase.from("services").update(payload).eq("id", editing.id);
      if (error) { notify("Failed: " + error.message); return; }
    } else {
      const { data, error } = await supabase.from("services").insert(payload).select().single();
      if (error) { notify("Failed: " + error.message); return; }
      serviceId = data.id;
    }

    const { error: docsDeleteError } = await supabase.from("service_documents").delete().eq("service_id", serviceId);
    if (docsDeleteError) { notify("Service saved, but couldn't clear old documents: " + docsDeleteError.message); }
    if (documents.length) {
      const { error: docsInsertError } = await supabase.from("service_documents").insert(documents.map((d) => ({ service_id: serviceId, name: d.name, mandatory: d.mandatory, post_approval: !!d.post_approval })));
      if (docsInsertError) { notify("Service saved, but Required Documents failed to save: " + docsInsertError.message); return; }
    }

    notify("Service saved");
    setOpen(false); setEditing(null); load();
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.parent_service}?`)) return;
    const { error } = await supabase.from("services").delete().eq("id", row.id);
    if (error) { notify("Couldn't delete: " + error.message); return; }
    notify("Deleted");
    setOpen(false); setEditing(null); load();
  };

  return (
    <>
      <ListTable
        rows={rows}
        columns={[
          { key: "parent_service", label: "Name" },
          { key: "short_name", label: "Short Name" },
        ]}
        onAdd={() => { setEditing(null); setOpen(true); }}
        onEdit={(r) => { setEditing(r); setOpen(true); }}
        addLabel="Add Service"
      />
      {open && <ServiceForm initial={editing} allServices={rows} onSave={save} onDelete={editing ? () => remove(editing) : undefined} onClose={() => setOpen(false)} />}
    </>
  );
}

function ServiceForm({ initial, allServices = [], onSave, onDelete, onClose }) {
  const [f, setF] = useState(initial || {
    parent_service: "", short_name: "", pcc_required: true, slot_booking_required: true,
    rto_required: false, agency_required: false, previous_ll_required: false, otp_required: false, chat_in_app: false,
    age_limit_required: false, min_age: "",
    application_no_required: true, ll_dl_no_required: true,
    next_service_id: "", next_service_wait_days: 30,
  });
  const [documents, setDocuments] = useState(
    initial ? [] : [{ name: "Aadhaar Card", mandatory: true }, { name: "Photo", mandatory: true }, { name: "Signature", mandatory: true }]
  );
  const [newDoc, setNewDoc] = useState("");
  const [loadError, setLoadError] = useState("");
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const toggle = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.checked }));
  const setBool = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value === "true" }));

  useEffect(() => {
    if (initial?.id) {
      (async () => {
        const { data: docs, error: docsError } = await supabase.from("service_documents").select("*").eq("service_id", initial.id);
        if (docsError) {
          // Surface this instead of silently keeping whatever was in state —
          // a failed fetch is not the same thing as "this service has no
          // required documents".
          setLoadError("Couldn't load this service's required documents: " + docsError.message);
        } else {
          setDocuments((docs || []).map((d) => ({ name: d.name, mandatory: d.mandatory, post_approval: d.post_approval })));
        }
      })();
    }
  }, [initial]);

  return (
    <Modal title={initial ? "Edit Service" : "Create New Service"} onClose={onClose} wide>
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <Card title="Basic Information" className="mb-4">
            <Field label="Name" required><Input value={f.parent_service} onChange={set("parent_service")} /></Field>
            <Field label="Short Name" required><Input value={f.short_name} onChange={set("short_name")} /></Field>
          </Card>

          <Card title="Workflow Rules" className="mb-4">
            {[["previous_ll_required","Previous LL Required"],["otp_required","OTP Verification"],["chat_in_app","Chat in Application"]].map(([k,label]) => (
              <label key={k} className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-300 py-1">
                {label}<input type="checkbox" checked={f[k]} onChange={toggle(k)} className="w-4 h-4 accent-blue-600" />
              </label>
            ))}
            <Field label="Next Service">
              <Select value={f.next_service_id || ""} onChange={set("next_service_id")}>
                <option value="">None</option>
                {allServices.filter((s) => s.id !== initial?.id).map((s) => (
                  <option key={s.id} value={s.id}>{s.parent_service}{s.short_name ? ` (${s.short_name})` : ""}</option>
                ))}
              </Select>
            </Field>
            {f.next_service_id && (
              <Field label="Wait Before Reminder (days)">
                <Input type="number" min="0" value={f.next_service_wait_days} onChange={set("next_service_wait_days")} />
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Once an application for this service is Accepted for {f.next_service_wait_days || 0}+ day
                  {String(f.next_service_wait_days) === "1" ? "" : "s"}, dealers get a "Book Appointment" option that
                  creates a draft for the Next Service above instead — e.g. Learner's Licence → Driving Licence (30
                  days), or Insurance → Fitness (1 day).
                </p>
              </Field>
            )}
          </Card>
        </div>

        <div>
          <Card title="Service Requirements" className="mb-4">
            {[["pcc_required", "PCC No"], ["rto_required", "RTO"], ["agency_required", "Agency"], ["slot_booking_required", "Slot"], ["age_limit_required", "Age Limitation"], ["application_no_required", "Application No"], ["ll_dl_no_required", "LL/DL No"]].map(([k, label]) => (
              <Field key={k} label={label}>
                <Select value={String(!!f[k])} onChange={setBool(k)}>
                  <option value="false">Not Required</option>
                  <option value="true">Required</option>
                </Select>
              </Field>
            ))}
            {f.age_limit_required && (
              <Field label="Minimum Age">
                <Input type="number" min="0" value={f.min_age} onChange={set("min_age")} placeholder="e.g. 18" />
              </Field>
            )}
          </Card>

          <Card title="Required Documents" className="mb-4">
            {loadError && <p className="text-rose-500 text-xs mb-2">{loadError}</p>}
            {documents.map((d, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                <span className="text-slate-700 dark:text-slate-300">{d.name}</span>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-500">
                    <input
                      type="checkbox"
                      checked={!!d.mandatory}
                      onChange={(e) => {
                        const updated = [...documents];
                        updated[i] = { ...updated[i], mandatory: e.target.checked };
                        setDocuments(updated);
                      }}
                      className="w-3.5 h-3.5 accent-blue-600"
                    />
                    Mandatory
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-500" title="Only shows up as required once the application is Accepted — e.g. a PCC Certificate or Learner Licence that only exists after approval">
                    <input
                      type="checkbox"
                      checked={!!d.post_approval}
                      onChange={(e) => {
                        const updated = [...documents];
                        updated[i] = { ...updated[i], post_approval: e.target.checked };
                        setDocuments(updated);
                      }}
                      className="w-3.5 h-3.5 accent-amber-600"
                    />
                    Only after approval
                  </label>
                  <button onClick={() => setDocuments(documents.filter((_, idx) => idx !== i))} className="text-rose-500 text-xs">Remove</button>
                </div>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <Input value={newDoc} onChange={(e) => setNewDoc(e.target.value)} placeholder="Document name" />
              <GhostButton onClick={() => { if (newDoc.trim()) { setDocuments([...documents, { name: newDoc.trim(), mandatory: true, post_approval: false }]); setNewDoc(""); } }}>Add</GhostButton>
            </div>
          </Card>
        </div>
      </div>
      <div className="mt-5">
        <FormActions isEdit={!!initial} label="Service" onSave={() => onSave(f, documents)} onDelete={onDelete} />
      </div>
    </Modal>
  );
}

/* ---------------- Dealer Master ---------------- */
function DealerMaster({ notify, call }) {
  const [rows, setRows] = useState([]);
  const [summaryByDealer, setSummaryByDealer] = useState({}); // dealer_id -> available_limit
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [staffIdentity, setStaffIdentity] = useState(null);
  const [chatDealer, setChatDealer] = useState(null); // { id, name } | null

  const load = useCallback(async () => {
    const { data } = await supabase.from("dealers").select("*").order("name");
    setRows(data || []);
    // Best-effort — if the summary view isn't reachable for some reason, the
    // Status column just falls back to blank rather than breaking the list.
    const { data: summaries } = await supabase.from("dealer_ledger_summary").select("dealer_id, credit_limit, running_balance");
    setSummaryByDealer(Object.fromEntries((summaries || []).map((s) => [s.dealer_id, Number(s.credit_limit || 0) + Number(s.running_balance || 0)])));
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      const { data: staffRow } = await supabase.from("staff").select("id, full_name").eq("auth_user_id", userData?.user?.id).maybeSingle();
      if (staffRow) setStaffIdentity(identityFor({ staff: staffRow }));
    })();
  }, []);

  const save = async (form) => {
    const payload = {
      name: form.name, code: form.code, short_name: form.short_name || null, contact_name: form.contact_name, mobile: form.mobile, email: form.email,
      address: form.address, city: form.city, state: form.state, pincode: form.pincode,
      credit_limit: parseFloat(form.credit_limit) || 0,
      opening_balance: parseFloat(form.opening_balance) || 0,
      visible_from_year: form.visible_from_year === "" || form.visible_from_year == null ? null : parseInt(form.visible_from_year, 10),
    };
    const { error } = editing
      ? await supabase.from("dealers").update(payload).eq("id", editing.id)
      : await supabase.from("dealers").insert(payload);
    if (error) { notify("Failed: " + error.message); return; }
    notify("Dealer saved");
    setOpen(false); setEditing(null); load();
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.name}?`)) return;
    const { error } = await supabase.from("dealers").delete().eq("id", row.id);
    if (error) { notify("Couldn't delete: " + error.message); return; }
    notify("Deleted");
    setOpen(false); setEditing(null); load();
  };

  return (
    <>
      <ListTable
        rows={rows}
        columns={[
          { key: "name", label: "Dealer Name" }, { key: "short_name", label: "Short Name", render: (r) => r.short_name || "—" }, { key: "code", label: "Code" }, { key: "contact_name", label: "Contact" },
          { key: "mobile", label: "Mobile", render: (r) => r.mobile ? (
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span>{r.mobile}</span>
              <a href={`tel:${r.mobile}`} title="Call" className="text-slate-400 hover:text-blue-600">
                <Phone size={14} />
              </a>
              <a
                href={`https://wa.me/${r.mobile.replace(/\D/g, "")}`}
                target="_blank"
                rel="noreferrer"
                title="WhatsApp"
                className="text-slate-400 hover:text-emerald-600"
              >
                <MessageCircle size={14} />
              </a>
            </div>
          ) : <span className="text-slate-300 text-xs">—</span> },
          { key: "credit_limit", label: "Credit Limit", render: (r) => `₹${Number(r.credit_limit||0).toLocaleString("en-IN")}` },
          { key: "status", label: "Status", render: (r) => {
            const avail = summaryByDealer[r.id];
            if (avail === undefined) return <span className="text-slate-300 text-xs">—</span>;
            const onHold = avail <= 0;
            return (
              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${
                onHold ? "bg-rose-50 text-rose-600 border-rose-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"
              }`}>
                {onHold ? "On Hold" : "Active"}
              </span>
            );
          } },
          { key: "chat", label: "Chat", render: (r) => (
            <GhostButton onClick={() => setChatDealer({ id: r.id, name: r.short_name || r.name })}>Chat</GhostButton>
          ) },
          { key: "call", label: "Call", render: (r) => (
            <button
              onClick={() => call?.startCall({ type: "dealer", id: r.id, name: r.short_name || r.name }, "audio")}
              disabled={!call || call.status !== "idle"}
              title={`Call ${r.short_name || r.name}`}
              className="w-8 h-8 rounded-full flex items-center justify-center text-emerald-600 hover:bg-emerald-50 disabled:opacity-30"
            >
              <Phone size={16} />
            </button>
          ) },
        ]}
        onAdd={() => { setEditing(null); setOpen(true); }}
        onEdit={(r) => { setEditing(r); setOpen(true); }}
        addLabel="Add Dealer"
      />
      {open && <DealerForm initial={editing} onSave={save} onDelete={editing ? () => remove(editing) : undefined} onClose={() => setOpen(false)} call={call} />}
      {chatDealer && (
        <ApplicationChatModal
          dealerId={chatDealer.id}
          applicationId={null}
          applicationLabel={`General chat — ${chatDealer.name}`}
          identity={staffIdentity}
          onClose={() => setChatDealer(null)}
        />
      )}
    </>
  );
}

export function DealerForm({ initial, onSave, onDelete, onClose, call }) {
  const [f, setF] = useState(initial || { name: "", code: "", short_name: "", contact_name: "", mobile: "", email: "", address: "", city: "", state: "", pincode: "", credit_limit: "", opening_balance: "", visible_from_year: "" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const thisYear = new Date().getFullYear();
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [creatingLogin, setCreatingLogin] = useState(false);
  const [loginMsg, setLoginMsg] = useState("");

  const createLogin = async () => {
    if (!initial?.id || !loginEmail || !loginPassword) return;
    setCreatingLogin(true);
    setLoginMsg("");
    try {
      await createDealerLogin({ dealerId: initial.id, email: loginEmail, password: loginPassword });
      setLoginMsg("Login created — the dealer can sign in with this email and password now.");
      setLoginEmail(""); setLoginPassword("");
    } catch (e) {
      setLoginMsg("Failed: " + e.message);
    } finally {
      setCreatingLogin(false);
    }
  };

  return (
    <Modal title={initial ? "Edit Dealer" : "Create New Dealer"} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Dealer Name" required><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="Dealer Code" required><Input value={f.code} onChange={set("code")} /></Field>
        <Field label="Short Name"><Input value={f.short_name} onChange={set("short_name")} placeholder="Shown in Applications list" /></Field>
        <Field label="Contact Name"><Input value={f.contact_name} onChange={set("contact_name")} /></Field>
        <Field label="Mobile"><Input value={f.mobile} onChange={set("mobile")} /></Field>
      </div>
      <Field label="Email"><Input type="email" value={f.email} onChange={set("email")} /></Field>
      <Field label="Address"><Input value={f.address} onChange={set("address")} /></Field>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Input value={f.city} onChange={set("city")} placeholder="City" />
        <Input value={f.state} onChange={set("state")} placeholder="State" />
        <Input value={f.pincode} onChange={set("pincode")} placeholder="Pincode" />
      </div>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Credit Limit (₹)"><Input type="number" value={f.credit_limit} onChange={set("credit_limit")} /></Field>
        <Field label="Opening Balance (₹)"><Input type="number" value={f.opening_balance} onChange={set("opening_balance")} /></Field>
      </div>
      <Field label="Data visible to dealer">
        <Select value={f.visible_from_year ?? ""} onChange={set("visible_from_year")}>
          <option value="">Current year only ({thisYear})</option>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={thisYear - n}>From {thisYear - n} onwards</option>
          ))}
          <option value="0">All time (full history)</option>
        </Select>
      </Field>
      <FormActions isEdit={!!initial} label="Dealer" onSave={() => onSave(f)} onDelete={onDelete} />

      {initial && (
        <div className="mt-5 pt-4 border-t border-slate-200 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-500 mb-2">
            Create this dealer's portal login — set an email and password directly,
            no self-signup needed. Re-running this replaces their password.
          </p>
          <div className="grid sm:grid-cols-2 gap-2 mb-2">
            <Input type="email" placeholder="dealer-login@email.com" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} />
            <Input type="password" placeholder="Set a password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} />
          </div>
          <GhostButton onClick={createLogin} disabled={creatingLogin || !loginEmail || !loginPassword}>
            {creatingLogin ? "Creating…" : "Create Login"}
          </GhostButton>
          {loginMsg && <p className={`text-xs mt-2 ${loginMsg.startsWith("Failed") ? "text-rose-500" : "text-emerald-600"}`}>{loginMsg}</p>}
        </div>
      )}

      {initial && <DealerStaffManager dealerId={initial.id} call={call} />}
    </Modal>
  );
}

// Sub-staff logins under this dealer (see dealer_staff table) — addable from
// both here (admin) and the dealer's own portal (Masters isn't reachable by
// dealers, so DealerPortal has its own copy of this manager).
function DealerStaffManager({ dealerId, call }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [f, setF] = useState({ fullName: "", email: "", password: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("dealer_staff").select("*").eq("dealer_id", dealerId).order("full_name");
    setRows(data || []);
    setLoading(false);
  }, [dealerId]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!f.fullName || !f.email || !f.password) return;
    setSaving(true);
    setMsg("");
    try {
      await createDealerStaffLogin({ dealerId, fullName: f.fullName, email: f.email, password: f.password });
      setF({ fullName: "", email: "", password: "" });
      setShowAdd(false);
      load();
    } catch (e) {
      setMsg("Failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (row) => {
    await supabase.from("dealer_staff").update({ active: !row.active }).eq("id", row.id);
    load();
  };

  return (
    <div className="mt-5 pt-4 border-t border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-500 uppercase">Dealer Staff</p>
        <button onClick={() => setShowAdd((s) => !s)} className="text-xs font-semibold text-blue-600 hover:underline">
          {showAdd ? "Cancel" : "+ Add Staff"}
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">No sub-staff added yet.</p>
      ) : (
        <div className="space-y-1.5 mb-2">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-1.5">
              <div>
                <span className="font-medium text-slate-700 dark:text-slate-300">{r.full_name}</span>
                <span className="text-slate-400 dark:text-slate-500 text-xs ml-2">{r.email}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => call?.startCall({ type: "dealer_staff", id: r.id, name: r.full_name }, "audio")}
                  disabled={!call || call.status !== "idle" || !r.active}
                  title={r.active ? `Call ${r.full_name}` : "Disabled — can't be called"}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-emerald-600 hover:bg-emerald-50 disabled:opacity-30"
                >
                  <Phone size={14} />
                </button>
                <button
                  onClick={() => toggleActive(r)}
                  className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                    r.active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-800"
                  }`}
                >
                  {r.active ? "Active" : "Disabled"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3 mt-2">
          <div className="grid sm:grid-cols-3 gap-2 mb-2">
            <Input placeholder="Full name" value={f.fullName} onChange={(e) => setF((s) => ({ ...s, fullName: e.target.value }))} />
            <Input type="email" placeholder="Email" value={f.email} onChange={(e) => setF((s) => ({ ...s, email: e.target.value }))} />
            <Input type="password" placeholder="Password" value={f.password} onChange={(e) => setF((s) => ({ ...s, password: e.target.value }))} />
          </div>
          <GhostButton onClick={add} disabled={saving}>{saving ? "Creating…" : "Create Staff Login"}</GhostButton>
          {msg && <p className="text-xs text-rose-500 mt-2">{msg}</p>}
        </div>
      )}
    </div>
  );
}

/* ---------------- Agency Master ---------------- */
function AgencyMaster({ notify }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("agencies").select("*").order("name");
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (form) => {
    const payload = {
      name: form.name, code: form.code, contact_person: form.contact_person, mobile: form.mobile, status: form.status,
      opening_balance: parseFloat(form.opening_balance) || 0, default_processing_charges: parseFloat(form.default_processing_charges) || 0,
      payment_terms: form.payment_terms,
    };
    const { error } = editing
      ? await supabase.from("agencies").update(payload).eq("id", editing.id)
      : await supabase.from("agencies").insert(payload);
    if (error) { notify("Failed: " + error.message); return; }
    notify("Agency saved");
    setOpen(false); setEditing(null); load();
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.name}?`)) return;
    const { error } = await supabase.from("agencies").delete().eq("id", row.id);
    if (error) { notify("Couldn't delete: " + error.message); return; }
    notify("Deleted");
    setOpen(false); setEditing(null); load();
  };

  return (
    <>
      <ListTable
        rows={rows}
        columns={[
          { key: "name", label: "Agency Name" }, { key: "code", label: "Code" },
          { key: "contact_person", label: "Contact Person" }, { key: "status", label: "Status" },
        ]}
        onAdd={() => { setEditing(null); setOpen(true); }}
        onEdit={(r) => { setEditing(r); setOpen(true); }}
        addLabel="Add Agency"
      />
      {open && <AgencyForm initial={editing} onSave={save} onDelete={editing ? () => remove(editing) : undefined} onClose={() => setOpen(false)} />}
    </>
  );
}

export function AgencyForm({ initial, onSave, onDelete, onClose }) {
  const [f, setF] = useState(initial || { name: "", code: "", contact_person: "", mobile: "", status: "Active", opening_balance: "", default_processing_charges: "", payment_terms: "7 Days" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Modal title={initial ? "Edit Agency" : "Create New Agency"} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Agency Name" required><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="Agency Code" required><Input value={f.code} onChange={set("code")} /></Field>
        <Field label="Contact Person"><Input value={f.contact_person} onChange={set("contact_person")} /></Field>
        <Field label="Mobile"><Input value={f.mobile} onChange={set("mobile")} /></Field>
      </div>
      <Field label="Status">
        <Select value={f.status} onChange={set("status")}><option>Active</option><option>Inactive</option></Select>
      </Field>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Opening Balance (₹)"><Input type="number" value={f.opening_balance} onChange={set("opening_balance")} /></Field>
        <Field label="Default Processing Charges (₹)"><Input type="number" value={f.default_processing_charges} onChange={set("default_processing_charges")} /></Field>
      </div>
      <Field label="Payment Terms">
        <Select value={f.payment_terms} onChange={set("payment_terms")}>
          <option>7 Days</option><option>15 Days</option><option>30 Days</option><option>Immediate</option>
        </Select>
      </Field>
      <FormActions isEdit={!!initial} label="Agency" onSave={() => onSave(f)} onDelete={onDelete} />
    </Modal>
  );
}
