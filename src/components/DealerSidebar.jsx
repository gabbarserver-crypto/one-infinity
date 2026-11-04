// src/components/DealerSidebar.jsx
// Desktop-only left sidebar for the Dealer Portal — gives dealers the same
// dark, rounded, color-customizable nav shell as the admin app's Sidebar
// (see components/Sidebar.jsx), instead of the old top header + pill-tab
// row. Mobile is untouched: DealerPortal still shows its compact header
// and DealerBottomTabBar below the md breakpoint, so this component is
// only ever rendered with `hidden md:flex`.
import React, { useState, useRef } from "react";
import { useDarkMode } from "../lib/theme";
import { useSidebarColor, SIDEBAR_COLORS } from "../lib/sidebarColor";
import logoMark from "../assets/one-infinity-icon-mark.png";
import {
  LayoutDashboard,
  FileOutput,
  ShieldCheck,
  MessageSquare,
  BookOpen,
  ClipboardList,
  Receipt,
  Users,
  Download,
  Gamepad2,
  Fingerprint,
  Sun,
  Moon,
  Palette,
  Check,
  ChevronLeft,
  ChevronRight,
  LogOut,
  CalendarClock,
  QrCode,
} from "lucide-react";

const ICONS = {
  Dashboard: LayoutDashboard,
  Applications: FileOutput,
  Appointment: CalendarClock,
  "PCC Status": ShieldCheck,
  "Call/Chat": MessageSquare,
  Ledger: BookOpen,
  Service: ClipboardList,
  Payments: Receipt,
  Staff: Users,
};

