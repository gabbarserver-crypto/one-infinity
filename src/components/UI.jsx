// src/components/UI.jsx
import React from "react";
import { Pause, CheckCircle2, FileX, FileText, FileQuestion } from "lucide-react";
import { pushBack } from "../lib/backStack";

export const colors = {
  navy: "#0f1b3d",
  blue: "#2f6fed",
  green: "#16a34a",
  amber: "#d97706",
  rose: "#e11d48",
  bg: "#f4f6fa",
  border: "#e2e6ee",
  text: "#1a2233",
  muted: "#64748b",
};

export const STATUS_STYLES = {
  "Draft Submitted": "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30",
  "Under Review": "bg-blue-100 text-blue-800 border border-blue-200 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/30",
  "On Hold": "bg-rose-100 text-rose-800 border border-rose-200 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/30",
  Rejected: "bg-rose-100 text-rose-800 border border-rose-200 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/30",
  Accepted: "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/30",
};

// Subtle full-row background tint per status, used for table rows in
// Applications.jsx (lighter than STATUS_STYLES, which is for the badge chip).
export const ROW_STATUS_TINT = {
  "Draft Submitted": "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-500/5 dark:hover:bg-amber-500/10",
  "Under Review": "bg-blue-50/60 hover:bg-blue-50 dark:bg-blue-500/5 dark:hover:bg-blue-500/10",
  "On Hold": "bg-rose-50/60 hover:bg-rose-50 dark:bg-rose-500/5 dark:hover:bg-rose-500/10",
  Rejected: "bg-rose-50/60 hover:bg-rose-50 dark:bg-rose-500/5 dark:hover:bg-rose-500/10",
  Accepted: "bg-emerald-50/60 hover:bg-emerald-50 dark:bg-emerald-500/5 dark:hover:bg-emerald-500/10",
};

// Stored status values stay as-is everywhere (filters, DB writes, etc.) —
// this only swaps the *displayed* text. "Accepted" is what the Approve
// action writes to the DB, but staff/dealers should see it read as
// "Approved" wherever a status badge is shown.
export const STATUS_DISPLAY_LABELS = {
  Accepted: "Approved",
};

// Icon shown before the label in each status badge. On Hold gets a pause
// icon, Under Review a refresh/in-process icon, Accepted (shown as
// "Approved") a checkmark, Rejected a cross, Draft Submitted a pencil.
const STATUS_ICONS = {
  "Draft Submitted": FileText,
  "Under Review": FileQuestion,
  "On Hold": Pause,
  Rejected: FileX,
  Accepted: CheckCircle2,
};

export function StatusBadge({ status }) {
  const Icon = STATUS_ICONS[status];
  return (
    <span
      title={STATUS_DISPLAY_LABELS[status] || status}
      className={`inline-flex items-center px-1.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLES[status] || "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"}`}
    >
      {Icon && <Icon size={12} />}
    </span>
  );
}

export function Card({ title, children, className = "", hideTitleOnMobile = false }) {
  return (
    <div className={`w-full min-w-0 max-w-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 ${className}`}>
      {title && <h3 className={`text-base font-semibold text-slate-800 dark:text-slate-100 mb-4 ${hideTitleOnMobile ? "hidden md:block" : ""}`}>{title}</h3>}
      {children}
    </div>
  );
}

export function PrimaryButton({ children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`btn-accent inline-flex min-w-0 items-center justify-center gap-1.5 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-1.5 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-sm font-semibold px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

export function DangerButton({ children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-1.5 bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, required, children }) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}

const NO_UPPERCASE_TYPES = new Set(["password", "email", "number", "date", "time", "file", "tel", "url", "search"]);

export function Input({ preserveCase, onChange, type, as, ...props }) {
  const shouldUppercase = !preserveCase && !NO_UPPERCASE_TYPES.has(type);

  const handleChange = (e) => {
    if (shouldUppercase) {
      const pos = e.target.selectionStart;
      e.target.value = e.target.value.toUpperCase();
      // Restore cursor position — assigning .value moves it to the end otherwise.
      if (pos !== null && e.target.setSelectionRange) e.target.setSelectionRange(pos, pos);
    }
    onChange?.(e);
  };

  const baseClass = "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] focus:border-[var(--accent)]";

  if (as === "textarea") {
    return (
      <textarea
        {...props}
        onChange={handleChange}
        className={`${baseClass} ${props.className || ""}`}
      />
    );
  }

  return (
    <input
      {...props}
      type={type}
      onChange={handleChange}
      className={`${baseClass} ${props.className || ""}`}
    />
  );
}

export function Select({ children, ...props }) {
  return (
    <select
      {...props}
      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] focus:border-[var(--accent)]"
    >
      {children}
    </select>
  );
}

export function Modal({ title, onClose, children, wide, size }) {
  // Android/browser Back closes the topmost open popup first (see lib/backStack).
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => pushBack(() => onCloseRef.current?.()), []);
  const width = size === "md" ? "max-w-2xl" : size === "xl" ? "max-w-7xl" : wide || size === "wide" ? "max-w-3xl" : "max-w-lg";
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white dark:bg-slate-900 rounded-xl w-full ${width} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h3 className="font-bold text-slate-800 dark:text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl leading-none">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

export function Toast({ message, onDone }) {
  React.useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="fixed bottom-6 right-6 bg-slate-900 dark:bg-slate-700 text-white text-sm font-medium px-4 py-3 rounded-lg shadow-lg z-50">
      {message}
    </div>
  );
}
