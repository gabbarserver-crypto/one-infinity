// src/components/Presence.jsx — small shared bits for online / last-seen UI.
import React from "react";
import { statusText } from "../lib/presence";

// Green dot that sits on the corner of an avatar. Renders nothing when offline.
export function OnlineDot({ online, className = "" }) {
  if (!online) return null;
  return (
    <span
      title="Online"
      className={`absolute top-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white dark:border-slate-900 ${className}`}
    />
  );
}

// "online" (green) or "last seen today at 3:45 PM" (muted). Nothing if unknown.
export function StatusLine({ status, className = "" }) {
  const text = statusText(status);
  if (!text) return null;
  return (
    <span className={`inline-flex items-center gap-1 ${status.online ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-slate-400 dark:text-slate-500"} ${className}`}>
      {status.online && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
      {text}
    </span>
  );
}
