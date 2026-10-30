import React, { useState, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useDarkMode } from "../lib/theme";
import { useSidebarColor, SIDEBAR_COLORS } from "../lib/sidebarColor";
import logoMark from "../assets/one-infinity-icon-mark.png";
import {
  LayoutGrid,
  FileOutput,
  Inbox,
  Database,
  Receipt,
  IndianRupee,
  BookOpen,
  BarChart2,
  Settings as SettingsIcon,
  MessageSquare,
  LogOut,
  ChevronRight,
  ChevronLeft,
  Sun,
  Moon,
  Users,
  Palette,
  Check,
  ShieldCheck,
} from "lucide-react";

// Maps each NAV key from App.jsx to an icon. Keep in sync if pages are added/removed.
const ICONS = {
  dashboard: LayoutGrid,
  applications: FileOutput,
  applicationExcel: FileOutput,
  staffApplications: Users,
  staffDraftApplications: Inbox,
  draftApplications: Inbox,
  pccApplications: ShieldCheck,
  chats: MessageSquare,
  masters: Database,
  payments: Receipt,
  paymentsReport: IndianRupee,
  ledger: BookOpen,
  dealerLedger: BookOpen,
  agencyLedger: BookOpen,
  reports: BarChart2,
  settings: SettingsIcon,
};

// Rounded "active pill" treatment, inspired by a floating icon-only mobile
// sidebar reference. Kept the existing labels/badges/collapse functionality
// rather than going fully icon-only — losing the chat-unread badges and
// page labels would hurt usability more than the visual match is worth.
// Text/icon colors here are deliberately color-agnostic (white-opacity based)
// rather than tied to one hue, since the background is now user-selectable
// (see sidebarColor.js) — this way every color option stays legible without
// needing its own matching text-color variant.
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

// nav: [{ key, label }] — Menu section. staff: { full_name } | null.
export default function Sidebar({ nav, active, onNavigate, staff, badges = {}, onLogout }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, toggleDark] = useDarkMode();
  const [colorKey, colorDef, setSidebarColor] = useSidebarColor();
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [photoUrl, setPhotoUrl] = useState(staff?.photo_url || null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef(null);

  const uploadProfilePhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !staff?.id) return;
    setUploadingPhoto(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData?.user?.id;
      if (!uid) return;
      const ext = file.name.split(".").pop();
      const path = `${uid}/staff-${staff.id}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("profile-photos").upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("profile-photos").getPublicUrl(path);
      await supabase.from("staff").update({ photo_url: pub.publicUrl }).eq("id", staff.id);
      setPhotoUrl(pub.publicUrl);
    } catch (err) {
      alert("Couldn't upload photo: " + err.message);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const [from, to] = dark ? colorDef.dark : colorDef.light;

  const initials = (staff?.full_name || "?")
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // On phones (and the Android wrapper) the sidebar is hidden by default and
  // slides in as a drawer over a dim backdrop; on tablets/desktop (md+) it
  // behaves exactly as before — always visible, no backdrop.
  const handleNavigate = (key) => {
    onNavigate(key);
    setMobileOpen(false);
  };

  return (
    <>
      {/* Hamburger trigger — mobile only */}
      <button
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
        className="no-print md:hidden fixed left-3 z-40 w-10 h-10 rounded-xl bg-white dark:bg-slate-900 shadow-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200"
        style={{ top: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
      >
        ☰
      </button>

      {/* Backdrop — mobile only, shown while drawer is open */}
      {mobileOpen && (
        <div
          className="no-print md:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

    <aside
      className={[
        "no-print shrink-0 h-screen flex flex-col m-3 rounded-3xl shadow-lg transition-all duration-300",
        "fixed top-0 left-0 z-50 md:sticky md:top-0",
        mobileOpen ? "translate-x-0" : "-translate-x-[120%] md:translate-x-0",
        collapsed ? "w-20" : "w-64",
      ].join(" ")}
      style={{
        height: "calc(100vh - 1.5rem)",
        marginTop: "calc(0.75rem + env(safe-area-inset-top, 0px))",
        background: `linear-gradient(to bottom, ${from}, ${to})`,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-white/15">
        <div className="w-10 h-10 shrink-0 rounded-xl bg-white flex items-center justify-center overflow-hidden">
          <img src={logoMark} alt="One Infinity" className="w-8 h-8 object-contain" />
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate text-white">One Infinity</p>
            <p className="text-xs truncate text-white/60">RTO Services ERP</p>
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
          {nav.map((item) => (
            <NavItem
              key={item.key}
              icon={ICONS[item.key] || LayoutGrid}
              label={item.label}
              active={active === item.key}
              collapsed={collapsed}
              badge={badges[item.key] || 0}
              onClick={() => handleNavigate(item.key)}
            />
          ))}
        </nav>
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
          onChange={uploadProfilePhoto}
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
            <p className="text-sm font-semibold truncate text-white">{staff?.full_name || "Signed in"}</p>
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
    </>
  );
}
