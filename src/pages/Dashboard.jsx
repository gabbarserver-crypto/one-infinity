// src/pages/Dashboard.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { createGamesHandoffCode } from "../lib/serverApi";
import { fetchAllRows } from "../lib/fetchAll";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { FileText, CalendarCheck, CalendarClock, FileEdit, Clock, CheckCircle2, Users, UserCheck, Download, Smartphone, CreditCard, BarChart2, Settings as SettingsIcon, LayoutGrid, Wallet, Landmark, Gamepad2 } from "lucide-react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { BOTTOM_TAB_KEYS } from "../components/BottomTabBar";

// Icons for whichever nav items land in the mobile-only overflow row below
// (see Dashboard()'s OVERFLOW_KEYS) — anything not already in the bottom
// tab bar. Dealer/Agency are excluded on purpose (same reasoning as
// BottomTabBar.jsx: Ledger already covers both).
const OVERFLOW_ICONS = { payments: CreditCard, reports: BarChart2, settings: SettingsIcon };

// Bump this when you upload a new build to the GitHub Release so the
// version number on the dashboard stays in sync.
// IMPORTANT: this is a GitHub Releases URL, NOT a local /public file. Do
// not put the .apk under public/downloads/ — Capacitor copies the entire
// dist/ (which includes everything in public/) into the native Android
// app's own assets at build time, so a self-hosted APK there ends up
// bundled INSIDE the app itself, ballooning its size with every build
// (this is what caused the app to balloon to ~100MB+ before).
const APP_VERSION = "1.0.0";
const APK_PATH = "https://github.com/gabbarserver-crypto/one-infinity/releases/latest/download/app-1infinity.apk";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Colors kept in sync with the tile palette above (amber/orange = pending,
// emerald/green = completed) so the donut reads consistently with the
// rest of the dashboard.
const STATUS_COLORS = { pending: "#d97706", completed: "#059669" };
const DEALER_BAR_COLORS = { pending: "#d97706", completed: "#059669" };

// 1 Infinity Games — opens the standalone games site, handing off the current
// Supabase session so a staff member who's already logged in here doesn't
// have to log in again there. Both apps share the same Supabase project,
// so the games site adopts this session via supabase.auth.setSession().
// Only a one-time code travels in the URL (see api/games-handoff.js); the
// games site redeems it for the session -- see sjo-supabase-sync.js there.
const GAMES_URL = "https://sjo-games-vercel-app.vercel.app/games/index.html";
const openGames = async () => {
  // The session is handed to the Games app via a short-lived, single-use
  // code (api/games-handoff.js) -- never by putting the access/refresh
  // tokens in the URL, where they'd end up in history, logs and Referer
  // headers. If the hand-off can't be created, Games still opens, just
  // signed out, rather than falling back to tokens in the URL.
  let url = GAMES_URL;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      const { code } = await createGamesHandoffCode({ refreshToken: session.refresh_token });
      if (code) url = `${GAMES_URL}?${new URLSearchParams({ code }).toString()}`;
    }
  } catch (e) {
    console.error("Games hand-off failed:", e);
  }

  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url, presentationStyle: "popover" });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};

// Each tile gets its own solid color fill (point 16) instead of a plain
// white card with just the number colored — makes the dashboard scannable
// at a glance rather than needing to read every label.
const TILE_STYLES = {
  total_applications:     { icon: FileText,      classes: "bg-blue-600" },
  today_applications:     { icon: CalendarCheck,  classes: "bg-emerald-600" },
  yesterday_applications: { icon: CalendarClock,  classes: "bg-slate-600" },
  draft_applications:     { icon: FileEdit,       classes: "bg-amber-500" },
  pending_applications:   { icon: Clock,          classes: "bg-orange-600" },
  completed_applications: { icon: CheckCircle2,   classes: "bg-green-600" },
  total_dealers:          { icon: Users,          classes: "bg-indigo-600" },
  active_dealers:         { icon: UserCheck,      classes: "bg-teal-600" },
};

