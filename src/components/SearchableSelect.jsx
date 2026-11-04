import React, { useEffect, useRef, useState } from "react";

// Typeable dropdown that filters options by matching the search text
// anywhere in the label (not just from the start). Used for the Service
// picker in "New Application" (both admin and dealer side) where the list
// can run to 30+ entries and scrolling a plain <select> is slow.
// "SHORT — Full Name (CODE)" so a dealer can be found by typing either the
// short name, the full name or the code.
export function dealerOptionLabel(d, withCode = false) {
  if (!d) return "";
  const short = (d.short_name || "").trim();
  const full = (d.name || "").trim();
  let label = short && full && short.toLowerCase() !== full.toLowerCase() ? `${short} — ${full}` : (full || short);
  if (withCode && d.code) label += ` (${d.code})`;
  return label;
}

export default function SearchableSelect({ value, options, onChange, placeholder = "Select…" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef(null);
  const selected = options.find((o) => o.id === value);

  useEffect(() => {
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const filtered = query.trim()
    ? options.filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={open ? query : selected?.name || ""}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[0]) { onChange(filtered[0].id); setOpen(false); setQuery(""); e.currentTarget.blur(); }
          } else if (e.key === "Escape") {
            setOpen(false); e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg">
          {filtered.length === 0 && <p className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">No matches</p>}
          {filtered.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => { onChange(o.id); setOpen(false); setQuery(""); }}
              className={`w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-slate-100 hover:bg-blue-50 dark:hover:bg-slate-800 ${
                o.id === value ? "bg-blue-50 dark:bg-slate-800 font-medium" : ""
              }`}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
