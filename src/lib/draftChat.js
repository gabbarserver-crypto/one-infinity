// src/lib/draftChat.js
//
// A new draft application gets its OWN chat thread (one per application), and
// the "new application submitted" note is posted into it as the dealer's
// first message. That one message does all the notifying: it shows up in
// staff's Call/Chat window (Customer Chat / Unread), raises the in-app toast
// + sound, and sends a real push whose tap opens exactly this conversation
// (see lib/pushNav.js). The dealer then keeps talking to staff in that same
// thread. Best-effort — a failure here must never block creating the draft.
import { getOrCreateThread, sendMessage } from "./chat";
import { sendPush } from "./serverApi";

// The first message posted into a new draft's thread starts with this text
// (see DealerPortal's postApplicationNotice calls). The in-app listeners use it
// to tell "new draft" apart from an ordinary chat message, so the two can be
// switched on/off separately in Settings -> Notifications.
export const isDraftNoticeText = (text) => /^New application submitted/i.test(text || "");

export async function postApplicationNotice({ dealerId, applicationId, identity, text }) {
  try {
    const thread = await getOrCreateThread({ dealerId, applicationId: applicationId || null });
    await sendMessage({ threadId: thread.id, sender: { ...identity, body: text } });
    sendPush({
      targetType: "all_staff",
      title: identity?.name || "New message",
      body: text,
      data: { kind: "draft", threadId: thread.id },
    });
    return thread;
  } catch {
    return null;
  }
}
