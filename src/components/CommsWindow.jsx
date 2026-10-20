// src/components/CommsWindow.jsx
//
// Unified "chat icon" entry point — one floating button that opens a
// mobile-app-style window with its own bottom nav: Recent Chats (general
// per-dealer conversations), Recent Calls (call history), New Call (a
// directory to ring someone you haven't talked to yet), and Customer Chat
// (every per-application conversation, i.e. chats tied to one specific
// applicant's case rather than a dealer's general line). Replaces the two
// separate widgets that used to do this (ChatWidget for the dealer side,
// StaffChatWidget for staff) with one shared component, scoped by
// `variant`.
//
// Recent Chats vs Customer Chat is just a split of the SAME chat_threads
// data by whether application_id is set — see lib/chat.js. No new backend
// concept, just two views onto it: Recent Chats = general dealer-line
// threads, Customer Chat = threads scoped to one applicant's case.
//
// IMPORTANT permission rule, enforced right here in the "New Call" tab:
// a dealer (or their own sub-staff) can ONLY ever see and call admin
// staff — never another dealer, and never another dealer's sub-staff.
// The dealer-variant contact list below is built from a completely
// separate query (`staff` table only) than the staff-variant one, so
// there's no shared code path that could ever leak another dealer into
// it. Admin staff, on the other hand, can call/chat with any dealer or
// dealer_staff — that's the whole point of the support desk.
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useState, forwardRef } from "react";
import { MessageCircle, MessageSquare, Users, UserPlus, Phone, Video, PhoneMissed, PhoneOff, Search, X, Plus, Filter, ChevronRight, Inbox, Wifi } from "lucide-react";
import { supabase } from "../lib/supabase";
import ChatPanel from "./ChatPanel";
import PastelAvatar from "./PastelAvatar";
import { Modal } from "./UI";
import { listRecentThreadsForStaff, listRecentThreadsForDealer } from "../lib/chat";
import { chatUnreadSummary } from "../lib/serverApi";
import { subscribeThreadRead } from "../lib/threadReadBus";
import { startPresence, usePresence, statusForThread, statusOfKey } from "../lib/presence";
import { OnlineDot, StatusLine } from "./Presence";
import { fetchAllCallLogs, fetchCallLogs } from "../lib/callLog";

function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// row.outcome is null while a call is still ringing/in progress — treat
// that (and anything unrecognized) as "missed" for icon purposes.
function callRowMeta(row) {
  if (row.outcome === "answered") {
    return { Icon: row.call_type === "video" ? Video : Phone, color: "text-emerald-600 dark:text-emerald-400", label: "Answered" };
  }
  if (row.outcome === "declined") {
    return { Icon: PhoneOff, color: "text-amber-600 dark:text-amber-400", label: "Declined" };
  }
  return { Icon: PhoneMissed, color: "text-rose-600 dark:text-rose-400", label: "Missed" };
}

function threadLabelFromRow(row) {
  const t = row.chat_threads;
  if (!t) return null;
  const dealerName = t.dealers?.short_name || t.dealers?.name || null;
  const appLabel = t.application_id
    ? `${t.applications?.application_no || t.applications?.draft_code || "—"} — ${t.applications?.applicant_name || "—"}`
    : "General";
  return { threadId: t.id, dealerId: t.dealer_id, applicationId: t.application_id, dealerName, appLabel };
}

// Small pill-style search input reused across tabs, matching the
// reference design's search bars.
function SearchBar({ value, onChange, placeholder }) {
  return (
    <div className="px-4 pt-3 pb-2 shrink-0">
      <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 rounded-xl px-3 py-2">
        <Search size={15} className="text-slate-400 shrink-0" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="bg-transparent text-sm outline-none flex-1 text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
        />
      </div>
    </div>
  );
}

const TABS = [
  { key: "chats", label: "Recent Chats", Icon: MessageSquare },
  { key: "calls", label: "Recent Calls", Icon: Phone },
  { key: "customer", label: "Customer Chat", Icon: Users },
  { key: "online", label: "Online", Icon: Wifi },
];

const TAB_TITLE = { chats: "Recent Chats", unread: "Recent Chats", calls: "Recent Call Logs", new: "New Call", customer: "Customer Chat", online: "Online Now" };