export default function Dashboard({ visibleNav = [], onNavigate, active }) {
  const [counts, setCounts] = useState(null);
  const [balances, setBalances] = useState({ dealer_total: null, agency_total: null });

  const now0 = new Date();
  const [month, setMonth] = useState(now0.getMonth()); // 0-11
  const [year, setYear] = useState(now0.getFullYear());
  const [monthRows, setMonthRows] = useState([]);
  const [monthLoading, setMonthLoading] = useState(true);
  const [monthError, setMonthError] = useState("");
  const yearOptions = Array.from({ length: 5 }, (_, i) => now0.getFullYear() - i);

  // 6-month trend — separate query covering a fixed rolling window (not
  // tied to the month/year picker above), so the trend line stays put
  // while someone browses different months in the breakdown below.
  const [trendRows, setTrendRows] = useState([]);
  const [trendLoading, setTrendLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("get_dashboard_counts").maybeSingle();
      setCounts(data);
    })();
    (async () => {
      const [{ data: dealerSummaries }, { data: agencySummaries }] = await Promise.all([
        supabase.from("dealer_ledger_summary").select("running_balance"),
        supabase.from("agency_ledger_summary").select("running_balance"),
      ]);
      setBalances({
        dealer_total: (dealerSummaries || []).reduce((acc, s) => acc + Number(s.running_balance || 0), 0),
        agency_total: (agencySummaries || []).reduce((acc, s) => acc + Number(s.running_balance || 0), 0),
      });
    })();
    (async () => {
      setTrendLoading(true);
      // Rolling 6-month window ending this month (oldest -> newest).
      const rangeStart = new Date(now0.getFullYear(), now0.getMonth() - 5, 1).toISOString();
      // Paged: six months of applications is well past Supabase's 1000-row
      // cap, which silently under-counted the trend.
      const { data, error } = await fetchAllRows(() =>
        supabase
          .from("applications")
          .select("id, status, submitted_at, ll_dl_no, services(ll_dl_no_required)")
          .gte("submitted_at", rangeStart)
          .order("submitted_at", { ascending: false })
          .order("id", { ascending: false })
      );
      if (error) console.error("Dashboard trend failed:", error);
      setTrendRows(data || []);
      setTrendLoading(false);
    })();
  }, []);

  // "This Month" breakdown — separate from the lifetime-total tiles above
  // (get_dashboard_counts() isn't month-scoped), so it's its own query
  // against applications.submitted_at for whichever month/year is picked.
  useEffect(() => {
    (async () => {
      setMonthLoading(true);
      setMonthError("");
      const rangeStart = new Date(year, month, 1).toISOString();
      const rangeEnd = new Date(year, month + 1, 1).toISOString();
      const { data, error } = await fetchAllRows(() =>
        supabase
          .from("applications")
          .select("id, status, submitted_at, ll_dl_no, dealers(name), services(ll_dl_no_required)")
          .gte("submitted_at", rangeStart)
          .lt("submitted_at", rangeEnd)
          .order("submitted_at", { ascending: false })
          .order("id", { ascending: false })
      );
      if (error) {
        setMonthError(error.message);
        setMonthLoading(false);
        return;
      }
      setMonthRows(data || []);
      setMonthLoading(false);
    })();
  }, [month, year]);

  // Matches the same status grouping get_dashboard_counts() uses server-side,
  // PLUS the same "is it actually done" nuance Applications.jsx's
  // getProcessingStage() applies: an "Accepted" row whose LL/DL No. is
  // still required-but-blank isn't really finished yet, so it counts as
  // pending here rather than completed (mirrors what staff see on the
  // Applications page — the "Application No. generated" sub-label with no
  // LL/DL No. filled in means the case is still open).
  const lldlStillMissing = (r) => {
    const required = r.services?.ll_dl_no_required !== false; // default true, per migration 015
    return required && !r.ll_dl_no;
  };
  const isCompleted = (r) => {
    if (r.status === "Completed") return true;
    if (r.status === "Accepted") return !lldlStillMissing(r);
    return false;
  };
  const isPending = (r) => {
    if (r.status === "Under Review" || r.status === "On Hold") return true;
    if (r.status === "Accepted" && lldlStillMissing(r)) return true;
    return false;
  };
  const monthTotals = monthRows.reduce(
    (acc, r) => {
      acc.total += 1;
      if (isCompleted(r)) acc.completed += 1;
      else if (isPending(r)) acc.pending += 1;
      return acc;
    },
    { total: 0, pending: 0, completed: 0 }
  );
  const dealerGroups = new Map();
  for (const r of monthRows) {
    const label = r.dealers?.name || "Unknown dealer";
    if (!dealerGroups.has(label)) dealerGroups.set(label, { label, total: 0, pending: 0, completed: 0 });
    const g = dealerGroups.get(label);
    g.total += 1;
    if (isCompleted(r)) g.completed += 1;
    else if (isPending(r)) g.pending += 1;
  }
  const dealerGroupRows = [...dealerGroups.values()].sort((a, b) => b.total - a.total);
  const monthLabel = `${MONTH_NAMES[month]} ${year}`;

  // Status donut — reuses monthTotals so it always matches the 3 stat
  // cards above the table (no separate source of truth).
  const statusDonutData = [
    { name: "Pending", key: "pending", value: monthTotals.pending },
    { name: "Completed", key: "completed", value: monthTotals.completed },
  ].filter((d) => d.value > 0);

  // Dealer bar chart — top 8 dealers this month, pending/completed
  // stacked, from the same dealerGroupRows the table below uses.
  const dealerBarData = dealerGroupRows.slice(0, 8);

  // 6-month trend — bucket trendRows by submitted_at's month.
  const trendBuckets = new Map();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now0.getFullYear(), now0.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    trendBuckets.set(key, { key, label: `${MONTH_SHORT[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`, total: 0, pending: 0, completed: 0 });
  }
  for (const r of trendRows) {
    const d = new Date(r.submitted_at);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = trendBuckets.get(key);
    if (!bucket) continue; // outside the 6-month window (shouldn't happen given the query range)
    bucket.total += 1;
    if (isCompleted(r)) bucket.completed += 1;
    else if (isPending(r)) bucket.pending += 1;
  }
  const trendData = [...trendBuckets.values()];

  const tiles = counts
    ? [
        { key: "total_applications", label: "Total Applications", value: counts.total_applications },
        { key: "today_applications", label: "Today's Applications", value: counts.today_applications },
        { key: "yesterday_applications", label: "Yesterday's Applications", value: counts.yesterday_applications },
        { key: "draft_applications", label: "Draft Applications", value: counts.draft_applications },
        { key: "pending_applications", label: "Pending (Review/Hold)", value: counts.pending_applications },
        { key: "completed_applications", label: "Accepted", value: counts.completed_applications },
        { key: "total_dealers", label: "Total Dealers", value: counts.total_dealers },
        { key: "active_dealers", label: "Active Dealers", value: counts.active_dealers },
      ]
    : [];

  // Everything visible to this role that ISN'T already in the bottom tab
  // bar (see BottomTabBar.jsx) — Dealer/Agency are filtered out here too,
  // same reasoning: Ledger already covers both, no need for their own
  // shortcut. Mobile-only; on tablet/desktop the sidebar already lists
  // every section, so this row would just be redundant there.
  const overflowNav = visibleNav.filter(
    (n) => !BOTTOM_TAB_KEYS.includes(n.key) && n.key !== "dealerLedger" && n.key !== "agencyLedger"
  );

  // Tiles are clickable shortcuts into the page that actually shows that
  // data — e.g. tapping "Draft Applications" jumps to the Draft page. Each
  // tile key maps to a couple of possible nav keys because which one
  // exists depends on role (staff vs non-staff variants of the same
  // page — see the NAV_ITEMS list in App.jsx); we just use whichever one
  // this user's visibleNav actually has. If neither is visible to this
  // role, the tile silently stays non-clickable rather than erroring.
  const visibleKeys = new Set(visibleNav.map((n) => n.key));
  const firstVisible = (...keys) => keys.find((k) => visibleKeys.has(k));
  const TILE_NAV = {
    total_applications: firstVisible("applications", "staffApplications"),
    today_applications: firstVisible("applications", "staffApplications"),
    yesterday_applications: firstVisible("applications", "staffApplications"),
    draft_applications: firstVisible("draftApplications", "staffDraftApplications"),
    pending_applications: firstVisible("applications", "staffApplications"),
    completed_applications: firstVisible("applications", "staffApplications"),
    total_dealers: firstVisible("dealerLedger", "ledger"),
    active_dealers: firstVisible("dealerLedger", "ledger"),
  };
  const dealerBalanceNav = firstVisible("dealerLedger", "ledger");
  const agencyBalanceNav = firstVisible("agencyLedger", "ledger");

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-1">Dashboard</h2>
      <p className="text-slate-400 dark:text-slate-500 mb-6">Live snapshot of office activity</p>

      {overflowNav.length > 0 && onNavigate && (
        <div className="md:hidden flex gap-2 overflow-x-auto pb-1 mb-5 -mx-1 px-1">
          {overflowNav.map((n) => {
            const Icon = OVERFLOW_ICONS[n.key] || LayoutGrid;
            const isActive = active === n.key;
            return (
              <button
                key={n.key}
                onClick={() => onNavigate(n.key)}
                className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-semibold border ${
                  isActive
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                }`}
              >
                <Icon size={15} />
                {n.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {tiles.map((t) => {
          const style = TILE_STYLES[t.key] || { icon: FileText, classes: "bg-slate-600" };
          const Icon = style.icon;
          const navKey = TILE_NAV[t.key];
          const clickable = Boolean(navKey && onNavigate);
          const Tag = clickable ? "button" : "div";
          return (
            <Tag
              key={t.key}
              type={clickable ? "button" : undefined}
              onClick={clickable ? () => onNavigate(navKey) : undefined}
              className={`${style.classes} rounded-2xl p-3 sm:p-5 text-white shadow-sm relative overflow-hidden text-left w-full ${clickable ? "cursor-pointer hover:brightness-110 active:brightness-95 transition-[filter]" : ""}`}
            >
              <Icon size={18} className="opacity-80 mb-2 sm:mb-3 sm:w-[22px] sm:h-[22px]" />
              <p className="text-xl sm:text-3xl font-bold leading-none">{t.value ?? "—"}</p>
              <p className="text-xs sm:text-sm opacity-90 mt-1.5 sm:mt-2">{t.label}</p>
              <Icon size={60} className="absolute -right-3 -bottom-3 opacity-10 sm:w-[90px] sm:h-[90px] hidden sm:block" />
            </Tag>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 mt-4">
        {(() => {
          const clickable = Boolean(dealerBalanceNav && onNavigate);
          const Tag = clickable ? "button" : "div";
          return (
            <Tag
              type={clickable ? "button" : undefined}
              onClick={clickable ? () => onNavigate(dealerBalanceNav) : undefined}
              className={`${Number(balances.dealer_total) < 0 ? "bg-rose-600" : "bg-violet-600"} rounded-2xl p-3 sm:p-5 text-white shadow-sm relative overflow-hidden text-left w-full ${clickable ? "cursor-pointer hover:brightness-110 active:brightness-95 transition-[filter]" : ""}`}
            >
              <Wallet size={18} className="opacity-80 mb-2 sm:mb-3 sm:w-[22px] sm:h-[22px]" />
              <p className="text-lg sm:text-2xl font-bold leading-none">
                {balances.dealer_total === null ? "—" : `₹${balances.dealer_total.toLocaleString("en-IN")}`}
              </p>
              <p className="text-xs sm:text-sm opacity-90 mt-1.5 sm:mt-2">Total Dealer Balance</p>
              <Wallet size={60} className="absolute -right-3 -bottom-3 opacity-10 sm:w-[90px] sm:h-[90px] hidden sm:block" />
            </Tag>
          );
        })()}
        {(() => {
          const clickable = Boolean(agencyBalanceNav && onNavigate);
          const Tag = clickable ? "button" : "div";
          return (
            <Tag
              type={clickable ? "button" : undefined}
              onClick={clickable ? () => onNavigate(agencyBalanceNav) : undefined}
              className={`${Number(balances.agency_total) < 0 ? "bg-rose-600" : "bg-cyan-700"} rounded-2xl p-3 sm:p-5 text-white shadow-sm relative overflow-hidden text-left w-full ${clickable ? "cursor-pointer hover:brightness-110 active:brightness-95 transition-[filter]" : ""}`}
            >
              <Landmark size={18} className="opacity-80 mb-2 sm:mb-3 sm:w-[22px] sm:h-[22px]" />
              <p className="text-lg sm:text-2xl font-bold leading-none">
                {balances.agency_total === null ? "—" : `₹${balances.agency_total.toLocaleString("en-IN")}`}
              </p>
              <p className="text-xs sm:text-sm opacity-90 mt-1.5 sm:mt-2">Total Agency Balance</p>
              <Landmark size={60} className="absolute -right-3 -bottom-3 opacity-10 sm:w-[90px] sm:h-[90px] hidden sm:block" />
            </Tag>
          );
        })()}
      </div>

      <div className="mt-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">{monthLabel}</h3>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Applications submitted this period, by dealer</p>
          </div>
          <div className="flex gap-2">
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="text-sm border border-slate-300 dark:border-slate-700 dark:bg-slate-900 rounded-lg px-2.5 py-1.5"
            >
              {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="text-sm border border-slate-300 dark:border-slate-700 dark:bg-slate-900 rounded-lg px-2.5 py-1.5"
            >
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {monthLoading ? (
          <div className="text-center py-8 text-slate-400 text-sm">Loading…</div>
        ) : monthError ? (
          <div className="text-center py-8 text-red-500 text-sm">{monthError}</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{monthTotals.total}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Total Submitted</p>
              </div>
              <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-4">
                <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">{monthTotals.pending}</p>
                <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-1">Pending</p>
              </div>
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-4">
                <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{monthTotals.completed}</p>
                <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80 mt-1">Completed</p>
              </div>
            </div>

            {(statusDonutData.length > 0 || dealerBarData.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                {statusDonutData.length > 0 && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 px-1">Pending vs Completed</p>
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={statusDonutData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                          {statusDonutData.map((d) => (
                            <Cell key={d.key} fill={STATUS_COLORS[d.key]} />
                          ))}
                        </Pie>
                        <Tooltip />
                        <Legend verticalAlign="bottom" height={24} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {dealerBarData.length > 0 && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 px-1">Top Dealers ({monthLabel})</p>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={dealerBarData} layout="vertical" margin={{ left: 8, right: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="label" width={90} tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Legend verticalAlign="bottom" height={24} />
                        <Bar dataKey="pending" name="Pending" stackId="s" fill={DEALER_BAR_COLORS.pending} radius={[0, 0, 0, 0]} />
                        <Bar dataKey="completed" name="Completed" stackId="s" fill={DEALER_BAR_COLORS.completed} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-x-auto max-h-72 overflow-y-auto">
              <table className="m-scroll w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">Dealer</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Pending</th>
                    <th className="px-3 py-2 text-right">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {dealerGroupRows.map((g) => (
                    <tr key={g.label} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{g.label}</td>
                      <td className="px-3 py-2 text-right font-semibold">{g.total}</td>
                      <td className="px-3 py-2 text-right text-amber-700 dark:text-amber-400">{g.pending}</td>
                      <td className="px-3 py-2 text-right text-emerald-700 dark:text-emerald-400">{g.completed}</td>
                    </tr>
                  ))}
                  {dealerGroupRows.length === 0 && (
                    <tr><td colSpan={4} className="text-center text-slate-400 dark:text-slate-500 py-8">No applications submitted in {monthLabel}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="mt-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-5">
        <div className="mb-4">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">Applications — Last 6 Months</h3>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Submitted, pending and completed, by month</p>
        </div>
        {trendLoading ? (
          <div className="text-center py-8 text-slate-400 text-sm">Loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trendData} margin={{ left: -10, right: 12 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="total" name="Total" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="pending" name="Pending" stroke={STATUS_COLORS.pending} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="completed" name="Completed" stroke={STATUS_COLORS.completed} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-slate-900 dark:bg-slate-700 text-white rounded-xl p-3">
            <Smartphone size={22} />
          </div>
          <div>
            <p className="font-semibold text-slate-800 dark:text-slate-100">Android App</p>
            <p className="text-sm text-slate-400 dark:text-slate-500">
              Version {APP_VERSION} · Direct APK install (not on Play Store)
            </p>
          </div>
        </div>
        <a
          href={APK_PATH}
          download
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors"
        >
          <Download size={16} />
          Download App
        </a>
      </div>

      <div className="mt-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-slate-900 dark:bg-slate-700 text-white rounded-xl p-3">
            <Gamepad2 size={22} />
          </div>
          <div>
            <p className="font-semibold text-slate-800 dark:text-slate-100">1 Infinity Games</p>
            <p className="text-sm text-slate-400 dark:text-slate-500">
              Take a break — play a quick round, no extra login needed
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={openGames}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors"
        >
          <Gamepad2 size={16} />
          Play Now
        </button>
      </div>
    </div>
  );
}
