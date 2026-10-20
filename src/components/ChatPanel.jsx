import React, { useEffect, useMemo, useRef, useState } from "react";
import { Send, Image as ImageIcon, Paperclip, MapPin, Smile, ThumbsUp, Phone, PhoneOff, Video, VideoOff, Mic, MicOff, CheckCheck, Reply, X, Volume2, Volume1, CreditCard } from "lucide-react";
import { getOrCreateThread, listMessages, sendMessage, subscribeToThread, uploadChatAttachment } from "../lib/chat";
import { sendPush, chatReadReceipt } from "../lib/serverApi";
import { notifyThreadRead } from "../lib/threadReadBus";
import { useCall } from "../lib/call";
import { openCashfreeHostedCheckout } from "../lib/cashfreeCheckout";
import CallTimer from "./CallTimer";

const SENDER_BUBBLE = {
  staff: "bg-slate-800 text-white",
  dealer: "bg-blue-600 text-white",
  dealer_staff: "bg-blue-600 text-white",
};

const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

// attachment_url doubles for four things now: an actual uploaded file
// (image or otherwise), a Google Maps link for a shared live location (see
// sendLocation below), or a Cashfree hosted-checkout hand-off (see
// buildPaymentAttachmentUrl in StaffQrSendPanel.jsx — used whenever
// create-qr.js couldn't get an embedded UPI QR image and only has a
// paymentSessionId to fall back on). This tells the bubble renderer which
// of the four it's looking at, so it doesn't try to <img> a Maps link or
// treat a payment hand-off as a plain downloadable file.
function attachmentKind(url) {
  if (!url) return null;
  if (/^https:\/\/www\.google\.com\/maps\?q=/.test(url)) return "location";
  if (/^cashfree-pay:/.test(url)) return "payment";
  if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) return "image";
  return "file";
}

// Pulls { paymentSessionId, mode } back out of a "cashfree-pay:<id>?mode=<m>"
// attachment_url — see attachmentKind() above.
function parsePaymentAttachment(url) {
  const m = /^cashfree-pay:([^?]+)(?:\?mode=(\w+))?/.exec(url || "");
  if (!m) return null;
  return { paymentSessionId: m[1], mode: m[2] || "sandbox" };
}

// Uploaded paths are `chat/<threadId>/<timestamp>-<original filename>` —
// strip the timestamp prefix back off for display.
function attachmentFileName(url) {
  try {
    const last = decodeURIComponent(url.split("/").pop().split("?")[0]);
    return last.replace(/^\d+-/, "");
  } catch {
    return "Attachment";
  }
}

// 12-hour clock time for the "Seen by ... at <time>" line — matches the
// kind of timestamp WhatsApp shows, not a full date (this is always
// "today-ish" info glanced at right after sending).
function formatSeenTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

