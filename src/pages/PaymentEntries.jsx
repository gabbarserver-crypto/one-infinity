// src/pages/PaymentEntries.jsx
//
// Staff record a payment here; it stays "Pending" (no ledger effect) until an
// Admin verifies it. Verify creates the real payment + ledger entry through
// verify_staff_payment_entry() (see supabase/migrations/025). Reject closes it
// with a reason the staff member can see.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, Field, Input, Select, PrimaryButton, GhostButton, DangerButton, Modal, Toast } from "../components/UI";
import SearchableSelect, { dealerOptionLabel } from "../components/SearchableSelect";
import StaffQrSendPanel from "../components/StaffQrSendPanel";

const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const EMPTY_FORM = () => ({ dealer_id: "", amount: "", payment_mode: "Cash", paid_on: todayIST(), reference_no: "", remarks: "" });
const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const fmtD = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const fmtDT = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

const STATUS_STYLE = {
  Pending: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  Verified: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  Rejected: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

const notifyChanged = () => window.dispatchEvent(new Event("payment-entries-changed"));

// verifyOnly: Admin-only embed inside the Ledger page — shows just the staff entries to verify/reject (no entry form).
export default function PaymentEntries({ staff, isAdmin: isAdminProp, verifyOnly = false } = {}) {
  const isAdmin = isAdminProp ?? staff?.roles?.role_name === "Admin";
  const [dealers, setDealers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [filter, setFilter] = useState("Pending");
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null); // entry being rejected
  const [rejectReason, setRejectReason] = useState("");
  const [showSendQr, setShowSendQr] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("staff_payment_entries")
      .select("*, dealers(name,code,short_name), entered:entered_by(full_name), verifier:verified_by(full_name)")
      .order("entered_at", { ascending: false })
      .limit(500);
    if (error) setToast("Failed to load: " + error.message);
    setEntries(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("dealers").select("id, name, code, short_name, mobile");
      setDealers(data || []);
    })();
    load();
  }, [load]);

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  const submit = async () => {
    const amount = parseFloat(form.amount);
    if (!form.dealer_id) return setToast("Dealer is required");
    if (!amount || amount <= 0) return setToast("Enter a valid amount");
    if (!staff?.id) return setToast("Could not identify your staff login — please reload");
    const ref = form.reference_no.trim();
    if (ref) {
      const { data: inPayments } = await supabase.from("payments").select("id").eq("reference_no", ref).limit(1).maybeSingle();
      const { data: inEntries } = await supabase.from("staff_payment_entries").select("id").eq("reference_no", ref).neq("status", "Rejected").limit(1).maybeSingle();
      if (inPayments || inEntries) return setToast(`Reference "${ref}" is already recorded — check before saving again.`);
    }
    setSaving(true);
    const { error } = await supabase.from("staff_payment_entries").insert({
      dealer_id: form.dealer_id,
      amount,
      payment_mode: form.payment_mode,
      reference_no: ref || null,
      remarks: form.remarks.trim() || null,
      paid_on: form.paid_on || todayIST(),
      entered_by: staff.id,
    });
    setSaving(false);
    if (error) return setToast("Failed: " + error.message);
    setToast("Entry saved — waiting for Admin verification");
    setForm(EMPTY_FORM());
    setFilter("Pending");
    notifyChanged();
    load();
  };

  const verify = async (e) => {
    setBusyId(e.id);
    const { error } = await supabase.rpc("verify_staff_payment_entry", { p_entry_id: e.id });
    setBusyId(null);
    if (error) return setToast("Verify failed: " + error.message);
    setToast("Verified — payment & ledger entry created");
    notifyChanged();
    load();
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    setBusyId(rejecting.id);
    const { error } = await supabase.rpc("reject_staff_payment_entry", { p_entry_id: rejecting.id, p_reason: rejectReason });
    setBusyId(null);
    if (error) return setToast("Reject failed: " + error.message);
    setRejecting(null);
    setRejectReason("");
    setToast("Entry rejected");
    notifyChanged();
    load();
  };

  const withdraw = async (e) => {
    if (!window.confirm(`Delete this ${rupees(e.amount)} entry?`)) return;
    setBusyId(e.id);
    const { error } = await supabase.from("staff_payment_entries").delete().eq("id", e.id);
    setBusyId(null);
    if (error) return setToast("Failed: " + error.message);
    notifyChanged();
    load();
  };

  const counts = useMemo(() => {
    const c = { Pending: 0, Verified: 0, Rejected: 0, All: entries.length };
    entries.forEach((e) => { c[e.status] = (c[e.status] || 0) + 1; });
    return c;
  }, [entries]);
  const shown = filter === "All" ? entries : entries.filter((e) => e.status === filter);
  const pendingTotal = entries.filter((e) => e.status === "Pending").reduce((a, e) => a + Number(e.amount || 0), 0);

  const myId = staff?.id;

  return (
    <div className="space-y-4">
      {!verifyOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={() => setShowSendQr(true)}>📲 Send Payment QR</PrimaryButton>
          <span className="text-xs text-slate-500 dark:text-slate-400">QR payments are confirmed automatically by the gateway — no verification needed.</span>
        </div>
      )}

      {!verifyOnly && (
      <Card title="Payment Entry">
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          {isAdmin
            ? "Entries added by staff wait here. Verify to post the payment to the dealer's ledger, or reject with a reason."
            : "Add the payment you received. It reaches the dealer's ledger only after Admin verifies it."}
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <Field label="Dealer" required>
            <SearchableSelect
              value={form.dealer_id}
              onChange={(id) => setForm((s) => ({ ...s, dealer_id: id }))}
              options={dealers.map((d) => ({ id: d.id, name: dealerOptionLabel(d, true) }))}
              placeholder="Type to search dealer…"
            />
          </Field>
          <Field label="Amount (₹)" required>
            <Input type="number" value={form.amount} onChange={set("amount")} />
          </Field>
          <Field label="Payment Mode" required>
            <Select value={form.payment_mode} onChange={set("payment_mode")}>
              <option>Cash</option><option>UPI</option><option>Bank</option><option>Cheque</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={form.paid_on} onChange={set("paid_on")} />
          </Field>
          <Field label="Reference No.">
            <Input value={form.reference_no} onChange={set("reference_no")} placeholder="UTR / cheque no." />
          </Field>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="Remarks">
              <Input value={form.remarks} onChange={set("remarks")} />
            </Field>
          </div>
        </div>
        <PrimaryButton onClick={submit} disabled={saving}>{saving ? "Saving..." : "Save Entry"}</PrimaryButton>
      </Card>
      )}

      <Card title={verifyOnly ? "Staff Payment Entries — Verify" : isAdmin ? "Entries" : "My Entries"}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {["Pending", "Verified", "Rejected", "All"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                filter === s
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-transparent text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              {s} ({counts[s] || 0})
            </button>
          ))}
          {counts.Pending > 0 && (
            <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">Pending total: <b>{rupees(pendingTotal)}</b></span>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">No {filter === "All" ? "" : filter.toLowerCase() + " "}entries.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Dealer</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2 pr-3">Mode / Ref</th>
                  {isAdmin && <th className="py-2 pr-3">Entered by</th>}
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 dark:border-slate-800/70 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{fmtD(e.paid_on)}</td>
                    <td className="py-2 pr-3">{e.dealers?.short_name || e.dealers?.name || "—"}</td>
                    <td className="py-2 pr-3 text-right font-semibold whitespace-nowrap">{rupees(e.amount)}</td>
                    <td className="py-2 pr-3">
                      <div>{e.payment_mode}</div>
                      {e.reference_no && <div className="text-xs text-slate-500 dark:text-slate-400">{e.reference_no}</div>}
                      {e.remarks && <div className="text-xs text-slate-400 dark:text-slate-500">{e.remarks}</div>}
                    </td>
                    {isAdmin && (
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <div>{e.entered?.full_name || "—"}</div>
                        <div className="text-xs text-slate-400">{fmtDT(e.entered_at)}</div>
                      </td>
                    )}
                    <td className="py-2 pr-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_STYLE[e.status] || ""}`}>{e.status}</span>
                      {e.status !== "Pending" && (
                        <div className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                          {e.verifier?.full_name ? `${e.verifier.full_name} · ` : ""}{fmtDT(e.verified_at)}
                        </div>
                      )}
                      {e.status === "Rejected" && e.reject_reason && (
                        <div className="text-xs text-rose-500 mt-0.5">{e.reject_reason}</div>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {e.status === "Pending" && isAdmin && (
                        <div className="flex justify-end gap-2">
                          <PrimaryButton disabled={busyId === e.id} onClick={() => verify(e)}>Verify</PrimaryButton>
                          <DangerButton disabled={busyId === e.id} onClick={() => { setRejecting(e); setRejectReason(""); }}>Reject</DangerButton>
                        </div>
                      )}
                      {e.status === "Pending" && !isAdmin && e.entered_by === myId && (
                        <GhostButton disabled={busyId === e.id} onClick={() => withdraw(e)}>Delete</GhostButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {rejecting && (
        <Modal title="Reject entry" onClose={() => setRejecting(null)}>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
            {rupees(rejecting.amount)} — {rejecting.dealers?.short_name || rejecting.dealers?.name}
          </p>
          <Field label="Reason (staff will see this)">
            <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2 mt-4">
            <GhostButton onClick={() => setRejecting(null)}>Cancel</GhostButton>
            <DangerButton disabled={busyId === rejecting.id} onClick={confirmReject}>Reject</DangerButton>
          </div>
        </Modal>
      )}

      {showSendQr && <StaffQrSendPanel staff={staff} dealers={dealers} onClose={() => setShowSendQr(false)} />}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
