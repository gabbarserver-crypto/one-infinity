// api/chat/unread-summary.js
//
// Powers the real "unread since I opened it" badges (sidebar Call/Chat
// count, per-thread numbers in ThreadsTab) — as opposed to
// lib/chat.js's countOpenThreads()/listRecentThreadsForStaff()'s
// unreadCount, which is really an "awaiting reply" heuristic that never
// changes just because someone opened and read a thread.
//
// This is per-INDIVIDUAL, not per-side: it reads chat_thread_reads_by_identity
// (thread_id, reader_type, reader_id, last_read_at) — the same table
// read-receipt.js already writes to every time a chat panel is open — so
// two dealer_staff logins under the same dealer (or two staff members)
// each get their own unread state, not a shared one.
//
// Body: { accessToken }
// Response: { counts: { [threadId]: number }, totalUnreadThreads: number }
//   counts is how many messages in each thread arrived after this caller's
//   own last_read_at for that thread (or all of them, if they've never
//   opened it) and weren't sent by them. totalUnreadThreads is just
//   Object.keys(counts).length, provided pre-computed for the sidebar
//   badge so the client doesn't need to redo that.
import { supabaseAdmin, resolveCaller } from "../_lib/adminAuth.js";
import { applyCors } from "../_lib/cors.js";
import { fetchAllRows } from "../_lib/paging.js";

const ID_CHUNK_SIZE = 200; // thread ids per .in() -- keeps the request URL short
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// "function not found" from PostgREST/Postgres -- i.e. sql/chat_unread_counts.sql
// hasn't been run yet, so use the paged fallback below.
const isMissingRpc = (err) => err && (err.code === "PGRST202" || err.code === "42883" || /could not find the function/i.test(err.message || ""));

export default async function handler(req, res) {
  if (applyCors(req, res)) return; // preflight handled

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!supabaseAdmin) return res.status(500).json({ error: "Server isn't configured with SUPABASE_SERVICE_ROLE_KEY" });

  try {
    const { accessToken } = req.body || {};
    const caller = await resolveCaller(accessToken);
    if (!caller) return res.status(403).json({ error: "Not signed in" });

    // Staff sees every thread (same trust level as elsewhere, e.g.
    // create-qr.js); a dealer/dealer_staff only ever sees their own
    // dealer's threads.
    if (caller.kind !== "staff" && caller.kind !== "dealer" && caller.kind !== "dealer_staff") {
      return res.status(403).json({ error: "Not allowed" });
    }
    const dealerScope = caller.kind === "staff" ? null : caller.dealerId;

    // Preferred path: one SQL aggregate (sql/chat_unread_counts.sql). Nothing
    // is transferred but the final counts, so it doesn't matter how many
    // threads/messages exist and there's no 1000-row cap or URL-length limit.
    const { data: rpcRows, error: rpcErr } = await supabaseAdmin.rpc("chat_unread_counts", {
      p_reader_type: caller.kind,
      p_reader_id: String(caller.id),
      p_dealer_id: dealerScope == null ? null : String(dealerScope),
    });
    if (!rpcErr) {
      const counts = {};
      for (const r of rpcRows || []) counts[r.thread_id] = Number(r.unread);
      return res.json({ counts, totalUnreadThreads: Object.keys(counts).length });
    }
    if (!isMissingRpc(rpcErr)) return res.status(500).json({ error: rpcErr.message });

    // Fallback (RPC not installed yet): the same calculation in JS, but paged
    // and chunked -- every query below used to be a single unpaged request,
    // silently cut off at 1000 rows, with every thread id in one .in() URL.
    const { data: threads, error: threadsErr } = await fetchAllRows(() => {
      let q = supabaseAdmin.from("chat_threads").select("id").order("id");
      if (dealerScope != null) q = q.eq("dealer_id", dealerScope);
      return q;
    });
    if (threadsErr) return res.status(500).json({ error: threadsErr.message });
    const threadIds = (threads || []).map((t) => t.id);
    if (!threadIds.length) return res.json({ counts: {}, totalUnreadThreads: 0 });
    const idChunks = chunk(threadIds, ID_CHUNK_SIZE);

    const lastReadByThread = {};
    const readResults = await Promise.all(
      idChunks.map((ids) =>
        fetchAllRows(() =>
          supabaseAdmin
            .from("chat_thread_reads_by_identity")
            .select("thread_id, last_read_at")
            .eq("reader_type", caller.kind)
            .eq("reader_id", caller.id)
            .in("thread_id", ids)
            .order("thread_id")
        )
      )
    );
    const readsErr = readResults.find((r) => r.error)?.error;
    if (readsErr) return res.status(500).json({ error: readsErr.message });
    for (const r of readResults.flatMap((x) => x.data || [])) lastReadByThread[r.thread_id] = r.last_read_at;

    const messageResults = await Promise.all(
      idChunks.map((ids) =>
        fetchAllRows(() =>
          supabaseAdmin
            .from("chat_messages")
            .select("id, thread_id, sender_type, sender_id, created_at")
            .in("thread_id", ids)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
        )
      )
    );
    const messagesErr = messageResults.find((r) => r.error)?.error;
    if (messagesErr) return res.status(500).json({ error: messagesErr.message });
    const messages = messageResults.flatMap((r) => r.data || []);

    const counts = {};
    for (const m of messages) {
      const isMine = m.sender_type === caller.kind && String(m.sender_id) === String(caller.id);
      if (isMine) continue; // never unread against yourself
      const lastRead = lastReadByThread[m.thread_id];
      if (lastRead && new Date(m.created_at).getTime() <= new Date(lastRead).getTime()) continue;
      counts[m.thread_id] = (counts[m.thread_id] || 0) + 1;
    }

    res.json({ counts, totalUnreadThreads: Object.keys(counts).length });
  } catch (e) {
    console.error("chat unread-summary failed:", e);
    res.status(500).json({ error: e.message || "Unexpected server error" });
  }
}
