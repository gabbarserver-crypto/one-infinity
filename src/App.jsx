// src/App.jsx
import React, { useEffect, useState, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { StatusBar, Style } from "@capacitor/status-bar";
import { supabase } from "./lib/supabase";
import Sidebar from "./components/Sidebar";
import BottomTabBar, { BOTTOM_TAB_KEYS } from "./components/BottomTabBar";
import Login from "./pages/Login";
import Welcome from "./pages/Welcome";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import Applications, { StaffApplications, StaffDraftApplications, DraftApplications } from "./pages/Applications";
import ApplicationExcel from "./pages/ApplicationExcel";
import Payments from "./pages/Payments";
import Ledger from "./pages/Ledger";import Reports from "./pages/Reports";
import Masters from "./pages/Masters";
import Settings from "./pages/Settings";
import Chats from "./pages/Chats";
import DealerPortal from "./pages/DealerPortal";
import CommsWindow from "./components/CommsWindow";
import GlobalCallOverlay from "./components/GlobalCallOverlay";
import NotificationToaster from "./components/NotificationToaster";
import { useDirectCall } from "./lib/directCall";
import { notify, requestNotificationPermission, primeAudioOnFirstInteraction } from "./lib/notify";
import { registerForPush, unregisterForPush, initPushTapListener } from "./lib/push";
import { onThreadTarget, clearThreadTarget, usePushThreadOpen, requestOpenThread } from "./lib/pushNav";
import { NAV_KEY, readSaved, writeSaved, clearSavedNav } from "./lib/persist";
import { identityFor } from "./lib/chat";
import { isDraftNoticeText } from "./lib/draftChat";
import { chatUnreadSummary } from "./lib/serverApi";
import { subscribeThreadRead } from "./lib/threadReadBus";
import PinUnlock from "./pages/PinUnlock";
import SetupPinPrompt from "./components/SetupPinPrompt";
import { hasPinSetUp, hasBeenPromptedForPin } from "./lib/pinLock";
import PrivacyPolicy from "./pages/legal/PrivacyPolicy";
import TermsAndConditions from "./pages/legal/TermsAndConditions";
import RefundPolicy from "./pages/legal/RefundPolicy";
import ContactUs from "./pages/legal/ContactUs";

// Public, unauthenticated routes — reachable with no login and no session,
// on purpose. This is what payment-gateway KYC verification (Cashfree etc.)
// crawls for: a homepage + footer with these policies not gated behind
// login. Checked first, before any Supabase/auth logic below, so a signed-
// out crawler visiting e.g. /privacy-policy never even sees the Login
// screen.
const LEGAL_ROUTES = {
  "/privacy-policy": PrivacyPolicy,
  "/terms-and-conditions": TermsAndConditions,
  "/refund-policy": RefundPolicy,
  "/contact-us": ContactUs,
};

// Thin wrappers so "Dealer" and "Agency" can be their own sidebar entries
// (each scoped to just that one head + its transaction ledger) while still
// sharing the same Ledger page code and the same "ledger" permission.
function DealerLedgerPage({ initialEntityId, isAdmin }) { return <Ledger only="dealer" initialEntityId={initialEntityId} isAdmin={isAdmin} />; }
function AgencyLedgerPage({ initialEntityId, isAdmin }) { return <Ledger only="agency" initialEntityId={initialEntityId} isAdmin={isAdmin} />; }

const NAV = [
  { key: "dashboard", label: "Dashboard", Component: Dashboard },
  { key: "applications", label: "Applications", Component: Applications },
  { key: "applicationExcel", label: "Application Excel", Component: ApplicationExcel },
  { key: "staffApplications", label: "Applications", Component: StaffApplications },
  { key: "staffDraftApplications", label: "Draft", Component: StaffDraftApplications },
  { key: "draftApplications", label: "Draft", Component: DraftApplications },
  { key: "chats", label: "Call/Chat", Component: Chats },
  { key: "masters", label: "Masters", Component: Masters },
  { key: "payments", label: "Payments", Component: Payments },
  { key: "ledger", label: "Ledger", Component: Ledger },
  { key: "dealerLedger", label: "Dealer", Component: DealerLedgerPage },
  { key: "agencyLedger", label: "Agency", Component: AgencyLedgerPage },
  { key: "reports", label: "Reports", Component: Reports },
  { key: "settings", label: "Settings", Component: Settings },
];

// Each NAV key maps to a `module` value in the `permissions` table — driven
// by role, from Settings → Permissions. "Admin" always sees every tab and
// has full write/approve rights; every other role is gated by its row in
// `permissions` (can_view controls the tab, can_edit controls inline table
// edits, can_approve controls the Approve action).
const MODULE_BY_NAV_KEY = {
  dashboard: "dashboard",
  applications: "applications",
  applicationExcel: "applicationExcel",
  staffApplications: "staffApplications",
  // Same restricted permission row as "Applications" (Staff View) above —
  // a staff role that can see the restricted Applications list gets this
  // restricted Draft tab too, no separate permissions-table row needed.
  staffDraftApplications: "staffApplications",
  // Reuses the "applications" permission row rather than needing its own —
  // anyone who can already view Applications sees this tab too, no new
  // permissions-table row required for existing roles.
  draftApplications: "applications",
  chats: "chats",
  masters: "masters",
  payments: "payments",
  ledger: "ledger",
  dealerLedger: "ledger",
  agencyLedger: "ledger",
  reports: "reports",
  settings: "settings",
};

export default function App() {
  // authStatus: "loading" | "signed-out" | "signed-in"
  const [authStatus, setAuthStatus] = useState("loading");
  // Shown once per browser session (sessionStorage, not localStorage) so a
  // dealer/staff member who signs out and back in during the same visit
  // isn't made to click through it again — but a fresh tab/visit sees it.
  const [showWelcome, setShowWelcome] = useState(() => !sessionStorage.getItem("sjo_welcome_seen"));
  const [staff, setStaff] = useState(null);
  const [dealer, setDealer] = useState(null);
  const [dealerStaff, setDealerStaff] = useState(null); // set only for a dealer sub-staff login
  const [authError, setAuthError] = useState("");
  const [authUserId, setAuthUserId] = useState(null); // Supabase auth user id — stable across staff/dealer/dealer_staff, used to scope the device PIN
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [showPinSetup, setShowPinSetup] = useState(false);
  // A "Open in New Tab" link (see Ledger.jsx) points here as
  // ?nav=dealerLedger&entity=<id> — read once on load so the new tab lands
  // straight on that dealer/agency's ledger instead of the dashboard.
  const initialUrlParams = React.useMemo(() => new URLSearchParams(window.location.search), []);
  // Page to show: an explicit ?nav= link wins, then the page this person was
  // on before a refresh/restart, then the dashboard. (A saved page that isn't
  // allowed for this login is corrected by the visibleNav effect below.)
  const [active, setActive] = useState(() => initialUrlParams.get("nav") || readSaved(NAV_KEY) || "dashboard");
  useEffect(() => {
    writeSaved(NAV_KEY, active);
    // Once they navigate away from the page a ?nav=…&entity=… link opened,
    // drop those params — otherwise a refresh would jump back to the link's
    // page instead of staying on the current one.
    try {
      const url = new URL(window.location.href);
      const linkNav = url.searchParams.get("nav");
      if (linkNav && linkNav !== active) {
        url.searchParams.delete("nav");
        url.searchParams.delete("entity");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
    } catch { /* best-effort */ }
  }, [active]);
  const commsWindowRef = useRef(null);
  const initialEntityId = initialUrlParams.get("entity") || null;
  const [pendingChatCount, setPendingChatCount] = useState(0);
  // Count of applications still sitting in "Draft Submitted" — shown as a
  // badge on the Draft tab, mirroring the Call/Chat unread badge.
  const [pendingDraftCount, setPendingDraftCount] = useState(0);
  const [permMap, setPermMap] = useState({}); // { [module]: permissions row } for the staff member's role
  const roleName = staff?.roles?.role_name || null;
  const isAdmin = roleName === "Admin";

  // Load the role's permission rows whenever the signed-in staff member (or
  // their role) changes. Empty for dealer/dealer-staff logins — DealerPortal
  // has its own tab logic (Dealer vs Dealer Staff) and doesn't use this.
  useEffect(() => {
    if (!staff?.role_id) { setPermMap({}); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("permissions").select("*").eq("role_id", staff.role_id);
      if (cancelled) return;
      const map = {};
      (data || []).forEach((row) => { map[row.module] = row; });
      setPermMap(map);
    })();
    return () => { cancelled = true; };
  }, [staff?.role_id]);

  // Admin bypasses permissions entirely and sees every tab except the
  // restricted "Staff View" (which exists only as the Staff role's
  // column-limited substitute for the full Applications tab).
  const visibleNav = React.useMemo(() => {
    if (!staff) return NAV;
    if (isAdmin) return NAV.filter((n) => n.key !== "staffApplications" && n.key !== "staffDraftApplications");
    return NAV.filter((n) => n.key !== "applicationExcel" && permMap[MODULE_BY_NAV_KEY[n.key]]?.can_view);
  }, [staff, isAdmin, permMap]);

  // If the current tab isn't in the visible set (role changed, or the
  // default "dashboard" isn't permitted for this role), jump to the first
  // tab that is.
  useEffect(() => {
    if (!visibleNav.length) return;
    if (!visibleNav.some((n) => n.key === active)) setActive(visibleNav[0].key);
  }, [visibleNav, active]);

  const activeModule = MODULE_BY_NAV_KEY[active];
  const canEditActive = !staff || isAdmin || !!permMap[activeModule]?.can_edit;
  const canApproveActive = !staff || isAdmin || !!permMap[activeModule]?.can_approve;

  const refreshPendingChatCount = useCallback(async () => {
    try {
      // Real personal "unread since I opened it" count — see
      // api/chat/unread-summary.js. countOpenThreads() (removed) was an
      // "awaiting reply" heuristic keyed off who sent the *last* message,
      // which never moved just because someone opened and read a thread —
      // same bug DealerPortal.jsx already had fixed on the dealer side.
      const { totalUnreadThreads } = await chatUnreadSummary();
      setPendingChatCount(totalUnreadThreads || 0);
    } catch {
      // Best-effort — a failed badge refresh shouldn't be visible to staff,
      // it should just leave the last-known count in place.
    }
  }, []);

  const refreshPendingDraftCount = useCallback(async () => {
    try {
      const { count, error } = await supabase
        .from("applications")
        .select("id", { count: "exact", head: true })
        .eq("status", "Draft Submitted");
      if (error) throw error;
      setPendingDraftCount(count || 0);
    } catch {
      // Best-effort — same as chat count, leave the last-known value in place.
    }
  }, []);

  useEffect(() => {
    if (!staff) return;
    refreshPendingDraftCount();
    const draftInterval = setInterval(refreshPendingDraftCount, 30000);
    return () => clearInterval(draftInterval);
  }, [staff, refreshPendingDraftCount]);

  useEffect(() => {
    if (!staff) return;
    refreshPendingChatCount();

    // A chat can be marked read from the popup, the full Chats page, or an
    // application-chat modal. All of those go through ChatPanel.jsx, which
    // calls notifyThreadRead() on threadReadBus the moment a thread is
    // successfully marked read — listen for that so the sidebar/Call-Chat
    // badge clears immediately instead of waiting for the 30s poll. (This
    // replaces the old "sjo:thread-seen" window event, which nothing in
    // the app dispatches anymore — that was the second half of why this
    // badge never cleared on read.)
    const unsubscribeRead = subscribeThreadRead(refreshPendingChatCount);

    // Recheck periodically...
    const interval = setInterval(refreshPendingChatCount, 30000);
    // ...and immediately whenever any new message comes in anywhere, so the
    // badge doesn't wait up to 30s to reflect a message that just arrived —
    // and pop a toast (+ sound) for it too, as long as it isn't our own
    // message coming back through the realtime feed.
    const channel = supabase
      .channel(`chat_messages:sidebar-badge:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => {
        refreshPendingChatCount();
        const m = payload.new;
        if (m && m.sender_type !== "staff") {
          notify({
            kind: isDraftNoticeText(m.body) ? "draft" : "chat",
            title: m.sender_name || "New message",
            body: m.body || (m.attachment_url ? "Sent an image" : ""),
            onClick: () => requestOpenThread(m.thread_id), // open that exact chat
          });
        }
      })
      .subscribe();
    // New draft applications — a dealer submitting a new application is
    // work staff needs to pick up, so it gets the same toast+sound
    // treatment as an incoming chat message.
    const draftsChannel = supabase
      .channel(`applications:new-draft:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "applications" }, (payload) => {
        const a = payload.new;
        // No separate toast/sound here any more: a dealer-submitted draft
        // opens its own chat thread and posts a message into it (see
        // lib/draftChat.js), and THAT message is what notifies staff — it
        // lands in the Call/Chat window like every other conversation.
        // This only keeps the Draft badge count current.
        if (a?.status === "Draft Submitted") refreshPendingDraftCount();
      })
      .subscribe();
    // New payments — a QR payment landing automatically is work staff
    // needs to see, so it gets the same toast+sound treatment. Payments a
    // staff member just entered themselves (submitted_by: "staff", from
    // Payments.jsx) are skipped — no need to notify someone of their own
    // action. Dealers no longer self-report payments (QR only), so this is
    // effectively gateway-only now.
    const paymentsChannel = supabase
      .channel(`payments:new-payment:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ledger_entries", filter: "entry_type=eq.PAYMENT" },
        (payload) => {
          const p = payload.new;
          if (!p || p.submitted_by === "staff") return;
          const amountLabel = `₹${Number(Math.abs(p.amount) || p.agency_paid_amount || 0).toLocaleString("en-IN")}`;
          notify({
            kind: "payment",
            title: "Payment received (QR)",
            body: `${p.payer_name || "A dealer"} — ${amountLabel}`,
            onClick: () => setActive("payments"),
          });
        }
      )
      .subscribe();
    return () => {
      clearInterval(interval);
      unsubscribeRead();
      supabase.removeChannel(channel);
      supabase.removeChannel(draftsChannel);
      supabase.removeChannel(paymentsChannel);
    };
  }, [staff, refreshPendingChatCount]);

  // Ask for browser/OS notification permission once, right after sign-in —
  // covers the "tab isn't focused" case in lib/notify.js. Harmless no-op on
  // platforms that don't support the Notification API.
  useEffect(() => {
    if (staff || dealer || dealerStaff) requestNotificationPermission();
  }, [staff, dealer, dealerStaff]);

  // Arms the notification-ping AudioContext as soon as the person taps
  // anything — see primeAudioOnFirstInteraction in lib/notify.js for why
  // this matters specifically on the native app (a notification can
  // otherwise arrive silently before any tap has happened).
  useEffect(() => {
    primeAudioOnFirstInteraction();
  }, []);

  // The single source of truth for "are we actually allowed in" —
  // this only ever runs to completion BEFORE we show the Dashboard,
  // so there's no flash-then-logout race.
  // Checks staff first (full admin access), then falls back to dealers
  // (restricted, own-data-only portal). Same login screen serves both.
  const verifySession = useCallback(async (session) => {
    setAuthUserId(session?.user?.id || null);
    if (!session) {
      setStaff(null);
      setDealer(null);
      setDealerStaff(null);
      setAuthStatus("signed-out");
      return;
    }

    const { data: staffRow, error: staffError } = await supabase
      .from("staff")
      .select("id, full_name, role_id, roles(role_name)")
      .eq("auth_user_id", session.user.id)
      .maybeSingle();

    if (staffError) {
      setAuthError("Couldn't verify your profile: " + staffError.message);
      await supabase.auth.signOut();
      setStaff(null); setDealer(null); setDealerStaff(null);
      setAuthStatus("signed-out");
      return;
    }

    if (staffRow) {
      setAuthError("");
      setStaff(staffRow);
      setDealer(null);
      setDealerStaff(null);
      setAuthStatus("signed-in");
      return;
    }

    const { data: dealerRow, error: dealerError } = await supabase
      .from("dealers")
      .select("id, name, short_name, code, credit_limit, contact_name, visible_from_year")
      .eq("auth_user_id", session.user.id)
      .maybeSingle();

    if (dealerError) {
      setAuthError("Couldn't verify your dealer profile: " + dealerError.message);
      await supabase.auth.signOut();
      setStaff(null); setDealer(null); setDealerStaff(null);
      setAuthStatus("signed-out");
      return;
    }

    if (dealerRow) {
      setAuthError("");
      setStaff(null);
      setDealerStaff(null);
      setDealer(dealerRow);
      setAuthStatus("signed-in");
      return;
    }

    // Not a primary dealer login either — check if it's one of a dealer's
    // own sub-staff logins (dealer_staff). Same restricted DealerPortal,
    // scoped to the parent dealer, but messages/identity are their own.
    const { data: dealerStaffRow, error: dealerStaffError } = await supabase
      .from("dealer_staff")
      .select("id, full_name, dealer_id, active, dealers(id, name, short_name, code, credit_limit, contact_name, visible_from_year)")
      .eq("auth_user_id", session.user.id)
      .maybeSingle();

    if (dealerStaffError) {
      setAuthError("Couldn't verify your profile: " + dealerStaffError.message);
      await supabase.auth.signOut();
      setStaff(null); setDealer(null); setDealerStaff(null);
      setAuthStatus("signed-out");
      return;
    }

    if (!dealerStaffRow || !dealerStaffRow.active || !dealerStaffRow.dealers) {
      setAuthError("This account isn't linked to a staff or dealer profile. Contact your admin.");
      await supabase.auth.signOut();
      setStaff(null); setDealer(null); setDealerStaff(null);
      setAuthStatus("signed-out");
      return;
    }

    setAuthError("");
    setStaff(null);
    setDealerStaff({ id: dealerStaffRow.id, full_name: dealerStaffRow.full_name, dealer_id: dealerStaffRow.dealer_id });
    setDealer(dealerStaffRow.dealers);
    setAuthStatus("signed-in");
  }, []);

  const [passwordRecovery, setPasswordRecovery] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => verifySession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      // Supabase fires this when someone lands back on the app via a
      // "Forgot Password" email link — show the reset-password screen
      // instead of routing them into the normal Dashboard/DealerPortal,
      // even though they technically now have a (temporary) session.
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
        return;
      }
      if (event === "SIGNED_OUT") clearSavedNav();
      verifySession(session);
    });
    return () => listener.subscription.unsubscribe();
  }, [verifySession]);

  // Give the status bar its own space instead of letting the WebView draw
  // full-bleed behind it — otherwise on edge-to-edge Android (targetSdk 35+,
  // Android 15+) the OS clock/wifi/battery icons overlap whatever is at the
  // top of the page (e.g. the "Dashboard" title, the sidebar's hamburger
  // button). setOverlaysWebView(false) reserves that strip natively so
  // nothing renders under it, regardless of which screen is showing.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = CapacitorApp.addListener("backButton", () => {
      if (commsWindowRef.current?.isOpen?.()) {
        commsWindowRef.current.close();
        return;
      }
      setActive((current) => {
        if (current !== "dashboard") return "dashboard";
        // Already at Dashboard with nothing else open — let Android do its
        // normal thing (minimize the app) rather than exiting outright,
        // which is what CapacitorApp.exitApp() would do.
        CapacitorApp.minimizeApp?.().catch(() => {});
        return current;
      });
    });
    return () => { sub.then((s) => s.remove()); };
  }, []);

  // Catches Google sign-in's redirect back into the app (see
  // submitWithGoogle in Login.jsx, which opens the Google login as an
  // in-app Custom Tab rather than switching to Chrome). Once Google
  // approves, it redirects to sjoerp://auth-callback#access_token=...,
  // which the AndroidManifest intent-filter routes straight back here.
  // verifySession() above picks up the resulting session automatically via
  // onAuthStateChange, once setSession() below fires it.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const sub = CapacitorApp.addListener("appUrlOpen", async ({ url }) => {
      if (!url.startsWith("sjoerp://auth-callback")) return;

      const hashIndex = url.indexOf("#");
      if (hashIndex === -1) {
        await Browser.close().catch(() => {});
        return;
      }
      const params = new URLSearchParams(url.slice(hashIndex + 1));
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");

      if (access_token && refresh_token) {
        await supabase.auth.setSession({ access_token, refresh_token });
      }
      await Browser.close().catch(() => {});
    });

    return () => { sub.then((s) => s.remove()); };
  }, []);

  // PIN lock gating (keyed on authUserId, not on every verifySession call,
  // so a background token refresh doesn't re-lock an already-unlocked
  // session — only an actual sign-in/sign-out changes authUserId).
  useEffect(() => {
    if (!authUserId) {
      setPinUnlocked(false);
      setShowPinSetup(false);
      return;
    }
    setPinUnlocked(false);
    setShowPinSetup(!hasPinSetUp(authUserId) && !hasBeenPromptedForPin(authUserId));
  }, [authUserId]);

  const userLabel = staff?.full_name || dealer?.name || dealerStaff?.full_name || "there";

  // Tapped push notification -> open that chat. initPushTapListener() runs at
  // startup (before sign-in) so a cold-start tap isn't missed; the request
  // then waits in lib/pushNav.js until the signed-in UI is unlocked.
  const [pushTarget, setPushTarget] = useState(null);
  useEffect(() => { initPushTapListener(); }, []);
  useEffect(() => onThreadTarget(setPushTarget), []);
  const handlePushTargetDone = useCallback(() => { clearThreadTarget(); setPushTarget(null); }, []);
  const lockedByPin = !!authUserId && hasPinSetUp(authUserId) && !pinUnlocked;
  usePushThreadOpen({
    target: staff ? pushTarget : null, // dealer logins are handled inside DealerPortal
    ready: !!staff && !lockedByPin,
    variant: "staff",
    commsRef: commsWindowRef,
    onHandled: handlePushTargetDone,
  });

  // One identity for whoever is signed in — staff, a dealer's own login, or
  // one of a dealer's sub-staff logins. Used both for chat (as before) and
  // now for direct person-to-person calling (see lib/directCall.js). The
  // useDirectCall() listener has to be mounted unconditionally, every
  // render, so it's up here — above the early returns below — otherwise a
  // staff member on, say, the Applications tab would never hear an
  // incoming call ring at all.
  const myIdentity = staff
    ? identityFor({ staff })
    : identityFor({ dealer: dealerStaff ? null : dealer, dealerStaff });
  const directCall = useDirectCall({ identity: myIdentity });

  useEffect(() => {
    if (myIdentity) registerForPush(myIdentity);
    else unregisterForPush();
  }, [myIdentity?.type, myIdentity?.id]);


  const LegalPage = LEGAL_ROUTES[window.location.pathname.replace(/\/$/, "")];
  if (LegalPage) {
    return <LegalPage />;
  }

  if (passwordRecovery) {
    return <ResetPassword onDone={() => { setPasswordRecovery(false); supabase.auth.signOut(); }} />;
  }

  if (authStatus === "loading") {
    return <div className="min-h-screen flex items-center justify-center text-slate-400">Loading…</div>;
  }

  if (authStatus === "signed-out") {
    if (showWelcome) {
      return <Welcome onContinue={() => { sessionStorage.setItem("sjo_welcome_seen", "1"); setShowWelcome(false); }} />;
    }
    return <Login authError={authError} />;
  }

  if (authUserId && hasPinSetUp(authUserId) && !pinUnlocked) {
    return (
      <PinUnlock
        userId={authUserId}
        userLabel={userLabel}
        onUnlocked={() => setPinUnlocked(true)}
        onSignOut={() => supabase.auth.signOut()}
      />
    );
  }

  const pinSetupOverlay = showPinSetup && (
    <SetupPinPrompt userId={authUserId} onDone={() => setShowPinSetup(false)} />
  );

  if (dealer) {
    return (
      <>
        <DealerPortal dealer={dealer} identity={myIdentity} call={directCall} onLogout={() => supabase.auth.signOut()} pushTarget={pushTarget} onPushTargetHandled={handlePushTargetDone} />
        <GlobalCallOverlay call={directCall} />
        <NotificationToaster />
        {pinSetupOverlay}
      </>
    );
  }

  const Active = NAV.find((n) => n.key === active)?.Component || Dashboard;

  return (
    <div className="min-h-screen md:h-screen bg-slate-100 dark:bg-slate-950 flex md:overflow-hidden">
      <Sidebar
        nav={visibleNav.filter((n) => n.key !== "dealerLedger" && n.key !== "agencyLedger")}
        active={active}
        onNavigate={(key) => { setActive(key); refreshPendingChatCount(); refreshPendingDraftCount(); }}
        staff={staff}
        badges={{ chats: pendingChatCount, draftApplications: pendingDraftCount, staffDraftApplications: pendingDraftCount }}
        onLogout={() => supabase.auth.signOut()}
      />
      <main
        className="flex-1 min-w-0 p-8 pb-24 md:pb-8 overflow-y-auto md:h-screen"
        style={{ paddingTop: "calc(2rem + env(safe-area-inset-top, 0px))" }}
      >
        <Active
          staff={staff}
          canEdit={canEditActive}
          canApprove={canApproveActive}
          initialEntityId={initialEntityId}
          call={directCall}
          visibleNav={visibleNav}
          onNavigate={(key) => { setActive(key); refreshPendingChatCount(); refreshPendingDraftCount(); }}
          active={active}
          isAdmin={isAdmin}
        />
      </main>
      <BottomTabBar
        nav={visibleNav}
        active={active}
        onNavigate={(key) => {
          if (key === "chats") { commsWindowRef.current?.open(); return; }
          setActive(key);
          refreshPendingChatCount();
        }}
        badges={{ chats: pendingChatCount, draftApplications: pendingDraftCount, staffDraftApplications: pendingDraftCount }}
      />
      <CommsWindow
        ref={commsWindowRef}
        variant="staff"
        staff={staff}
        identity={myIdentity}
        call={directCall}
        pendingCount={pendingChatCount}
        onExpand={() => setActive("chats")}
      />
      <GlobalCallOverlay call={directCall} />
      <NotificationToaster />
      {pinSetupOverlay}
    </div>
  );
}
