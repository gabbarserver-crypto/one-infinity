import React, { useState } from "react";
import { Modal, Field, Input, PrimaryButton } from "./UI";
import { supabase } from "../lib/supabase";
import { buildAppointmentDraft, daysSinceCompleted } from "../lib/nextService";

// `nextService` is the { id, parent_service, short_name } row the source
// application's service points to via services.next_service_id.
export default function BookAppointmentModal({ sourceApp, nextService, onClose, onBooked }) {
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const days = daysSinceCompleted(sourceApp);

  const book = async () => {
    setSaving(true);
    setError("");
    try {
      // Draft No is assigned by the database once the Amount is filled in.
      const payload = buildAppointmentDraft(sourceApp, {
        serviceId: nextService.id,
        slotTime: date || null,
      });
      await onBooked(payload);
    } catch (e) {
      setError(e.message || "Couldn't create the appointment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Book Appointment" onClose={onClose}>
      <p className="text-sm text-slate-600 dark:text-slate-300 mb-1">
        <span className="font-semibold">{sourceApp.applicant_name}</span>'s {sourceApp.services?.parent_service} has
        been Accepted for {days ?? "30+"} days.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        This creates a new draft application for <span className="font-semibold">{nextService.parent_service}</span>,
        using the same applicant details, matching documents (Aadhaar, Photo, etc.), and Learner/PCC numbers already on file.
      </p>

      <Field label="Appointment Date (optional — can be set later)">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>

      {error && <p className="text-rose-500 text-sm mb-3">{error}</p>}

      <PrimaryButton onClick={book} disabled={saving}>
        {saving ? "Creating…" : "Create Draft Application"}
      </PrimaryButton>
    </Modal>
  );
}