function NavItem({ icon: Icon, label, active, collapsed, badge, onClick }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={[
        "group relative w-full flex items-center rounded-full py-2.5 text-sm font-medium transition-colors",
        collapsed ? "justify-center px-0" : "gap-2.5 px-3.5",
        active ? "bg-white text-slate-800 shadow-sm" : "text-white/80 hover:bg-white/10",
      ].join(" ")}
    >
      <span className="relative shrink-0">
        <Icon size={18} strokeWidth={1.9} className={active ? "text-slate-700" : "text-white/70"} />
        {collapsed && badge > 0 && (
          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-400" />
        )}
      </span>
      {!collapsed && <span className="flex-1 text-left truncate">{label}</span>}
      {!collapsed && badge > 0 && (
        <span className="shrink-0 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-semibold flex items-center justify-center">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function SectionLabel({ children, collapsed }) {
  if (collapsed) return <div className="h-4" />;
  return (
    <p className="px-3.5 text-xs font-semibold tracking-wider uppercase mb-2 text-white/50">
      {children}
    </p>
  );
}

// tabs: string[] (from DealerPortal's TABS/visibleTabs). identity: { type, name } | null.
export default function DealerSidebar({
  dealer,
  identity,
  tabs,
  active,
  onNavigate,
  unreadChats = 0,
  photoUrl,
  uploadingPhoto,
  onUploadPhoto,
  onLogout,
  apkPath,
  onOpenGames,
  onSetupPasskey,
  onPayByQr,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [dark, toggleDark] = useDarkMode();
  const [colorKey, colorDef, setSidebarColor] = useSidebarColor();
  const [showColorPicker, setShowColorPicker] = useState(false);
  const photoInputRef = useRef(null);

  const [from, to] = dark ? colorDef.dark : colorDef.light;

  const initials = (identity?.name || dealer?.name || "?")
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside
      className="no-print hidden md:flex shrink-0 flex-col m-3 rounded-3xl shadow-lg transition-all duration-300"
      style={{
        width: collapsed ? "5rem" : "16rem",
        height: "calc(100vh - 1.5rem)",
        background: `linear-gradient(to bottom, ${from}, ${to})`,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-white/15">
        <div className="w-10 h-10 shrink-0 rounded-xl bg-white flex items-center justify-center overflow-hidden">
          <img src={logoMark} alt="" className="w-8 h-8 object-contain" />
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate text-white">{dealer?.name}</p>
            <p className="text-xs truncate text-white/60">Dealer Portal · Code {dealer?.code}</p>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            className="shrink-0 p-1 rounded-md text-white/60 hover:bg-white/10"
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
          className="mx-auto mt-3 p-1 rounded-md text-white/60 hover:bg-white/10"
        >
          <ChevronRight size={16} />
        </button>
      )}

      {/* Nav */}
      <div className="flex-1 px-3 py-4 overflow-y-auto">
        <SectionLabel collapsed={collapsed}>Menu</SectionLabel>
        <nav className="space-y-1">
          {tabs.map((t) => (
            <NavItem
              key={t}
              icon={ICONS[t] || FileOutput}
              label={t}
              active={active === t}
              collapsed={collapsed}
              badge={t === "Call/Chat" ? unreadChats : 0}
              onClick={() => onNavigate(t)}
            />
          ))}
        </nav>
      </div>

      {/* Pay by QR — always reachable on desktop, whichever tab is open. */}
      {onPayByQr && (
        <div className="px-4 pb-3">
          <button
            onClick={onPayByQr}
            title="Pay by QR"
            aria-label="Pay by QR"
            className={`w-full flex items-center rounded-xl bg-white/15 hover:bg-white/25 text-white text-sm font-semibold py-2.5 ${collapsed ? "justify-center px-0" : "gap-2.5 px-3"}`}
          >
            <QrCode size={16} />
            {!collapsed && <span>Pay by QR</span>}
          </button>
        </div>
      )}

      {/* Quick actions — app download / games / passkey, same shortcuts
          that used to live as icon buttons in the old top header. */}
      <div className={`px-4 py-3 border-t border-white/15 flex ${collapsed ? "flex-col items-center gap-2" : "items-center gap-2"}`}>
        <a
          href={apkPath}
          download
          title="Download Android App"
          aria-label="Download Android App"
          className="w-9 h-9 flex items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Download size={16} />
        </a>
        <button
          onClick={onOpenGames}
          title="1 Infinity Games"
          aria-label="1 Infinity Games"
          className="w-9 h-9 flex items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Gamepad2 size={16} />
        </button>
        <button
          onClick={onSetupPasskey}
          title="Set up Fingerprint / Face ID login on this device"
          aria-label="Set up fingerprint login"
          className="w-9 h-9 flex items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Fingerprint size={16} />
        </button>
      </div>

      {/* Sidebar color picker */}
      <div className="px-4 py-3 border-t border-white/15 relative">
        <button
          onClick={() => setShowColorPicker((s) => !s)}
          title="Choose sidebar color"
          aria-label="Choose sidebar color"
          className={`w-full flex items-center rounded-lg py-1.5 text-sm font-medium text-white/70 hover:bg-white/10 ${collapsed ? "justify-center px-0" : "gap-2.5 px-2"}`}
        >
          <Palette size={16} />
          {!collapsed && <span>Sidebar Color</span>}
        </button>
        {showColorPicker && (
          <div
            className={`absolute z-30 bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 p-3 grid grid-cols-3 gap-2 ${
              collapsed ? "left-full ml-2 bottom-2 w-40" : "left-4 right-4 bottom-full mb-2"
            }`}
          >
            {Object.entries(SIDEBAR_COLORS).map(([key, def]) => (
              <button
                key={key}
                onClick={() => { setSidebarColor(key); setShowColorPicker(false); }}
                title={def.label}
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 mx-auto"
                style={{ backgroundColor: def.swatch }}
              >
                {colorKey === key && <Check size={16} className="text-white" strokeWidth={3} />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Theme toggle */}
      <div className={`px-4 py-3 flex items-center border-t border-white/15 ${collapsed ? "justify-center" : "gap-2.5"}`}>
        <Sun size={14} className="text-white/60" />
        <button
          onClick={toggleDark}
          aria-label="Toggle dark mode"
          className="relative w-9 h-5 rounded-full transition-colors shrink-0 bg-white/20"
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
              dark ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
        {!collapsed && <Moon size={14} className="text-white/60" />}
      </div>

      {/* Profile */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-t border-white/15">
        <input
          type="file"
          accept="image/*"
          ref={photoInputRef}
          className="hidden"
          onChange={onUploadPhoto}
        />
        <button
          type="button"
          onClick={() => photoInputRef.current?.click()}
          title="Change profile photo"
          className="w-9 h-9 shrink-0 rounded-full bg-white flex items-center justify-center text-xs font-semibold overflow-hidden relative group"
          style={{ color: from }}
        >
          {photoUrl ? (
            <img src={photoUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            initials
          )}
          <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-[9px]">
            {uploadingPhoto ? "…" : "Edit"}
          </span>
        </button>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate text-white">{identity?.name || dealer?.name || "Signed in"}</p>
            <button onClick={onLogout} className="text-xs font-semibold text-white/60 hover:text-white">
              Logout
            </button>
          </div>
        )}
        {collapsed && (
          <button onClick={onLogout} title="Logout" className="shrink-0 text-white/60 hover:text-white">
            <LogOut size={16} />
          </button>
        )}
      </div>
    </aside>
  );
}
