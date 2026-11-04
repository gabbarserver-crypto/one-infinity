// src/components/BottomTabBar.jsx
//
// Mobile-only bottom navigation (phones; hidden md+ where the Sidebar is
// always visible instead) — the 5 most-used sections, reachable with one
// tap instead of opening the hamburger drawer. Everything else (Payments,
// Reports, Settings) still lives in that drawer, AND gets its own quick
// row at the top of the Dashboard page — see Dashboard.jsx.
//
// Dealer and Agency are deliberately never shown here: they're just the
// Ledger page pre-filtered to one entity type (see App.jsx's
// DealerLedgerPage/AgencyLedgerPage), so the plain "Ledger" tab already
// covers both — no separate bottom-bar slot needed for either.
import React from "react";
import { LayoutGrid, FileOutput, MessageSquare, BookOpen, Database, Users, ShieldCheck, GraduationCap, CreditCard } from "lucide-react";

const ICONS = {
  dashboard: LayoutGrid,
  applications: FileOutput,
  staffApplications: Users,
  chats: MessageSquare,
  ledger: BookOpen,
  masters: Database,
  pccApplications: ShieldCheck,
  learningApplications: GraduationCap,
  dlApplications: CreditCard,
};

// The primary set this bar is allowed to show — kept in one place so
// Dashboard.jsx's overflow row can exclude exactly these (plus
// dealerLedger/agencyLedger) rather than duplicating this list.
export const BOTTOM_TAB_KEYS = ["dashboard", "applications", "staffApplications", "pccApplications", "learningApplications", "dlApplications", "chats", "ledger", "masters"];

export default function BottomTabBar({ nav, active, onNavigate, badges = {} }) {
  // PCC / Learning / DL now sit in the bar too, so a role can have 8+ items —
  // the bar scrolls sideways (each item keeps a fixed minimum width) instead
  // of squeezing every label.
  const items = nav.filter((n) => BOTTOM_TAB_KEYS.includes(n.key));
  if (items.length < 2) return null; // not worth a bar for a single-item role

  return (
    <nav
      className="no-print md:hidden fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex overflow-x-auto"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map((item) => {
        const Icon = ICONS[item.key] || LayoutGrid;
        const isActive = active === item.key;
        const badge = badges[item.key] || 0;
        return (
          <button
            key={item.key}
            onClick={() => onNavigate(item.key)}
            className={`flex-1 min-w-[68px] shrink-0 py-2 flex flex-col items-center gap-0.5 text-[10px] font-medium ${
              isActive ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500"
            }`}
          >
            <span className="relative">
              <Icon size={20} strokeWidth={isActive ? 2.3 : 1.9} />
              {badge > 0 && (
                <span className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </span>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