const CommsWindow = forwardRef(function CommsWindow({ variant, identity, call, dealerId, dealerName, staff, pendingCount = 0, onExpand }, ref) {
  const [open, setOpen] = useState(false);
  // Defaults to "unread" (not "chats") — the FAB itself now only shows up
  // once there's something unread (see the FAB block below), so the first
  // thing anyone sees on opening it should be exactly that unread list,
  // not a click away.
  const [tab, setTab] = useState("unread");
  const [selectedThread, setSelectedThread] = useState(null); // { dealerId, applicationId, label } | null
  const [showThreadDetail, setShowThreadDetail] = useState(false);
  const [threadDetail, setThreadDetail] = useState(null);
  const [threadDetailLoading, setThreadDetailLoading] = useState(false);

  // Announce "I'm online" (and keep last-seen fresh) for whoever is signed in.
  // CommsWindow is mounted for staff, dealers and dealer sub-staff alike, so
  // this one spot covers everybody.
  useEffect(() => startPresence(identity, dealerId), [identity?.type, identity?.id, dealerId]);
  const presenceSnap = usePresence();

  // Clicking the name in a thread's header pulls up who you're talking to —
  // for a customer-chat thread (tied to one application) that's the
  // applicant's details + documents; for a general dealer thread there's no
  // single applicant, so it shows the dealer's own contact details instead.
  const loadThreadDetail = async (thread) => {
    if (!thread) return;
    setShowThreadDetail(true);
    setThreadDetailLoading(true);
    setThreadDetail(null);
    if (thread.applicationId) {
      const { data: app } = await supabase
        .from("applications")
        .select("applicant_name, father_husband_name, mobile, address, services(parent_service, short_name)")
        .eq("id", thread.applicationId)
        .maybeSingle();
      const { data: docs } = await supabase
        .from("application_documents")
        .select("id, name, file_url, status")
        .eq("application_id", thread.applicationId);
      setThreadDetail({
        kind: "application",
        name: app?.applicant_name || thread.label,
        phone: app?.mobile || null,
        fatherName: app?.father_husband_name || null,
        address: app?.address || null,
        service: app?.services ? (app.services.short_name || app.services.parent_service) : null,
        docs: docs || [],
      });
    } else if (thread.dealerId) {
      const { data: dealer } = await supabase
        .from("dealers")
        .select("name, short_name, contact_name, mobile, address")
        .eq("id", thread.dealerId)
        .maybeSingle();
      // A general (non-application) thread is shared by the dealer, every
      // active sub-staff login of theirs, AND every one of our staff — see
      // the RLS policy referenced at the top of this file. Surface that
      // full participant list here instead of just the dealer's own
      // contact card, so "who's actually in this conversation" is visible.
      const [{ data: dealerStaffRows }, { data: staffRows }] = await Promise.all([
        supabase.from("dealer_staff").select("id, full_name").eq("dealer_id", thread.dealerId).eq("active", true).order("full_name"),
        supabase.from("staff").select("id, full_name, role").order("full_name"),
      ]);
      setThreadDetail({
        kind: "dealer",
        name: dealer?.short_name || dealer?.name || thread.label,
        phone: dealer?.mobile || null,
        contactName: dealer?.contact_name || null,
        address: dealer?.address || null,
        members: [
          { label: dealer?.short_name || dealer?.name || "Dealer", role: "Dealer" },
          ...(dealerStaffRows || []).map((s) => ({ label: s.full_name, role: "Dealer staff" })),
          ...(staffRows || []).map((s) => ({ label: s.full_name, role: s.role || "Our team" })),
        ],
      });
    }
    setThreadDetailLoading(false);
  };

  // Jumps back to "unread" on every fresh open, not just the first mount —
  // so re-opening later in the session (after browsing some other tab last
  // time) still lands on unread first, matching the FAB only ever
  // appearing when there's unread mail to begin with.
  const openWindow = () => { setTab("unread"); setOpen(true); };
  const closeWindow = () => { setOpen(false); setSelectedThread(null); };

  useImperativeHandle(ref, () => ({
    open: openWindow,
    close: closeWindow,
    isOpen: () => open,
    // Opens the window straight onto one conversation (used when a push
    // notification is tapped). `thread` = { threadId, dealerId,
    // applicationId, label, dealerName }.
    openThread: (thread) => { setOpen(true); setSelectedThread(thread); },
  }));

  // Opening a thread hands it to <ChatPanel/>, which marks it read
  // server-side (see lib/serverApi.js's chatReadReceipt) as soon as it
  // mounts — that's what actually clears this thread's unread badge
  // (ThreadsTab below refetches on that same event via threadReadBus).
  const openThread = (thread) => setSelectedThread(thread);

  if (variant === "staff" && !staff) return null;
  if (variant === "dealer" && !dealerId) return null;

  const headerTitle = selectedThread ? selectedThread.label : TAB_TITLE[tab];
  const headerSubtitle = selectedThread ? (variant === "staff" ? selectedThread.dealerName : null) : null;

  // Shared between the mobile (full-screen) and desktop (small popup)
  // renderings below — same header/body/bottom-nav either way, just a
  // different-sized box around it. `closeLabel` lets the header read
  // "← Back" on the mobile full-screen takeover (where it's the obvious,
  // thumb-reachable way out) vs a plain ✕ on the small desktop popup
  // (where "Back" would be a confusing thing to say about a floating
  // widget).
  const renderPanel = (mobile) => (
    <>
      <div className="bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 px-4 py-3 flex items-center gap-2.5 shrink-0">
        {tab === "new" && !selectedThread ? (
          <button onClick={() => setTab("chats")} className="text-sm font-semibold text-emerald-600 hover:text-emerald-700 shrink-0 mr-1 flex items-center gap-1">
            ← Back
          </button>
        ) : mobile && !selectedThread ? (
          <button onClick={closeWindow} className="text-sm font-semibold text-emerald-600 hover:text-emerald-700 shrink-0 mr-1 flex items-center gap-1">
            ← Back
          </button>
        ) : selectedThread ? (
          <button onClick={() => setSelectedThread(null)} className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 shrink-0 mr-1">
            ← Back
          </button>
        ) : null}
        <div
          className={`min-w-0 flex-1 ${selectedThread ? "cursor-pointer" : ""}`}
          onClick={() => selectedThread && loadThreadDetail(selectedThread)}
        >
          <p className="text-lg font-bold leading-tight truncate text-slate-900 dark:text-slate-100 flex items-center gap-1">
            {headerTitle}
            {selectedThread && <ChevronRight size={15} className="text-slate-300 dark:text-slate-600 shrink-0" />}
          </p>
          {selectedThread && (() => {
            const st = statusForThread(presenceSnap, variant, variant === "staff" ? selectedThread.dealerId : dealerId);
            return (
              <p className="text-xs text-slate-400 leading-tight truncate mt-0.5">
                {headerSubtitle}
                {headerSubtitle && (st.online || st.lastSeen) ? " · " : ""}
                <StatusLine status={st} />
              </p>
            );
          })()}
        </div>
        {onExpand && !selectedThread && (
          <button onClick={onExpand} title="Open full Chats inbox" className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 shrink-0">
            Expand
          </button>
        )}
        {!(mobile && !selectedThread && tab !== "new") && (
          <button onClick={closeWindow} title="Close" className="w-7 h-7 shrink-0 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-500">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {selectedThread ? (
          <ChatPanel
            dealerId={selectedThread.dealerId}
            applicationId={selectedThread.applicationId}
            identity={identity}
            emptyLabel="No messages here yet."
          />
        ) : tab === "chats" ? (
          <ThreadsTab variant={variant} dealerId={dealerId} scope="general" onOpenThread={openThread} onScopeChange={setTab} onNewCall={() => setTab("new")} />
        ) : tab === "unread" ? (
          <ThreadsTab variant={variant} dealerId={dealerId} scope="unread" onOpenThread={openThread} onScopeChange={setTab} onNewCall={() => setTab("new")} />
        ) : tab === "customer" ? (
          <ThreadsTab variant={variant} dealerId={dealerId} scope="application" onOpenThread={openThread} />
        ) : tab === "online" ? (
          <OnlineTab variant={variant} call={call} onOpenThread={openThread} />
        ) : tab === "calls" ? (
          <CallsTab variant={variant} dealerId={dealerId} identity={identity} call={call} onOpenThread={openThread} />
        ) : (
          <NewCallTab variant={variant} identity={identity} call={call} dealerId={dealerId} onOpenThread={openThread} />
        )}
      </div>

      {/* Bottom nav — hidden while a thread is open, same as a phone's tab
          bar disappearing inside a conversation. This is the ONLY bottom
          nav visible while the chat window is open on mobile: it's a
          full-screen overlay (see below), so it sits on top of and fully
          hides the app's main BottomTabBar underneath — no more of the
          two navs stacking on each other. */}
      {!selectedThread && (
        <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 flex" style={mobile ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}>
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 py-2.5 flex flex-col items-center gap-0.5 text-[10px] leading-tight text-center px-0.5 ${
                tab === key ? "text-emerald-600 dark:text-emerald-400 font-bold" : "text-slate-400 dark:text-slate-500 font-medium"
              }`}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );

  return (
    <>
      {open && (
        <>
          {/* Mobile: full-screen takeover — avoids the popup's small
              bottom nav sitting on top of the app's own BottomTabBar. */}
          <div className="no-print md:hidden fixed inset-0 z-50 bg-white dark:bg-slate-900 flex flex-col">
            {renderPanel(true)}
          </div>

          {/* Desktop/tablet: small floating popup above the FAB, unchanged. */}
          <div
            className="no-print hidden md:flex fixed z-50 flex-col items-end"
            style={{ bottom: "calc(1.25rem + env(safe-area-inset-bottom))", right: "calc(1.25rem + env(safe-area-inset-right))" }}
          >
            <div className="w-96 h-[560px] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden mb-3">
              {renderPanel(false)}
            </div>
          </div>
        </>
      )}

      {showThreadDetail && (
        <Modal title={threadDetail?.kind === "dealer" && threadDetail.members?.length > 1 ? "Group Info" : "Details"} onClose={() => setShowThreadDetail(false)}>
          {threadDetailLoading ? (
            <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
          ) : threadDetail ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-y-2 text-sm">
                <span className="text-slate-400 dark:text-slate-500">Name</span>
                <span className="text-slate-800 dark:text-slate-100 font-medium">{threadDetail.name || "—"}</span>

                <span className="text-slate-400 dark:text-slate-500">Phone</span>
                <span className="text-slate-700 dark:text-slate-200 flex items-center gap-2">
                  {threadDetail.phone || "—"}
                  {threadDetail.phone && (
                    <a href={`tel:${threadDetail.phone}`} title={`Call ${threadDetail.phone}`} className="text-emerald-600 hover:text-emerald-700">
                      <Phone size={14} />
                    </a>
                  )}
                </span>

                {threadDetail.kind === "application" && (
                  <>
                    <span className="text-slate-400 dark:text-slate-500">Father/Husband</span>
                    <span className="text-slate-700 dark:text-slate-200">{threadDetail.fatherName || "—"}</span>
                  </>
                )}
                {threadDetail.kind === "dealer" && threadDetail.contactName && (
                  <>
                    <span className="text-slate-400 dark:text-slate-500">Contact Person</span>
                    <span className="text-slate-700 dark:text-slate-200">{threadDetail.contactName}</span>
                  </>
                )}

                <span className="text-slate-400 dark:text-slate-500">Address</span>
                <span className="text-slate-700 dark:text-slate-200">{threadDetail.address || "—"}</span>

                {threadDetail.kind === "application" && (
                  <>
                    <span className="text-slate-400 dark:text-slate-500">Service</span>
                    <span className="text-slate-700 dark:text-slate-200">{threadDetail.service || "—"}</span>
                  </>
                )}
              </div>

              {threadDetail.kind === "dealer" && threadDetail.members?.length > 0 && (
                <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
                  <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase mb-2">
                    Group Members ({threadDetail.members.length})
                  </p>
                  <div className="space-y-0">
                    {threadDetail.members.map((m, i) => (
                      <div key={i} className="flex items-center gap-2.5 py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                        <PastelAvatar name={m.label} size={28} />
                        <span className="text-sm text-slate-700 dark:text-slate-200 flex-1 truncate">{m.label}</span>
                        <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">{m.role}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {threadDetail.kind === "application" && (
                <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
                  <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase mb-2">Documents</p>
                  {threadDetail.docs.length === 0 && <p className="text-sm text-slate-400 dark:text-slate-500">No documents uploaded</p>}
                  {threadDetail.docs.map((d) => (
                    <div key={d.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                      <span className="text-slate-700 dark:text-slate-200">{d.name}</span>
                      <div className="flex items-center gap-2">
                        {d.file_url ? (
                          <a href={d.file_url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 text-xs font-semibold">View</a>
                        ) : (
                          <span className="text-rose-500 text-xs">Missing</span>
                        )}
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {d.status || "Pending"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400 dark:text-slate-500">No details found.</p>
          )}
        </Modal>
      )}

      {/* FAB — mobile no longer shows this at all; opening the chat window
          is now done from the app's own bottom tab bar (Call/Chat), so a
          second floating button would be redundant. Kept for desktop/
          tablet, where there's no bottom tab bar to fold this into — but
          only while there's actually something unread: with nothing
          pending it just sits there as clutter over the page, so it now
          stays hidden until pendingCount says otherwise. While the window
          itself is open this stays hidden regardless (the popup/mobile
          takeover already has its own ✕ in the header), same as before. */}
      <div
        className={`no-print fixed z-50 flex-col items-end ${open || pendingCount <= 0 ? "hidden" : "hidden md:flex"}`}
        style={{ bottom: "calc(1.25rem + env(safe-area-inset-bottom))", right: "calc(1.25rem + env(safe-area-inset-right))" }}
      >
        <button
          onClick={() => (open ? closeWindow() : openWindow())}
          aria-label={open ? "Close chat" : "Open chat"}
          className="relative w-14 h-14 rounded-full bg-emerald-600 text-white shadow-lg flex items-center justify-center hover:bg-emerald-700 transition-colors"
        >
          {open ? <X size={24} /> : <MessageCircle size={24} />}
          {!open && pendingCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-white text-xs font-bold flex items-center justify-center">
              {pendingCount}
            </span>
          )}
        </button>
      </div>
    </>
  );
});

export default CommsWindow;

// Exported so a full-page view (e.g. src/pages/Chats.jsx) can reuse the
// exact same tab bodies — search, avatars, timeAgo, call history, contact
// directory — behind its own top-level tab bar instead of the floating
// window's bottom nav, without duplicating any of this logic.
export { ThreadsTab, CallsTab, NewCallTab, OnlineTab, timeAgo, TABS, TAB_TITLE };

// ============================================================
// Threads tab — powers BOTH "Recent Chats" (scope="general", the dealer's
// one running line) and "Customer Chat" (scope="application", one thread
// per applicant/case). Same underlying data (see lib/chat.js), just
// filtered by whether applicationId is set, with a title/subtitle that
// fits each: dealer name + last message for general, applicant name +
// service for per-application.
// ============================================================
function ThreadsTab({ variant, dealerId, scope, onOpenThread, onScopeChange, onNewCall }) {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  // True personal "unread since I opened it" counts, keyed by threadId —
  // see api/chat/unread-summary.js. This is what actually clears when you
  // open a thread (unlike each row's own t.unreadCount from
  // listRecentThreadsForStaff/Dealer above, which is really an "awaiting
  // reply" count that doesn't change just because someone read it).
  const [unreadCounts, setUnreadCounts] = useState({});
  const presenceSnap = usePresence();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = variant === "staff" ? await listRecentThreadsForStaff(60) : await listRecentThreadsForDealer(dealerId, 60);
      setThreads(rows);
    } catch (e) {
      setError(e.message || "Couldn't load chats");
    } finally {
      setLoading(false);
    }
  }, [variant, dealerId]);

  const loadUnread = useCallback(async () => {
    try {
      const { counts } = await chatUnreadSummary();
      setUnreadCounts(counts || {});
    } catch {
      // Best-effort — a failed refresh just leaves the last-known badges in place.
    }
  }, []);

  useEffect(() => { load(); loadUnread(); }, [load, loadUnread]);
  // The instant any chat panel (including this thread, once opened) marks
  // a thread read, refetch — so the badge on the row you just left clears
  // immediately instead of waiting for a poll.
  useEffect(() => subscribeThreadRead(loadUnread), [loadUnread]);
  // Tab switches inside the popup (chats <-> unread <-> customer) re-render
  // this same ThreadsTab instance with a new `scope`, they don't remount
  // it — so without this, unreadCounts would only ever reflect whatever it
  // was at the very first mount, and a new message arriving while parked
  // on another tab would never surface in "Unread" until *something* got
  // marked read elsewhere. Refetch on every switch into "unread" so it's
  // never more than one tab-away from being current, and also poll every
  // 20s in the background so it stays right even while just sitting open.
  useEffect(() => { if (scope === "unread") loadUnread(); }, [scope, loadUnread]);
  useEffect(() => {
    const id = setInterval(loadUnread, 20000);
    return () => clearInterval(id);
  }, [loadUnread]);

  // "unread" pulls from BOTH scopes (general dealer threads and
  // per-application ones) — it's not a third kind of thread, just a view
  // filtered by this caller's own unreadCounts (see loadUnread above)
  // instead of by application_id. A thread drops out of this list the
  // instant its count clears, which happens optimistically on open (see
  // the onClick handler below) — so opening one removes it from Unread
  // right away instead of waiting on a refetch.
  const scoped = useMemo(() => {
    if (scope === "unread") return threads.filter((t) => (unreadCounts[t.threadId] || 0) > 0);
    return threads.filter((t) => (scope === "application" ? !!t.applicationId : !t.applicationId));
  }, [threads, scope, unreadCounts]);

  // Whether a given row should render as an "application" (customer) row
  // vs a general dealer row — for scope="unread" this is per-row (a mix of
  // both kinds can show up together), for the other two scopes it's fixed.
  const isAppRow = (t) => (scope === "unread" ? !!t.applicationId : scope === "application");

  const titleOf = (t) => (isAppRow(t) ? (t.applicantName || t.label) : (variant === "staff" ? t.dealerLabel : "Support Team"));
  const subtitleOf = (t) => (isAppRow(t) ? (t.serviceLabel || "Service") : (t.lastMessage || "No messages yet"));

  const filtered = scoped.filter((t) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return titleOf(t).toLowerCase().includes(q) || (subtitleOf(t) || "").toLowerCase().includes(q);
  });

  // WhatsApp-style filter chips right under the search bar (All / Unread).
  // Only on the two inbox views — Customer Chat keeps its own plain list.
  const showChips = (scope === "general" || scope === "unread") && !!onScopeChange;
  const unreadThreadCount = threads.filter((t) => (unreadCounts[t.threadId] || 0) > 0).length;
  const showFab = (scope === "general" || scope === "unread") && !!onNewCall;

  const placeholder = scope === "application" ? "Search customers…" : scope === "unread" ? "Search unread…" : "Search chats…";
  const emptyLabel = scope === "application" ? "No customer chats yet." : scope === "unread" ? "No unread chats." : "No conversations yet.";

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <SearchBar value={query} onChange={setQuery} placeholder={placeholder} />
      {showChips && (
        <div className="flex items-center gap-2 px-3 pb-2 shrink-0">
          {[
            { key: "chats", label: "All", active: scope === "general" },
            { key: "unread", label: "Unread", active: scope === "unread", count: unreadThreadCount },
          ].map((c) => (
            <button
              key={c.key}
              onClick={() => onScopeChange(c.key)}
              className={`px-3.5 py-1 rounded-full text-xs font-semibold border flex items-center gap-1.5 transition-colors ${
                c.active
                  ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800"
                  : "bg-transparent text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              {c.label}
              {c.count > 0 && <span className="text-[10px] font-bold">{c.count}</span>}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">Loading…</p>
      ) : error ? (
        <p className="text-sm text-rose-500 text-center py-8 px-4">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8 px-4">{emptyLabel}</p>
      ) : (
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {filtered.map((t) => {
            const title = titleOf(t);
            const subtitle = subtitleOf(t);
            return (
              <button
                key={t.threadId}
                onClick={() => {
                  // Optimistic: clear this row's badge right away rather than
                  // waiting on the round trip to the server + the
                  // threadReadBus refetch it triggers a moment later.
                  setUnreadCounts((prev) => (prev[t.threadId] ? { ...prev, [t.threadId]: 0 } : prev));
                  onOpenThread({ threadId: t.threadId, dealerId: variant === "staff" ? t.dealerId : dealerId, applicationId: t.applicationId, label: isAppRow(t) ? t.label : title, dealerName: t.dealerLabel });
                }}
                className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 flex items-center gap-3"
              >
                <div className="relative shrink-0">
                  <PastelAvatar name={title} size={40} />
                  <OnlineDot online={statusForThread(presenceSnap, variant, variant === "staff" ? t.dealerId : dealerId).online} />
                  {!isAppRow(t) && (
                    <span
                      title="Group chat — dealer, their staff, and our team"
                      className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-emerald-600 text-white flex items-center justify-center border-2 border-white dark:border-slate-900"
                    >
                      <Users size={9} />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{title}</span>
                    {t.lastAt && <span className="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">{timeAgo(t.lastAt)}</span>}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{subtitle}</p>
                </div>
                {(unreadCounts[t.threadId] || 0) > 0 && (
                  <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[11px] font-bold flex items-center justify-center">
                    {unreadCounts[t.threadId]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {showFab && (
        <button
          onClick={onNewCall}
          title="New call"
          aria-label="New call"
          className="absolute bottom-4 right-4 z-10 w-14 h-14 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg flex items-center justify-center"
        >
          <Phone size={22} />
          <Plus size={11} strokeWidth={3} className="absolute top-3 right-3" />
        </button>
      )}
    </div>
  );
}

// ============================================================
// Calls tab — call history, most recent first. Tapping a direct call's
// icon calls that same person back; tapping a thread call jumps into that
// conversation instead (there's no single "person" to call back for one
// of those — see lib/call.js). The funnel icon toggles All / Missed only.
// ============================================================
function CallsTab({ variant, dealerId, identity, call, onOpenThread }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [missedOnly, setMissedOnly] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [menuRowId, setMenuRowId] = useState(null); // which row's Chat/Call popover is open

  const load = useCallback(async () => {
    setLoading(true);
    const { rows: fetched } = variant === "staff" ? await fetchAllCallLogs({ limit: 40 }) : await fetchCallLogs({ dealerId, limit: 40 });
    setRows(fetched);
    setLoading(false);
  }, [variant, dealerId]);

  useEffect(() => {
    load();
    // Channel name must be unique per mount — Supabase caches channels by
    // name, and removeChannel() below is async, so a fixed name here means
    // a fast unmount/remount (e.g. leaving and reopening this tab, or
    // React StrictMode's double-invoke in dev) can hand back the SAME
    // already-subscribed channel object on the next mount. Calling .on()
    // on an already-subscribed channel throws "cannot add postgres_changes
    // callbacks ... after subscribe()", which crashes the whole tree since
    // there's no error boundary — that's the white-screen bug this fixes.
    const channelName = `comms-calls:${variant}:${dealerId || "staff"}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "call_logs" }, load)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [load, variant, dealerId]);

  const visibleRows = missedOnly ? rows.filter((r) => r.outcome !== "answered") : rows;

  // Resolves "Chat" for a row regardless of whether it was a thread call
  // (thread already exists) or a direct call (need to find/derive the
  // dealer the counterpart belongs to before a thread can be opened).
  const openChatWith = async (counterpart, threadInfo) => {
    setMenuRowId(null);
    if (threadInfo) {
      onOpenThread({ threadId: threadInfo.threadId, dealerId: variant === "staff" ? threadInfo.dealerId : dealerId, applicationId: threadInfo.applicationId, label: threadInfo.appLabel, dealerName: threadInfo.dealerName });
      return;
    }
    if (variant !== "staff") {
      // Dealer side: every staff member shares the one "Support Team" thread.
      onOpenThread({ dealerId, applicationId: null, label: "Support Team", dealerName: null });
      return;
    }
    if (counterpart?.type === "dealer") {
      onOpenThread({ dealerId: counterpart.id, applicationId: null, label: counterpart.name, dealerName: counterpart.name });
      return;
    }
    if (counterpart?.type === "dealer_staff") {
      const { data } = await supabase.from("dealer_staff").select("dealer_id, dealers(short_name, name)").eq("id", counterpart.id).maybeSingle();
      if (data?.dealer_id) {
        onOpenThread({ dealerId: data.dealer_id, applicationId: null, label: counterpart.name, dealerName: data.dealers?.short_name || data.dealers?.name });
      }
    }
    // counterpart.type === "staff" (an internal staff-to-staff call) has no
    // dealer thread to open — Chat stays disabled for those rows.
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 pt-3 pb-1 shrink-0 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-400">{missedOnly ? "Missed calls" : "All calls"}</span>
        <div className="relative">
          <button onClick={() => setShowFilter((s) => !s)} className="w-7 h-7 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            <Filter size={15} />
          </button>
          {showFilter && (
            <div className="absolute right-0 top-8 z-10 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 w-32">
              <button onClick={() => { setMissedOnly(false); setShowFilter(false); }} className={`w-full text-left px-3 py-1.5 text-xs ${!missedOnly ? "text-emerald-600 font-semibold" : "text-slate-600 dark:text-slate-300"}`}>All calls</button>
              <button onClick={() => { setMissedOnly(true); setShowFilter(false); }} className={`w-full text-left px-3 py-1.5 text-xs ${missedOnly ? "text-emerald-600 font-semibold" : "text-slate-600 dark:text-slate-300"}`}>Missed only</button>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">Loading…</p>
      ) : visibleRows.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8 px-4">{missedOnly ? "No missed calls." : "No calls yet."}</p>
      ) : (
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {visibleRows.map((r) => {
            const { Icon, color, label } = callRowMeta(r);
            const iAmCaller = identity && r.caller_type === identity.type && r.caller_id === identity.id;
            const counterpart = r.source === "direct"
              ? (iAmCaller ? { type: r.callee_type, id: r.callee_id, name: r.callee_name } : { type: r.caller_type, id: r.caller_id, name: r.caller_name })
              : null;
            const who = r.caller_name || r.callee_name || "Unknown";
            const threadInfo = r.source === "thread" ? threadLabelFromRow(r) : null;
            const canCall = !!counterpart?.id;
            const canChat = !!threadInfo || variant !== "staff" || counterpart?.type === "dealer" || counterpart?.type === "dealer_staff";
            const menuOpen = menuRowId === r.id;

            return (
              <div key={r.id} className="w-full px-4 py-3 flex items-center gap-3 relative">
                <PastelAvatar name={who} size={38} />
                <button
                  onClick={() => setMenuRowId(menuOpen ? null : r.id)}
                  className="min-w-0 flex-1 text-left"
                  title={`Options for ${who}`}
                >
                  <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{who}</p>
                  <div className="flex items-center gap-1.5">
                    <Icon size={13} className={color} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {label}{r.duration_seconds ? ` · ${formatDuration(r.duration_seconds)}` : ""}
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">· {timeAgo(r.started_at)}</span>
                  </div>
                </button>
                {counterpart?.id ? (
                  <button
                    onClick={() => call?.startCall(counterpart, "audio")}
                    disabled={!call || call.status !== "idle"}
                    title={`Call ${who} back`}
                    className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 disabled:opacity-30"
                  >
                    <Phone size={15} />
                  </button>
                ) : threadInfo ? (
                  <button
                    onClick={() => openChatWith(counterpart, threadInfo)}
                    title="Open this chat"
                    className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100"
                  >
                    <MessageSquare size={15} />
                  </button>
                ) : null}

                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuRowId(null)} />
                    <div className="absolute left-12 top-12 z-20 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 w-36">
                      <button
                        onClick={() => { setMenuRowId(null); canChat && openChatWith(counterpart, threadInfo); }}
                        disabled={!canChat}
                        className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <MessageSquare size={13} className="text-emerald-600" /> Chat
                      </button>
                      <button
                        onClick={() => { setMenuRowId(null); canCall && call?.startCall(counterpart, "audio"); }}
                        disabled={!canCall || !call || call.status !== "idle"}
                        className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Phone size={13} className="text-emerald-600" /> Call
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// New Call tab — a directory to ring someone directly (lib/directCall.js),
// not tied to any existing chat thread. Two totally separate branches by
// design (see the file-level comment): a dealer/dealer_staff can ONLY ever
// list and call admin staff here.
// ============================================================
function NewCallTab({ variant, identity, call, dealerId, onOpenThread }) {
  return variant === "staff"
    ? <StaffNewCallList call={call} onOpenThread={onOpenThread} />
    : <DealerNewCallList call={call} dealerId={dealerId} onOpenThread={onOpenThread} />;
}

// Staff can call — or now, message — any dealer, or any of that dealer's
// active sub-staff. Messaging a dealer_staff contact opens that same
// dealer's general thread (dealer_staff folded into 'dealer' for chat too,
// same as it already is for the call log — there's no separate per-staff
// thread), so each contact keeps track of its parent dealer's id for that.
function StaffNewCallList({ call, onOpenThread }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: dealers }, { data: dealerStaff }] = await Promise.all([
        supabase.from("dealers").select("id, name, short_name").order("name"),
        supabase.from("dealer_staff").select("id, full_name, dealer_id, active, dealers(short_name, name)").eq("active", true).order("full_name"),
      ]);
      const combined = [
        ...(dealers || []).map((d) => ({ type: "dealer", id: d.id, name: d.short_name || d.name, sub: "Dealer", dealerId: d.id })),
        ...(dealerStaff || []).map((s) => ({ type: "dealer_staff", id: s.id, name: s.full_name, sub: s.dealers?.short_name || s.dealers?.name || "Dealer staff", dealerId: s.dealer_id })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      setContacts(combined);
      setLoading(false);
    })();
  }, []);

  const filtered = contacts.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || c.sub.toLowerCase().includes(query.toLowerCase()));

  const handleMessage = (c) => onOpenThread?.({ dealerId: c.dealerId, applicationId: null, label: c.name, dealerName: c.sub });

  return <ContactList contacts={filtered} loading={loading} query={query} setQuery={setQuery} call={call} onMessage={onOpenThread ? handleMessage : null} />;
}

// A dealer (or their sub-staff) can ONLY see and call/message admin staff —
// this query never touches the dealers/dealer_staff tables at all, so
// there is no way for a dealer to end up looking at, or ringing, another
// dealer. Every staff contact here shares the SAME one running thread with
// this dealer (see ThreadsTab's "Support Team" general thread) — there's
// no per-staff-member thread — so messaging any of them opens that one
// thread, same as tapping "Recent Chats" would.
function DealerNewCallList({ call, dealerId, onOpenThread }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data } = await supabase.from("staff").select("id, full_name, role").order("full_name");
      setContacts((data || []).map((s) => ({ type: "staff", id: s.id, name: s.full_name, sub: s.role || "Our team" })));
      setLoading(false);
    })();
  }, []);

  const filtered = contacts.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  const handleMessage = () => onOpenThread?.({ dealerId, applicationId: null, label: "Support Team", dealerName: null });

  return (
    <ContactList
      contacts={filtered}
      loading={loading}
      query={query}
      setQuery={setQuery}
      call={call}
      emptyLabel="No team members found."
      onMessage={onOpenThread && dealerId ? handleMessage : null}
    />
  );
}

// Online tab — ONLY who is online right now. Staff see online dealers and
// their sub-staff; a dealer / dealer sub-staff only ever sees online admin
// staff (same permission rule as the New Call tab). Built live from the
// presence channel (lib/presence.js), so people appear / vanish as they
// open / close the app.
function OnlineTab({ variant, call, onOpenThread }) {
  const snap = usePresence();
  const [dealerNames, setDealerNames] = useState({});
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (variant !== "staff") return;
    (async () => {
      const { data } = await supabase.from("dealers").select("id, name, short_name");
      setDealerNames(Object.fromEntries((data || []).map((d) => [String(d.id), d.short_name || d.name])));
    })();
  }, [variant]);

  const contacts = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const e of snap.online) {
      if (seen.has(e.key)) continue; // same person with several tabs open
      seen.add(e.key);
      if (variant === "staff") {
        if (e.type === "staff") continue;
        const dealerName = dealerNames[String(e.dealerId)] || "Dealer";
        list.push({ type: e.type, id: e.id, name: e.name || dealerName, sub: e.type === "dealer" ? "Dealer" : dealerName, dealerId: e.dealerId });
      } else {
        if (e.type !== "staff") continue;
        list.push({ type: "staff", id: e.id, name: e.name || "Staff", sub: "Our team" });
      }
    }
    const q = query.trim().toLowerCase();
    return list
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snap.online, dealerNames, variant, query]);

  const handleMessage = (c) => onOpenThread?.({ dealerId: c.dealerId, applicationId: null, label: c.name, dealerName: c.sub });

  return (
    <ContactList
      contacts={contacts}
      loading={false}
      query={query}
      setQuery={setQuery}
      call={call}
      heading={`Online now · ${contacts.length}`}
      emptyLabel="Abhi koi online nahi hai."
      onMessage={onOpenThread && variant === "staff" ? handleMessage : null}
    />
  );
}

function ContactList({ contacts, loading, query, setQuery, call, emptyLabel = "No contacts found.", onMessage, heading = "All Contacts" }) {
  const presenceSnap = usePresence();
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SearchBar value={query} onChange={setQuery} placeholder="Search contacts…" />
      <p className="px-4 pb-1 text-xs font-semibold text-slate-400">{heading}</p>
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
        {loading ? (
          <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8 px-4">{emptyLabel}</p>
        ) : (
          contacts.map((c) => {
            const st = statusOfKey(presenceSnap, c.type, c.id);
            return (
            <div key={`${c.type}-${c.id}`} className="px-4 py-2.5 flex items-center gap-3">
              <div className="relative shrink-0">
                <PastelAvatar name={c.name} size={36} />
                <OnlineDot online={st.online} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{c.name}</p>
                <p className="text-xs text-emerald-600 dark:text-emerald-400 truncate font-medium">{c.sub}</p>
                <StatusLine status={st} className="text-[11px]" />
              </div>
              <button
                onClick={() => call?.startCall(c, "audio")}
                disabled={!call || call.status !== "idle"}
                title={`Call ${c.name}`}
                className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 hover:bg-emerald-100 disabled:opacity-30"
              >
                <Phone size={15} />
              </button>
              <button
                onClick={() => call?.startCall(c, "video")}
                disabled={!call || call.status !== "idle"}
                title={`Video call ${c.name}`}
                className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-sky-600 bg-sky-50 dark:bg-sky-900/30 hover:bg-sky-100 disabled:opacity-30"
              >
                <Video size={15} />
              </button>
              {onMessage && (
                <button
                  onClick={() => onMessage(c)}
                  title={`Message ${c.name}`}
                  className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-violet-600 bg-violet-50 dark:bg-violet-900/30 hover:bg-violet-100"
                >
                  <MessageSquare size={15} />
                </button>
              )}
            </div>
            );
          })
        )}
      </div>
    </div>
  );
}
