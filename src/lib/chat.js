// src/lib/chat.js
//
// Thin data layer over the chat_threads / chat_messages tables
// (see server/migrations/002_chat_and_dealer_staff.sql).
//
// A "thread" is either:
//   - general:      { dealer_id, application_id: null }  — one running
//                    conversation per dealer, covers everything.
//   - per-application: { dealer_id, application_id }      — scoped to one
//                    case, opened from that application's row/detail.
//
// Who can read/write a thread is enforced by Postgres RLS (dealer + their
// own sub-staff + our staff — see the migration), this file just calls the
// API; it doesn't itself decide who's allowed to see what.

import { supabase } from "./supabase";
import { fetchAllRows } from "./fetchAll";

// Get (or lazily create) a thread for a dealer, optionally scoped to one
// application. Safe to call repeatedly — unique indexes on chat_threads
// mean concurrent calls converge on the same row.
export async function getOrCreateThread({ dealerId, applicationId = null }) {
  let query = supabase.from("chat_threads").select("*").eq("dealer_id", dealerId);
  query = applicationId ? query.eq("application_id", applicationId) : query.is("application_id", null);
  const { data: existing, error: findError } = await query.maybeSingle();
  if (findError) throw findError;
  if (existing) return existing;

  const { data: created, error: createError } = await supabase
    .from("chat_threads")
    .insert({ dealer_id: dealerId, application_id: applicationId })
    .select()
    .single();
  // Race: someone else created it a moment ago — just fetch it.
  if (createError) {
    const { data: refetched, error: refetchError } = await query.maybeSingle();
    if (refetched) return refetched;
    throw createError || refetchError;
  }
  return created;
}

// Whole conversation, oldest first. Paged: a single request is cut off at
// Supabase's 1000-row cap, and because this list is oldest-first the rows
// that vanished were the NEWEST messages -- a long thread would just stop
// showing new messages.
export async function listMessages(threadId) {
  const { data, error } = await fetchAllRows(() =>
    supabase
      .from("chat_messages")
      .select("*")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
  );
  if (error) throw error;
  return data || [];
}

// Walks messages for the given threads NEWEST FIRST, one page at a time,
// calling visit(message) for each; visit returns true when it has seen
// everything it needs, which stops the walk early (so an active inbox costs
// one page, not the whole table). Used by the "recent chats" lists, which
// previously fetched all messages for all threads in one request and so
// lost rows past the 1000-row cap.
async function walkMessagesNewestFirst(threadIds, columns, visit, { pageSize = 1000, maxPages = 50 } = {}) {
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await supabase
      .from("chat_messages")
      .select(columns)
      .in("thread_id", threadIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const m of data || []) {
      if (visit(m) === true) return;
    }
    if (!data || data.length < pageSize) return;
  }
}

export async function sendMessage({ threadId, sender }) {
  const { error } = await supabase.from("chat_messages").insert({
    thread_id: threadId,
    sender_type: sender.type,   // 'staff' | 'dealer' | 'dealer_staff'
    sender_id: sender.id,
    sender_name: sender.name,
    body: sender.body || null,
    attachment_url: sender.attachmentUrl || null,
    reply_to_id: sender.replyToId || null,
  });
  if (error) throw error;
}

