// api/_lib/access.js
//
// Shared authorization rules for the endpoints that act on behalf of a
// signed-in caller (api/send-push.js, api/agora-token.js). Not a route --
// files/folders starting with "_" are ignored by Vercel's file routing.
//
// The trust model matches the rest of the API (read-receipt.js,
// unread-summary.js): staff can reach anyone / any thread; a dealer or
// dealer_staff can only reach admin staff and threads of their own dealer.
// That is also exactly what the UI offers (DealerNewCallList only lists
// staff; ChatPanel only pushes to all_staff).
import { createHmac } from "node:crypto";
import { supabaseAdmin } from "./adminAuth.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeId = (v) => (typeof v === "string" || typeof v === "number") && SAFE_ID.test(String(v));

export const PEER_TABLES = { staff: "staff", dealer: "dealers", dealer_staff: "dealer_staff" };

// Can `caller` notify / ring this target?
export function canReach(caller, targetType, targetId) {
  if (!caller) return false;
  if (caller.kind === "staff") {
    return targetType === "all_staff" || Object.prototype.hasOwnProperty.call(PEER_TABLES, targetType);
  }
  if (caller.kind === "dealer" || caller.kind === "dealer_staff") {
    // Dealer-side logins only ever talk to the admin team.
    return targetType === "all_staff" || targetType === "staff";
  }
  return false;
}

// Is `caller` allowed into this chat thread? Staff: any existing thread.
// Dealer / dealer_staff: only threads belonging to their own dealer.
export async function callerCanAccessThread(caller, threadId) {
  if (!caller || !supabaseAdmin || !isSafeId(threadId)) return false;
  const { data: thread, error } = await supabaseAdmin
    .from("chat_threads")
    .select("id, dealer_id")
    .eq("id", String(threadId))
    .maybeSingle();
  if (error || !thread) return false;
  if (caller.kind === "staff") return true;
  if (caller.kind === "dealer" || caller.kind === "dealer_staff") {
    return !!caller.dealerId && String(thread.dealer_id) === String(caller.dealerId);
  }
  return false;
}

export async function peerExists(type, id) {
  const table = PEER_TABLES[type];
  if (!table || !supabaseAdmin || !isSafeId(id)) return false;
  const { data, error } = await supabaseAdmin.from(table).select("id").eq("id", String(id)).maybeSingle();
  return !error && !!data;
}

// Direct (person-to-person) calls have no server-side record, so the
// Agora channel name is derived instead of client-chosen: an HMAC over both
// participants' identities plus the caller's session id, keyed with a
// server-only secret. Both sides ask for it with (peer, sessionId) and get
// the same name; a third party cannot request it because the caller's own
// identity is always part of the input, and they can't forge someone else's.
export function directChannelName(secret, a, b, sessionId) {
  const [x, y] = [`${a.type}:${a.id}`, `${b.type}:${b.id}`].sort();
  const mac = createHmac("sha256", secret).update(`direct|${x}|${y}|${sessionId}`).digest("hex");
  return `dc_${mac.slice(0, 40)}`; // 43 chars; Agora's limit is 64
}
