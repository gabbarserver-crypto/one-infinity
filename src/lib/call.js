// src/lib/call.js
//
// Voice/video calling for one chat thread. Two moving parts:
//
//  1. Signaling — a lightweight Supabase Realtime *broadcast* channel per
//     thread (`call:<threadId>`), just for "ring / accept / decline / end"
//     events, and nothing else here is persisted to that channel.
//     A separate, minimal history of each call attempt (answered/missed/
//     declined + duration) is written to the call_logs table via
//     lib/callLog.js — see reset() below and Chats.jsx for where it's read.
//
//  2. Media — Agora RTC (agora-rtc-sdk-ng) carries the actual audio/video
//     once both sides join the same Agora channel (channel name = the chat
//     thread id, so it's already unique and scoped the same way the chat
//     itself is). The join token is minted server-side by /api/agora-token
//     so the Agora App Certificate never reaches the browser.
//
// Usage: const call = useCall({ threadId, identity }); then render based on
// call.status and wire its buttons up — see ChatPanel.jsx.
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, createMicrophoneAudioTrack, createCameraVideoTrack } from "agora-rtc-sdk-ng/esm";
import { supabase } from "./supabase";
import { fetchAgoraToken, sendPush } from "./serverApi";
import { notify, startRingtone, stopRingtone } from "./notify";
import { logCallStart, logCallOutcome } from "./callLog";
import { friendlyCallError } from "./callErrors";
import { setSpeakerphone, resetSpeakerphone } from "./speakerMode";

const RING_TIMEOUT_MS = 30000;