// Uploads an image to the same "application-documents" bucket already used
// for document uploads, under a chat/ prefix, and returns its public URL.
export async function uploadChatAttachment(threadId, file) {
  const path = `chat/${threadId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage.from("application-documents").upload(path, file);
  if (uploadError) throw uploadError;
  const { data } = supabase.storage.from("application-documents").getPublicUrl(path);
  return data.publicUrl;
}

// Live updates for a single thread. Returns an unsubscribe function.
// Uses a unique channel name per call (not just the thread id) so two
// overlapping subscriptions to the same thread — e.g. React 18 dev-mode
// briefly mounting an effect twice — never collide on the same channel
// object and hit "cannot add postgres_changes callbacks after subscribe()".
export function subscribeToThread(threadId, onMessage) {
  const channelName = `chat_messages:${threadId}:${Math.random().toString(36).slice(2)}`;
  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `thread_id=eq.${threadId}` },
      (payload) => onMessage(payload.new)
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Counts application threads whose latest message is from a dealer/dealer_staff
// (i.e. staff hasn't replied yet) — an "awaiting reply" count, NOT a
// personal read/unseen count. No longer used for the sidebar "Chats"
// badge (that's chatUnreadSummary() in lib/serverApi.js now, which tracks
// each individual's own last-read time via chat_thread_reads_by_identity
// and so actually clears when they open a thread). Kept here in case it's
// still useful for a "threads awaiting reply" report/metric — do not wire
// this back into any badge that's supposed to mean "unread for me".
export async function countOpenThreads() {
  const { data: threads, error: threadsError } = await supabase
    .from("chat_threads")
    .select("id")
    .not("application_id", "is", null);
  if (threadsError) throw threadsError;
  const threadIds = (threads || []).map((t) => t.id);
  if (threadIds.length === 0) return 0;

  const { data: messages, error: messagesError } = await supabase
    .from("chat_messages")
    .select("thread_id, sender_type, created_at")
    .in("thread_id", threadIds)
    .order("created_at", { ascending: false });
  if (messagesError) throw messagesError;

  const latestByThread = {};
  for (const m of messages || []) {
    if (!latestByThread[m.thread_id]) latestByThread[m.thread_id] = m;
  }
  return Object.values(latestByThread).filter((m) => m.sender_type !== "staff").length;
}

// Dealer-side counterpart to countOpenThreads: counts this dealer's threads
// (general + per-application) whose latest message came from staff, i.e.
// it's the dealer's turn to reply — an "awaiting reply" count, NOT a
// personal read/unseen count. No longer used for the dealer portal's
// "Chats" tab badge (see countOpenThreads' comment above — same story,
// chatUnreadSummary() in lib/serverApi.js replaced it).
export async function countDealerUnread(dealerId) {
  const { data: threads, error: threadsError } = await supabase
    .from("chat_threads")
    .select("id")
    .eq("dealer_id", dealerId);
  if (threadsError) throw threadsError;
  const threadIds = (threads || []).map((t) => t.id);
  if (threadIds.length === 0) return 0;

  const { data: messages, error: messagesError } = await supabase
    .from("chat_messages")
    .select("thread_id, sender_type, created_at")
    .in("thread_id", threadIds)
    .order("created_at", { ascending: false });
  if (messagesError) throw messagesError;

  const latestByThread = {};
  for (const m of messages || []) {
    if (!latestByThread[m.thread_id]) latestByThread[m.thread_id] = m;
  }
  return Object.values(latestByThread).filter((m) => m.sender_type === "staff").length;
}

// Recent conversations across EVERY dealer, most-recently-active first —
// powers the "Recent" tab of CommsWindow for staff. Unlike countOpenThreads/
// the old StaffChatWidget list, this isn't filtered to "awaiting reply
// only" — it's meant to read like WhatsApp's chat list, not a to-do list.
export async function listRecentThreadsForStaff(limit = 30) {
  const { data: threadRows, error: threadsError } = await supabase
    .from("chat_threads")
    .select("id, application_id, dealer_id, applications(draft_code, application_no, applicant_name, services(parent_service, short_name)), dealers(name, short_name, code)")
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (threadsError) throw threadsError;

  const threadIds = (threadRows || []).map((t) => t.id);
  let latestByThread = {};
  let unreadByThread = {};
  if (threadIds.length) {
    const unreadCountingDone = {};
    let threadsDone = 0;
    await walkMessagesNewestFirst(threadIds, "id, thread_id, sender_type, body, attachment_url, created_at", (m) => {
      if (!latestByThread[m.thread_id]) latestByThread[m.thread_id] = m;
      // Unread = how many messages in a row (most-recent-first) came from
      // someone other than staff, before we hit one staff actually sent —
      // i.e. how many the staff side hasn't replied to yet.
      if (!unreadCountingDone[m.thread_id]) {
        if (m.sender_type === "staff") { unreadCountingDone[m.thread_id] = true; threadsDone++; }
        else unreadByThread[m.thread_id] = (unreadByThread[m.thread_id] || 0) + 1;
      }
      return threadsDone === threadIds.length; // every thread's run is settled
    });
  }

  return (threadRows || []).map((t) => {
    const latest = latestByThread[t.id];
    const service = t.applications?.services;
    return {
      threadId: t.id,
      applicationId: t.application_id,
      dealerId: t.dealer_id,
      label: t.application_id
        ? `${t.applications?.application_no || t.applications?.draft_code || "—"} — ${t.applications?.applicant_name || "—"}`
        : "General",
      applicantName: t.applications?.applicant_name || null,
      serviceLabel: service ? (service.short_name || service.parent_service) : null,
      dealerLabel: t.dealers?.short_name || t.dealers?.name || t.dealers?.code || "—",
      lastMessage: latest?.body || (latest?.attachment_url ? "📎 Attachment" : null),
      lastAt: latest?.created_at || null,
      awaitingReply: latest ? latest.sender_type !== "staff" : false,
      unreadCount: unreadByThread[t.id] || 0,
    };
  });
}

// Recent conversations for ONE dealer (their general thread + every
// per-application thread), most-recently-active first — powers the
// "Recent" tab of CommsWindow for a dealer/dealer_staff login.
export async function listRecentThreadsForDealer(dealerId, limit = 30) {
  const { data: threadRows, error: threadsError } = await supabase
    .from("chat_threads")
    .select("id, application_id, applications(draft_code, application_no, applicant_name, services(parent_service, short_name))")
    .eq("dealer_id", dealerId)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (threadsError) throw threadsError;

  const threadIds = (threadRows || []).map((t) => t.id);
  let latestByThread = {};
  let unreadByThread = {};
  if (threadIds.length) {
    const unreadCountingDone = {};
    let threadsDone = 0;
    await walkMessagesNewestFirst(threadIds, "id, thread_id, sender_type, body, attachment_url, created_at", (m) => {
      if (!latestByThread[m.thread_id]) latestByThread[m.thread_id] = m;
      // Unread here = messages in a row from staff the dealer hasn't replied to yet.
      if (!unreadCountingDone[m.thread_id]) {
        if (m.sender_type !== "staff") { unreadCountingDone[m.thread_id] = true; threadsDone++; }
        else unreadByThread[m.thread_id] = (unreadByThread[m.thread_id] || 0) + 1;
      }
      return threadsDone === threadIds.length;
    });
  }

  return (threadRows || [])
    .map((t) => {
      const latest = latestByThread[t.id];
      const service = t.applications?.services;
      return {
        threadId: t.id,
        applicationId: t.application_id,
        label: t.application_id
          ? `${t.applications?.application_no || t.applications?.draft_code || "—"} — ${t.applications?.applicant_name || "—"}`
          : "General",
        applicantName: t.applications?.applicant_name || null,
        serviceLabel: service ? (service.short_name || service.parent_service) : null,
        lastMessage: latest?.body || (latest?.attachment_url ? "📎 Attachment" : null),
        lastAt: latest?.created_at || null,
        awaitingReply: latest ? latest.sender_type === "staff" : false,
        unreadCount: unreadByThread[t.id] || 0,
      };
    })
    .sort((a, b) => {
      // General thread first, then most recently active.
      if (!a.applicationId !== !b.applicationId) return a.applicationId ? 1 : -1;
      return new Date(b.lastAt || 0) - new Date(a.lastAt || 0);
    });
}

// One thread, in the same { threadId, dealerId, applicationId, label,
// dealerName } shape CommsWindow's thread list hands to openThread() — used
// to open a specific chat straight from a tapped push notification. Returns
// null if the thread doesn't exist or this login can't see it.
export async function getThreadSummary(threadId, variant = "staff") {
  if (!threadId) return null;
  const select = variant === "staff"
    ? "id, application_id, dealer_id, applications(draft_code, application_no, applicant_name), dealers(name, short_name, code)"
    : "id, application_id, dealer_id, applications(draft_code, application_no, applicant_name)";
  const { data: t, error } = await supabase.from("chat_threads").select(select).eq("id", threadId).maybeSingle();
  if (error || !t) return null;
  const dealerLabel = t.dealers?.short_name || t.dealers?.name || t.dealers?.code || null;
  const appLabel = t.application_id
    ? `${t.applications?.application_no || t.applications?.draft_code || "—"} — ${t.applications?.applicant_name || "—"}`
    : null;
  return {
    threadId: t.id,
    dealerId: t.dealer_id,
    applicationId: t.application_id,
    label: appLabel || (variant === "staff" ? (dealerLabel || "General") : "Support Team"),
    dealerName: dealerLabel,
  };
}

// Resolves who's currently logged in, in the shape sendMessage() expects.
// `staff` and `dealer`/`dealerStaff` are whatever App.jsx already has in
// state — this just normalizes them into one sender object.
export function identityFor({ staff, dealer, dealerStaff }) {
  if (staff) return { type: "staff", id: staff.id, name: staff.full_name || "Staff" };
  if (dealerStaff) return { type: "dealer_staff", id: dealerStaff.id, name: dealerStaff.full_name || "Dealer Staff" };
  if (dealer) return { type: "dealer", id: dealer.id, name: dealer.short_name || dealer.name || "Dealer" };
  return null;
}
