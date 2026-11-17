import React, { useRef, useState } from "react";

// Drag-and-drop (desktop) + tap-to-browse (mobile/desktop) file picker for
// a single document slot. Used by both the dealer portal's own-document
// upload and the admin/staff Applications page's document review panel,
// so a Learning Licence PDF (or Aadhaar, photo, etc.) can be dropped in
// straight after downloading it from Sarathi/UIDAI, instead of hunting
// for a plain <input> control.
//
// Deliberately has NO `capture` attribute on the underlying <input> — that
// attribute is what forces a phone straight into the camera app (used on
// purpose elsewhere, e.g. the Aadhaar QR/OCR scanners). Leaving it off
// means the browser shows its normal file chooser, which on mobile
// includes "Recent"/"Files"/"Gallery"/"Camera" as options rather than
// jumping straight to the camera.
export default function DocUploadDropzone({
  onFile,
  busy = false,
  accept = "image/*,.pdf",
  label = "Drop file here or tap to upload",
  compact = false,
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = (files) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!busy && (e.key === "Enter" || e.key === " ")) inputRef.current?.click();
      }}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!busy) handleFiles(e.dataTransfer.files);
      }}
      className={[
        compact
          ? "flex items-center justify-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] font-semibold transition-colors select-none"
          : "flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-3 py-3 text-xs font-semibold transition-colors select-none",
        busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
        dragOver
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-600"
          : "border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-400 dark:hover:border-slate-600",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        disabled={busy}
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
      />
      {busy ? "Uploading…" : `⬆ ${label}`}
    </div>
  );
}