export function useCall({ threadId, dealerId, identity }) {
  // 'idle' | 'ringing-outgoing' | 'ringing-incoming' | 'connecting' | 'in-call'
  const [status, setStatus] = useState("idle");
  const [callType, setCallType] = useState("audio"); // 'audio' | 'video'
  const [remoteName, setRemoteName] = useState("");
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [callError, setCallError] = useState(null);
  // Shown in place of "Calling…" on the full-screen call UI right before it
  // auto-closes — mirrors WhatsApp's brief "Call declined" / "Not answered"
  // message on the caller's own screen instead of an abrupt top-banner toast.
  const [endedReason, setEndedReason] = useState(null);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  // Mirrors answeredAtRef below, purely so the UI (live call-duration timer)
  // can react to it — the ref stays the source of truth for logic inside
  // closures/handlers, this state is read-only for display.
  const [answeredAt, setAnsweredAt] = useState(null);

  // Identity changes reference on every parent render (App.jsx builds it
  // inline), so it's read through a ref inside callbacks/effects instead of
  // being a dependency — otherwise the signaling channel would resubscribe
  // constantly.
  const identityRef = useRef(identity);
  useEffect(() => { identityRef.current = identity; }, [identity]);
  const dealerIdRef = useRef(dealerId);
  useEffect(() => { dealerIdRef.current = dealerId; }, [dealerId]);

  const clientRef = useRef(null);
  const localAudioRef = useRef(null);
  const localVideoRef = useRef(null);
  const ringTimerRef = useRef(null);
  const signalRef = useRef(null);
  const localVideoElRef = useRef(null);  // DOM node the local camera preview plays into
  const remoteVideoElRef = useRef(null); // DOM node the remote video plays into

  // Call-log bookkeeping — only the caller's side writes a row (see
  // logCallStart in callLog.js), so isCallerRef is what tells this instance
  // whether it's the one that should. answeredAtRef marks when the call
  // actually connected, for the duration written on outcome.
  const isCallerRef = useRef(false);
  const logIdRef = useRef(null);
  const answeredAtRef = useRef(null);

  const clearRingTimer = () => {
    if (ringTimerRef.current) { clearTimeout(ringTimerRef.current); ringTimerRef.current = null; }
  };

  const cleanupMedia = useCallback(async () => {
    clearRingTimer();
    try { localAudioRef.current?.close(); } catch { /* already gone */ }
    try { localVideoRef.current?.close(); } catch { /* already gone */ }
    localAudioRef.current = null;
    localVideoRef.current = null;
    if (clientRef.current) {
      try { await clientRef.current.leave(); } catch { /* already left */ }
      clientRef.current.removeAllListeners();
      clientRef.current = null;
    }
    setHasRemoteVideo(false);
  }, []);

  // endReason: 'declined' | 'timeout' | 'ended' — only meaningful for the
  // caller's own log row; ignored otherwise. Anything that never reached
  // 'in-call' is logged as 'missed' unless it was an explicit decline.
  const reset = useCallback(async (endReason) => {
    if (isCallerRef.current && logIdRef.current) {
      const outcome = answeredAtRef.current ? "answered" : endReason === "declined" ? "declined" : "missed";
      logCallOutcome(logIdRef.current, { outcome, answeredAt: answeredAtRef.current });
    }
    isCallerRef.current = false;
    logIdRef.current = null;
    answeredAtRef.current = null;
    setAnsweredAt(null);
    await cleanupMedia();
    setStatus("idle");
    setCallType("audio");
    setRemoteName("");
    setMuted(false);
    setCameraOff(false);
    setSpeakerOn(false);
    resetSpeakerphone();
  }, [cleanupMedia]);

  const send = useCallback((event, payload = {}) => {
    const id = identityRef.current;
    signalRef.current?.send({
      type: "broadcast",
      event,
      payload: { from: id?.id, fromType: id?.type, name: id?.name, ...payload },
    });
  }, []);

  // Stops the ring timer/ringtone right away but keeps the full-screen call
  // UI up for a moment longer, showing `label` instead of "Calling…" — the
  // WhatsApp-style beat before the screen closes on its own. The actual
  // teardown (media, log row, status -> idle) still runs through reset(),
  // just delayed so the message has time to be seen.
  const ENDED_DISPLAY_MS = 1600;
  const finishWithReason = useCallback((endReason, label) => {
    clearRingTimer();
    setEndedReason(label);
    setTimeout(() => {
      setEndedReason(null);
      reset(endReason);
    }, ENDED_DISPLAY_MS);
  }, [reset]);

  const isFromMe = (payload) => {
    const id = identityRef.current;
    return id && payload?.from === id.id && payload?.fromType === id.type;
  };

  // Listen for signaling on this thread — needs to be active even at rest
  // ('idle') so an incoming call can be noticed at all.
  useEffect(() => {
    if (!threadId) return;
    const channel = supabase.channel(`call:${threadId}`, { config: { broadcast: { self: false } } });
    signalRef.current = channel;

    channel
      .on("broadcast", { event: "ring" }, ({ payload }) => {
        if (isFromMe(payload)) return;
        isCallerRef.current = false;
        setStatus((s) => {
          if (s !== "idle") return s;
          notify({
            kind: "call",
            title: payload.name || "Incoming call",
            body: `${payload.callType === "video" ? "Video" : "Voice"} call incoming`,
            silent: true, // the ring banner + accept/decline UI is the notification here
          });
          return "ringing-incoming";
        });
        setCallType(payload.callType || "audio");
        setRemoteName(payload.name || "Caller");
      })
      .on("broadcast", { event: "accept" }, ({ payload }) => {
        if (isFromMe(payload)) return;
        setStatus((s) => (s === "ringing-outgoing" ? "connecting" : s));
      })
      .on("broadcast", { event: "decline" }, ({ payload }) => {
        if (isFromMe(payload)) return;
        finishWithReason("declined", "Call declined");
      })
      .on("broadcast", { event: "end" }, ({ payload }) => {
        if (isFromMe(payload)) return;
        reset("ended");
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); signalRef.current = null; };
  }, [threadId, reset, finishWithReason]);

  // Actually join Agora + publish tracks once we move into 'connecting' —
  // covers both "I just accepted an incoming call" and "the other side just
  // accepted my outgoing call".
  useEffect(() => {
    if (status !== "connecting") return;
    let cancelled = false;
    (async () => {
      try {
        const { token, appId, uid } = await fetchAgoraToken({ threadId });
        const client = createClient({ mode: "rtc", codec: "vp8" });
        clientRef.current = client;

        client.on("user-published", async (user, mediaType) => {
          await client.subscribe(user, mediaType);
          if (mediaType === "video") {
            setHasRemoteVideo(true);
            if (remoteVideoElRef.current) user.videoTrack?.play(remoteVideoElRef.current);
          }
          if (mediaType === "audio") user.audioTrack?.play();
        });
        client.on("user-unpublished", (user, mediaType) => {
          if (mediaType === "video") setHasRemoteVideo(false);
        });
        client.on("user-left", () => reset("ended"));

        await client.join(appId, String(threadId), token, uid || null);
        if (cancelled) { await client.leave(); return; }

        const audioTrack = await createMicrophoneAudioTrack();
        localAudioRef.current = audioTrack;
        const tracks = [audioTrack];

        if (callType === "video") {
          const videoTrack = await createCameraVideoTrack();
          localVideoRef.current = videoTrack;
          if (localVideoElRef.current) videoTrack.play(localVideoElRef.current);
          tracks.push(videoTrack);
        }

        await client.publish(tracks);
        if (!cancelled) {
          answeredAtRef.current = new Date();
          setAnsweredAt(answeredAtRef.current);
          setStatus("in-call");
          const startWithSpeaker = callType === "video";
          setSpeakerOn(startWithSpeaker);
          setSpeakerphone(startWithSpeaker);
        }
      } catch (e) {
        if (!cancelled) {
          // TEMP DEBUG — remove once the "Cannot read properties of
          // undefined (reading 'replace')" crash is root-caused. Nothing
          // upstream of this ever logged the raw error/stack, which is why
          // it never showed up in chrome://inspect — only the friendly
          // banner text did.
          console.error("[call.js] join/publish failed:", e, e?.stack);
          setCallError(friendlyCallError(e));
          reset("ended");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [status, threadId, callType, reset]);

  // Keep the ringtone playing for exactly as long as there's an unanswered
  // incoming call — starts the moment we enter 'ringing-incoming', stops on
  // every other status (accepted, declined, caller hung up, timed out) and
  // on unmount, so it never gets stuck looping in the background.
  useEffect(() => {
    if (status === "ringing-incoming") {
      startRingtone();
      return stopRingtone;
    }
    stopRingtone();
    return undefined;
  }, [status]);

  // Give up on an outgoing call nobody answers.
  useEffect(() => {
    if (status !== "ringing-outgoing") { clearRingTimer(); return undefined; }
    ringTimerRef.current = setTimeout(() => {
      send("end");
      finishWithReason("timeout", "Not answered");
    }, RING_TIMEOUT_MS);
    return clearRingTimer;
  }, [status, send, finishWithReason]);

  const startCall = useCallback((type = "audio") => {
    if (!threadId || !identityRef.current || status !== "idle") return;
    setCallError(null);
    setCallType(type);
    setStatus("ringing-outgoing");
    isCallerRef.current = true;
    answeredAtRef.current = null;
    setAnsweredAt(null);
    logCallStart({ source: "thread", threadId, caller: identityRef.current, callType: type }).then((id) => {
      logIdRef.current = id;
    });
    send("ring", { callType: type });
    // Realtime broadcast above only reaches a device that already has this
    // thread's channel open (app running/foregrounded). A real FCM push is
    // what actually rings a closed/backgrounded app — same staff<->dealer
    // targeting ChatPanel's pushForMessage uses, since a thread has exactly
    // two sides.
    const caller = identityRef.current;
    const callTitle = `${caller.name || "Someone"} is calling`;
    const callBody = `Incoming ${type === "video" ? "video" : "voice"} call`;
    if (caller.type === "staff") {
      sendPush({ targetType: "dealer", targetId: dealerIdRef.current, title: callTitle, body: callBody, data: { kind: "call", threadId } });
    } else {
      sendPush({ targetType: "all_staff", title: callTitle, body: callBody, data: { kind: "call", threadId } });
    }
  }, [threadId, status, send]);

  const acceptCall = useCallback(() => {
    if (status !== "ringing-incoming") return;
    send("accept");
    setStatus("connecting");
  }, [status, send]);

  const declineCall = useCallback(() => {
    if (status !== "ringing-incoming") return;
    send("decline");
    reset("declined");
  }, [status, send, reset]);

  const endCall = useCallback(() => {
    if (status === "idle") return;
    send("end");
    reset("ended");
  }, [status, send, reset]);

  const toggleMute = useCallback(() => {
    if (!localAudioRef.current) return;
    const next = !muted;
    localAudioRef.current.setEnabled(!next);
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    if (!localVideoRef.current) return;
    const next = !cameraOff;
    localVideoRef.current.setEnabled(!next);
    setCameraOff(next);
  }, [cameraOff]);

  const toggleSpeaker = useCallback(() => {
    const next = !speakerOn;
    setSpeakerOn(next);
    setSpeakerphone(next);
  }, [speakerOn]);

  // Hang up if the thread changes or the component using this hook unmounts
  // (e.g. the chat panel/modal closes) — never leave a call running silently.
  useEffect(() => () => { cleanupMedia(); stopRingtone(); }, [threadId, cleanupMedia]);

  return {
    status, callType, remoteName, muted, cameraOff, speakerOn, callError, endedReason, hasRemoteVideo, answeredAt,
    localVideoElRef, remoteVideoElRef,
    startCall, acceptCall, declineCall, endCall, toggleMute, toggleCamera, toggleSpeaker,
    dismissError: () => setCallError(null),
  };
}