// "Pay Now" bubble for a QR sent while Cashfree's embedded UPI QR image
// wasn't available (some Cashfree accounts don't have the "Order Pay" API
// enabled — see the comment in api/payments/create-qr.js) — the only thing
// that endpoint could hand back that day was a paymentSessionId, good for
// their hosted checkout page but not a static image, so this button
// launches that checkout via the same Cashfree SDK helper the dealer's own
// "Pay by QR" flow already uses (lib/cashfreeCheckout.js) instead of
// silently sending a plain text message with nothing to actually tap.
function PaymentAttachmentButton({ url, mine }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const parsed = parsePaymentAttachment(url);
  if (!parsed) return null;

  const open = async () => {
    setOpening(true);
    setError("");
    try {
      await openCashfreeHostedCheckout(parsed);
    } catch (e) {
      setError(e.message || "Couldn't open the payment page");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={open}
        disabled={opening}
        className={`flex items-center gap-2 rounded-lg px-2.5 py-2 w-full disabled:opacity-60 ${mine ? "bg-white/10" : "bg-slate-100 dark:bg-slate-700"}`}
      >
        <CreditCard size={16} className="shrink-0" />
        <span className="text-xs font-semibold underline">{opening ? "Opening…" : "Pay Now"}</span>
      </button>
      {error && <p className="text-[11px] text-rose-400 mt-1">{error}</p>}
    </div>
  );
}

// Renders the message list + composer for one thread (general dealer thread,
// or one scoped to a single application). Owns thread resolution, initial
// load, and the realtime subscription; the caller just tells it who's
// talking to whom.
export default function ChatPanel({ dealerId, applicationId = null, identity, emptyLabel, onMessage }) {
  const [threadId, setThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [error, setError] = useState("");
  // { staff: isoString|null, dealer: isoString|null } — last time each
  // side read this thread. Drives the double-tick (sent) vs blue-tick
  // (read) color on our own messages. dealer_staff logins fold into the
  // "dealer" side, same as everywhere else in this app.
  const [readStatus, setReadStatus] = useState({ staff: null, dealer: null });
  // Per-person read rows for this thread — [{ type, id, name, lastReadAt }] —
  // what powers the named "Seen by ..." line under our own messages, as
  // opposed to readStatus above which only drives the tick's grey/blue colour.
  const [readers, setReaders] = useState([]);
  // The message the composer is currently drafting a reply to, or null.
  // Cleared once that reply actually sends (or the user backs out of it).
  const [replyingTo, setReplyingTo] = useState(null);
  const bodyRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  // id -> message, so a bubble whose reply_to_id points at something already
  // loaded in this thread can render a quoted preview of it inline.
  const messagesById = useMemo(() => {
    const map = {};
    for (const m of messages) map[m.id] = m;
    return map;
  }, [messages]);
  const call = useCall({ threadId, dealerId, identity });
  const mySide = identity?.type === "staff" ? "staff" : identity?.type ? "dealer" : null;
  const otherSide = mySide === "staff" ? "dealer" : mySide === "dealer" ? "staff" : null;
  // reader_type values that belong to "the other side" — a dealer's own
  // sub-staff logins are a separate reader_type ('dealer_staff') from
  // 'dealer' but still the same side for this purpose.
  const otherReaderTypes = mySide === "staff" ? ["dealer", "dealer_staff"] : mySide === "dealer" ? ["staff"] : [];

  // Whoever ISN'T the sender should hear about this, even if their app is
  // closed. Staff messaging a dealer targets that dealer's own login (the
  // thread is keyed by dealer_id regardless of which of their sub-staff
  // logins actually reads it); a dealer or their sub-staff messaging staff
  // broadcasts to every staff device, since any staff member picks up
  // dealer chats — there's no single "assigned" staff member per thread.
  // threadId rides along in `data` so tapping the notification can open this
  // exact conversation (see lib/pushNav.js).
  const pushForMessage = (preview) => {
    if (!identity) return;
    const data = threadId ? { kind: "chat", threadId } : { kind: "chat" };
    if (identity.type === "staff") {
      sendPush({ targetType: "dealer", targetId: dealerId, title: identity.name || "New message", body: preview, data });
    } else {
      sendPush({ targetType: "all_staff", title: identity.name || "New message", body: preview, data });
    }
  };

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    (async () => {
      if (!dealerId) return;
      setLoading(true);
      setError("");
      setReplyingTo(null); // a reply target from the previous thread can't carry over
      setReaders([]);
      try {
        const thread = await getOrCreateThread({ dealerId, applicationId });
        if (cancelled) return;
        setThreadId(thread.id);
        const existing = await listMessages(thread.id);
        if (cancelled) return;
        setMessages(existing);
        unsubscribe = subscribeToThread(thread.id, (msg) => {
          setMessages((m) => (m.some((x) => x.id === msg.id) ? m : [...m, msg]));
          onMessage?.(msg);
        });
        if (cancelled) unsubscribe(); // effect was torn down mid-flight — don't leak the subscription
      } catch (e) {
        if (!cancelled) setError(e.message || "Couldn't load chat");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dealerId, applicationId]);

  // Coming back to the app: pick up anything missed while it was in the
  // background (the live connection can drop there) — silently, without the
  // loading state, so the open chat doesn't flash or lose its place.
  useEffect(() => {
    if (!threadId) return undefined;
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const fresh = await listMessages(threadId);
        setMessages((cur) => {
          const missing = fresh.filter((f) => !cur.some((x) => x.id === f.id));
          return missing.length ? [...cur, ...missing].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) : cur;
        });
      } catch { /* best-effort */ }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [threadId]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages]);

  // Marks this thread read on open, and re-polls every few seconds while
  // the panel stays open — this is what makes the OTHER side's tick flip
  // grey→blue without needing a Realtime subscription on a second table.
  // Cheap: it's one small request, only while a thread is actually open.
  useEffect(() => {
    if (!threadId || !identity) return;
    let cancelled = false;
    let notified = false;
    const markAndRefresh = async () => {
      try {
        const status = await chatReadReceipt({ threadId, markRead: true });
        if (!cancelled) {
          setReadStatus(status);
          setReaders(status.readers || []);
          // Tell the sidebar badge / thread-list rows to refetch their
          // unread counts right now, instead of sitting stale until their
          // next poll — but only once per open, not every 4s tick.
          if (!notified) {
            notified = true;
            notifyThreadRead(threadId);
          }
        }
      } catch {
        // Non-fatal — ticks just won't update this cycle, no user-facing error needed.
      }
    };
    markAndRefresh();
    const interval = setInterval(markAndRefresh, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [threadId, identity]);

  const send = async (body) => {
    const text = (body ?? draft).trim();
    if (!text || !threadId || !identity) return;
    const replyToId = replyingTo?.id || null;
    setDraft("");
    setShowEmoji(false);
    setReplyingTo(null);
    try {
      await sendMessage({ threadId, sender: { ...identity, body: text, replyToId } });
      pushForMessage(text.length > 120 ? text.slice(0, 117) + "…" : text);
      // No optimistic push needed — the realtime subscription (including our
      // own insert) will bring it back in, keeping a single source of truth.
    } catch (e) {
      setError(e.message || "Couldn't send message");
    }
  };

  // Puts the composer into "replying to this message" mode — swipe/tap-to-
  // reply, WhatsApp-style. The quote travels with whatever's sent next
  // (text, attachment, or location) and clears itself once that happens.
  const startReply = (message) => {
    setReplyingTo(message);
    composerInputRef.current?.focus();
  };
  const cancelReply = () => setReplyingTo(null);

  // Short single-line preview of a message, for the quoted-reply banner and
  // the in-bubble quote — never the full body, just enough to place it.
  const previewFor = (message) => {
    if (!message) return "";
    if (message.body) return message.body.length > 80 ? message.body.slice(0, 77) + "…" : message.body;
    const kind = attachmentKind(message.attachment_url);
    if (kind === "image") return "📷 Photo";
    if (kind === "location") return "📍 Location";
    if (kind === "payment") return "💳 Payment QR — tap to pay";
    if (kind === "file") return `📎 ${attachmentFileName(message.attachment_url)}`;
    return "Message";
  };

  const sendAttachment = async (file) => {
    if (!file || !threadId || !identity) return;
    const replyToId = replyingTo?.id || null;
    setUploading(true);
    setError("");
    setReplyingTo(null);
    try {
      const url = await uploadChatAttachment(threadId, file);
      await sendMessage({ threadId, sender: { ...identity, attachmentUrl: url, replyToId } });
      pushForMessage(file.type?.startsWith("image/") ? "📎 Sent an image" : `📎 Sent a file: ${file.name}`);
    } catch (e) {
      setError(e.message || "Couldn't send attachment");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Shares the sender's current GPS position as a Google Maps link — this
  // is a one-time "here's where I am right now" share (like WhatsApp's
  // "Send your current location"), not a live-updating tracker: it doesn't
  // keep moving after it's sent, and nothing about it lingers once you
  // leave the chat.
  const sendLocation = () => {
    if (!threadId || !identity || !navigator.geolocation) {
      setError("Location isn't available in this browser");
      return;
    }
    setSharingLocation(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
          await sendMessage({ threadId, sender: { ...identity, body: "📍 Shared their current location", attachmentUrl: mapsUrl } });
          pushForMessage("📍 Shared their current location");
        } catch (e) {
          setError(e.message || "Couldn't send location");
        } finally {
          setSharingLocation(false);
        }
      },
      (err) => {
        setSharingLocation(false);
        setError(err.code === err.PERMISSION_DENIED ? "Location permission was denied" : "Couldn't get your location");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <div className="flex flex-col h-full relative">
      {identity && (
        <div className="flex items-center justify-end gap-1 px-2 py-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-white dark:bg-slate-900">
          <button
            onClick={() => call.startCall("audio")}
            disabled={call.status !== "idle" || !threadId}
            title="Voice call"
            className="w-8 h-8 rounded-full flex items-center justify-center text-emerald-600 hover:bg-emerald-50 disabled:opacity-30"
          >
            <Phone size={17} />
          </button>
          <button
            onClick={() => call.startCall("video")}
            disabled={call.status !== "idle" || !threadId}
            title="Video call"
            className="w-8 h-8 rounded-full flex items-center justify-center text-emerald-600 hover:bg-emerald-50 disabled:opacity-30"
          >
            <Video size={17} />
          </button>
        </div>
      )}

      {call.status === "ringing-incoming" && (
        <div className="absolute inset-0 z-20 bg-slate-900 text-white flex flex-col">
          <div className="flex-1 flex flex-col items-center justify-center px-6">
            <div className="w-24 h-24 rounded-full bg-white/10 flex items-center justify-center mb-5 text-3xl font-semibold">
              {(call.remoteName || "?").split(" ").map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}
            </div>
            <p className="text-xl font-semibold mb-1 text-center">{call.remoteName}</p>
            <p className="text-sm text-slate-300">Incoming {call.callType} call…</p>
          </div>
          <div className="flex items-center justify-around px-8 pb-8 pt-3 shrink-0">
            <div className="flex flex-col items-center gap-2">
              <button onClick={call.declineCall} className="w-16 h-16 rounded-full bg-rose-600 active:bg-rose-700 flex items-center justify-center shadow-lg">
                <PhoneOff size={26} />
              </button>
              <span className="text-xs text-slate-300">Decline</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <button onClick={call.acceptCall} className="w-16 h-16 rounded-full bg-emerald-600 active:bg-emerald-700 flex items-center justify-center shadow-lg animate-pulse">
                <Phone size={26} />
              </button>
              <span className="text-xs text-slate-300">Accept</span>
            </div>
          </div>
        </div>
      )}

      {(call.status === "ringing-outgoing" || call.status === "connecting" || call.status === "in-call") && (
        <div className="absolute inset-0 z-20 bg-slate-900 text-white flex flex-col">
          <div className="flex-1 relative flex items-center justify-center">
            {call.callType === "video" ? (
              <>
                <div ref={call.remoteVideoElRef} className="absolute inset-0 bg-slate-800" />
                {!call.hasRemoteVideo && (
                  <p className="text-sm text-slate-300 z-10">
                    {call.status === "in-call" ? "Waiting for their video…" : "Calling…"}
                  </p>
                )}
                {call.status === "in-call" && (
                  <CallTimer answeredAt={call.answeredAt} className="absolute top-2 left-2 z-10 text-[11px] font-semibold bg-black/40 text-white px-1.5 py-0.5 rounded-full" />
                )}
                <div ref={call.localVideoElRef} className="absolute bottom-3 right-3 w-24 h-32 rounded-lg overflow-hidden bg-slate-700 border border-slate-600" />
              </>
            ) : (
              <div className="text-center">
                <div className="w-16 h-16 mx-auto rounded-full bg-white/10 flex items-center justify-center mb-3">
                  <Phone size={26} />
                </div>
                <p className="text-sm font-semibold">
                  {call.status === "ringing-outgoing" ? "Calling…" : call.status === "connecting" ? "Connecting…" : "On call"}
                  {call.status === "in-call" && <CallTimer answeredAt={call.answeredAt} className="ml-1.5 font-normal" />}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-center gap-3 pb-5 pt-2 shrink-0">
            {call.status === "in-call" && (
              <button
                onClick={call.toggleMute}
                className={`w-11 h-11 rounded-full flex items-center justify-center ${call.muted ? "bg-white text-slate-900" : "bg-white/10 hover:bg-white/20"}`}
              >
                {call.muted ? <MicOff size={18} /> : <Mic size={18} />}
              </button>
            )}
            {call.status === "in-call" && (
              <button
                onClick={call.toggleSpeaker}
                title="Handsfree / Speaker"
                className={`w-11 h-11 rounded-full flex items-center justify-center ${call.speakerOn ? "bg-white text-slate-900" : "bg-white/10 hover:bg-white/20"}`}
              >
                {call.speakerOn ? <Volume2 size={18} /> : <Volume1 size={18} />}
              </button>
            )}
            {call.status === "in-call" && call.callType === "video" && (
              <button
                onClick={call.toggleCamera}
                className={`w-11 h-11 rounded-full flex items-center justify-center ${call.cameraOff ? "bg-white text-slate-900" : "bg-white/10 hover:bg-white/20"}`}
              >
                {call.cameraOff ? <VideoOff size={18} /> : <Video size={18} />}
              </button>
            )}
            <button onClick={call.endCall} className="w-11 h-11 rounded-full bg-rose-600 hover:bg-rose-700 flex items-center justify-center">
              <PhoneOff size={18} />
            </button>
          </div>
        </div>
      )}

      {call.callError && (
        <div className="absolute inset-x-0 top-0 z-20 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs px-3 py-1.5 flex items-center justify-between">
          <span>
            {call.callError.friendly}
            {call.callError.raw && <span className="block text-[10px] text-amber-600/70 mt-0.5">Details: {call.callError.raw}</span>}
          </span>
          <button onClick={call.dismissError} className="font-semibold shrink-0">✕</button>
        </div>
      )}

      <div ref={bodyRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50 dark:bg-slate-950">
        {loading ? (
          <p className="text-sm text-slate-400 text-center py-6">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">{emptyLabel || "No messages yet — say hello."}</p>
        ) : (
          messages.map((m) => {
            const mine = identity && m.sender_type === identity.type && m.sender_id === identity.id;
            // Read = the OTHER side's last_read_at is at/after this
            // message's created_at. Falls back to grey (sent, not yet
            // read) whenever we don't have a read timestamp for them yet.
            const otherReadAt = otherSide && readStatus[otherSide];
            const isRead = mine && otherReadAt && new Date(otherReadAt).getTime() >= new Date(m.created_at).getTime();
            const quoted = m.reply_to_id ? messagesById[m.reply_to_id] : null;
            const seenBy = mine
              ? readers.filter(
                  (r) => otherReaderTypes.includes(r.type) && new Date(r.lastReadAt).getTime() >= new Date(m.created_at).getTime()
                )
              : [];
            return (
              <div key={m.id} className={`group flex items-center gap-1 ${mine ? "justify-end" : "justify-start"}`}>
                {mine && (
                  <button
                    onClick={() => startReply(m)}
                    title="Reply"
                    className="w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-slate-400 opacity-40 sm:opacity-0 sm:group-hover:opacity-100 hover:text-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700 transition-opacity"
                  >
                    <Reply size={13} />
                  </button>
                )}
                <div
                  className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                    mine ? SENDER_BUBBLE[m.sender_type] + " rounded-br-sm" : "bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-bl-sm"
                  }`}
                >
                  {!mine && <p className="text-[11px] font-semibold opacity-60 mb-0.5">{m.sender_name}</p>}
                  {m.reply_to_id && (
                    <div
                      className={`mb-1.5 pl-2 border-l-2 rounded-r-md py-1 pr-2 text-xs ${
                        mine ? "border-white/40 bg-white/10" : "border-blue-400 bg-slate-100 dark:bg-slate-700/60"
                      }`}
                    >
                      <p className={`font-semibold ${mine ? "opacity-80" : "text-blue-600 dark:text-blue-400"}`}>
                        {quoted ? quoted.sender_name : "Original message"}
                      </p>
                      <p className={`truncate ${mine ? "opacity-70" : "opacity-70"}`}>{quoted ? previewFor(quoted) : "Message unavailable"}</p>
                    </div>
                  )}
                  {m.attachment_url && attachmentKind(m.attachment_url) === "image" && (
                    <a href={m.attachment_url} target="_blank" rel="noreferrer" className="block mb-1">
                      <img src={m.attachment_url} alt="attachment" className="rounded-lg max-w-full max-h-48 object-cover" />
                    </a>
                  )}
                  {m.attachment_url && attachmentKind(m.attachment_url) === "location" && (
                    <a
                      href={m.attachment_url}
                      target="_blank"
                      rel="noreferrer"
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-2 mb-1 ${mine ? "bg-white/10" : "bg-slate-100 dark:bg-slate-700"}`}
                    >
                      <MapPin size={16} className="shrink-0" />
                      <span className="text-xs font-semibold underline">View location on map</span>
                    </a>
                  )}
                  {m.attachment_url && attachmentKind(m.attachment_url) === "payment" && (
                    <PaymentAttachmentButton url={m.attachment_url} mine={mine} />
                  )}
                  {m.attachment_url && attachmentKind(m.attachment_url) === "file" && (
                    <a
                      href={m.attachment_url}
                      target="_blank"
                      rel="noreferrer"
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-2 mb-1 ${mine ? "bg-white/10" : "bg-slate-100 dark:bg-slate-700"}`}
                    >
                      <Paperclip size={16} className="shrink-0" />
                      <span className="text-xs font-semibold underline truncate">{attachmentFileName(m.attachment_url)}</span>
                    </a>
                  )}
                  {m.body && <p>{m.body}</p>}
                  {mine && (
                    <div className="flex flex-col items-end mt-0.5 gap-0.5">
                      <div title={isRead ? "Read" : "Sent"}>
                        <CheckCheck size={14} className={isRead ? "text-sky-300" : "opacity-50"} />
                      </div>
                      {seenBy.length > 0 && (
                        <p
                          className="text-[10px] leading-tight opacity-70 text-right"
                          title={seenBy.map((r) => `${r.name} — ${formatSeenTime(r.lastReadAt)}`).join("\n")}
                        >
                          Seen by {seenBy.map((r) => `${r.name}, ${formatSeenTime(r.lastReadAt)}`).join(" · ")}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {!mine && (
                  <button
                    onClick={() => startReply(m)}
                    title="Reply"
                    className="w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-slate-400 opacity-40 sm:opacity-0 sm:group-hover:opacity-100 hover:text-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700 transition-opacity"
                  >
                    <Reply size={13} />
                  </button>
                )}
              </div>
            );
          })
        )}
        {uploading && <p className="text-xs text-slate-400 text-right pr-1">Sending attachment…</p>}
        {sharingLocation && <p className="text-xs text-slate-400 text-right pr-1">Getting your location…</p>}
      </div>

      {error && <p className="text-rose-500 text-xs px-3 py-1">{error}</p>}

      {showEmoji && (
        <div className="flex gap-1.5 px-3 pb-1">
          {QUICK_EMOJI.map((e) => (
            <button key={e} onClick={() => send(e)} className="text-lg hover:scale-110 transition-transform">
              {e}
            </button>
          ))}
        </div>
      )}

      {replyingTo && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/70 shrink-0">
          <div className="flex-1 min-w-0 pl-2 border-l-2 border-blue-500">
            <p className="text-[11px] font-semibold text-blue-600 dark:text-blue-400">Replying to {replyingTo.sender_name}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{previewFor(replyingTo)}</p>
          </div>
          <button
            onClick={cancelReply}
            title="Cancel reply"
            className="w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 flex items-center gap-1.5 shrink-0 relative">
        <button
          onClick={() => setShowEmoji((s) => !s)}
          disabled={!identity}
          title="Quick reactions"
          className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
        >
          <Smile size={19} />
        </button>
        <input ref={fileInputRef} type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" hidden onChange={(e) => sendAttachment(e.target.files?.[0])} />

        <div className="relative shrink-0">
          <button
            onClick={() => setShowAttachMenu((s) => !s)}
            disabled={!identity}
            title="Attach"
            className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 ${showAttachMenu ? "bg-slate-100 dark:bg-slate-800" : ""}`}
          >
            <Paperclip size={19} />
          </button>

          {showAttachMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAttachMenu(false)} />
              <div className="absolute bottom-11 left-0 z-20 w-52 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-lg py-1.5">
                <button
                  onClick={() => { setShowAttachMenu(false); fileInputRef.current?.click(); }}
                  disabled={uploading}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40"
                >
                  <ImageIcon size={17} className="text-blue-600" />
                  Photo / File
                </button>
                <button
                  onClick={() => { setShowAttachMenu(false); sendLocation(); }}
                  disabled={sharingLocation}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40"
                >
                  <MapPin size={17} className="text-blue-600" />
                  Location
                </button>
                {identity?.type === "staff" && (
                  <button
                    onClick={() => { setShowAttachMenu(false); setDraft("Please share the OTP you received, so we can proceed with your application."); }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                  >
                    <span className="w-[17px] text-center font-bold text-xs">🔑</span>
                    OTP Required
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <input
          ref={composerInputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
            else if (e.key === "Escape" && replyingTo) cancelReply();
          }}
          placeholder={replyingTo ? "Type your reply…" : "Type your message…"}
          disabled={!identity}
          className="flex-1 text-sm rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 px-3.5 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-slate-100 dark:disabled:bg-slate-900"
        />
        <button
          onClick={() => (draft.trim() ? send() : send("👍"))}
          disabled={!identity}
          className="w-9 h-9 shrink-0 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 disabled:opacity-50"
          aria-label={draft.trim() ? "Send" : "Send thumbs up"}
        >
          {draft.trim() ? <Send size={15} /> : <ThumbsUp size={16} />}
        </button>
      </div>
    </div>
  );
}
