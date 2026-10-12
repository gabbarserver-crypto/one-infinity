// src/lib/directCall.js
//
// Person-to-person calling — "call this specific dealer / dealer's staff /
// admin staff member by name" — as opposed to lib/call.js, which rings on
// a *chat thread* and only works while both sides already have that exact
// thread's ChatPanel open.
//
// The problem this solves: a dealer's staff member wants to call a named
// admin staff member (or vice versa) straight from a list, without both
// people having to already be looking at the same chat. For that to work,
// the person being called has to be reachable no matter what screen they're
// on — so each signed-in identity (staff / dealer / dealer_staff) keeps a
// permanent "personal channel" open for as long as they're logged in
// (`personal-call:<type>:<id>`), not just while some particular page is
// open. useDirectCall() is mounted once, at the top of App.jsx, for exactly
// that reason — see GlobalCallOverlay.jsx for how it's rendered.
//
// Once a call is answered, both sides move onto a call-specific Agora
// channel (a session id minted by the caller) for the actual audio/video —
// same Agora mechanics as lib/call.js.
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, createMicrophoneAudioTrack, createCameraVideoTrack } from "agora-rtc-sdk-ng/esm";
import { supabase } from "./supabase";
import { fetchAgoraToken, sendPush } from "./serverApi";
import { notify, startRingtone, stopRingtone } from "./notify";
import { logCallStart, logCallOutcome } from "./callLog";
import { friendlyCallError } from "./callErrors";
import { setSpeakerphone, resetSpeakerphone } from "./speakerMode";

const RING_TIMEOUT_MS = 30000;

function personalChannelName(identity) {
  return identity ? `personal-call:${identity.type}:${identity.id}` : null;
}

export function useDirectCall({ identity }) {
  // 'idle' | 'ringing-outgoing' | 'ringing-incoming' | 'connecting' | 'in-call'
  const [status, setStatus] = useState("idle");
  const [callType, setCallType] = useState("audio");
  const [remoteName, setRemoteName] = useState("");
  const [remoteIdentity, setRemoteIdentity] = useState(null); // { type, id }
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [callError, setCallError] = useState(null);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  // Mirrors answeredAtRef below, purely so the UI (the live call-duration
  // timer) can react to it — the ref stays the source of truth for logic
  // inside closures/handlers, this state is read-only for display.
  const [answeredAt, setAnsweredAt] = useState(null);

  const identityRef = useRef(identity);
  useEffect(() => { identityRef.current = identity; }, [identity]);

  const sessionIdRef = useRef(null);
  const remoteIdentityRef = useRef(null);
  const clientRef = useRef(null);
  const localAudioRef = useRef(null);
  const localVideoRef = useRef(null);
  const ringTimerRef = useRef(null);
  const localVideoElRef = useRef(null);
  const remoteVideoElRef = useRef(null);

  // Call-log bookkeeping — same scheme as lib/call.js: only the caller's
  // side writes a row, isCallerRef says whether this instance is it.
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
    sessionIdRef.current = null;
    remoteIdentityRef.current = null;
    setStatus("idle");
    setCallType("audio");
    setRemoteName("");
    setRemoteIdentity(null);
    setMuted(false);
    setCameraOff(false);
    setSpeakerOn(false);
    resetSpeakerphone();
  }, [cleanupMedia]);

  // One-shot send to the OTHER party's personal channel. `to` is their
  // { type, id } — known upfront (from the directory list the call was
  // started from, or from the incoming ring's payload).
  const sendTo = useCallback((to, event, payload = {}) => {
    if (!to?.type || !to?.id) return;
    const id = identityRef.current;
    const channel = supabase.channel(personalChannelName(to), { config: { broadcast: { self: false } } });
    channel.subscribe((s) => {
      if (s !== "SUBSCRIBED") return;
      channel.send({
        type: "broadcast",
        event,
        payload: { from: id?.id, fromType: id?.type, fromName: id?.name, sessionId: sessionIdRef.current, ...payload },
      });
      setTimeout(() => supabase.removeChannel(channel), 800);
    });
  }, []);

  // Always-on listener on MY OWN personal channel — active for as long as
  // this identity is signed in, regardless of which screen is open. This is
  // what makes an incoming call possible from anywhere in the app.
  useEffect(() => {
    if (!identity) return;
    const channel = supabase.channel(personalChannelName(identity), { config: { broadcast: { self: false } } });

    channel
      .on("broadcast", { event: "ring" }, ({ payload }) => {
        setStatus((s) => {
          if (s !== "idle") return s; // already on a call — no call-waiting for now
          isCallerRef.current = false;
          sessionIdRef.current = payload.sessionId;
          remoteIdentityRef.current = { type: payload.fromType, id: payload.from };
          setCallType(payload.callType || "audio");
          setRemoteName(payload.fromName || "Caller");
          setRemoteIdentity(remoteIdentityRef.current);
          notify({
            kind: "call",
            title: payload.fromName || "Incoming call",
            body: `${payload.callType === "video" ? "Video" : "Voice"} call incoming`,
            silent: true, // the ring banner + accept/decline UI is the notification here
          });
          return "ringing-incoming";
        });
      })
      .on("broadcast", { event: "accept" }, ({ payload }) => {
        if (payload.sessionId !== sessionIdRef.current) return;
        setStatus((s) => (s === "ringing-outgoing" ? "connecting" : s));
      })
      .on("broadcast", { event: "decline" }, ({ payload }) => {
        if (payload.sessionId !== sessionIdRef.current) return;
        setCallError({ friendly: "Call declined", raw: "" });
        reset("declined");
      })
      .on("broadcast", { event: "end" }, ({ payload }) => {
        if (payload.sessionId !== sessionIdRef.current) return;
        reset("ended");
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.type, identity?.id, reset]);

  // Join Agora once we move into 'connecting'.
  useEffect(() => {
    if (status !== "connecting") return;
    let cancelled = false;
    (async () => {
      try {
        const peer = remoteIdentityRef.current;
        // The server derives the channel name from (me, peer, sessionId) and
        // only hands it to the two participants -- so use the name it
        // returns rather than the raw session id.
        const { token, appId, uid, channel: channelName } = await fetchAgoraToken({
          sessionId: sessionIdRef.current,
          peerType: peer?.type,
          peerId: peer?.id,
        });
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

        await client.join(appId, String(channelName), token, uid || null);
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
          console.error("[directCall.js] join/publish failed:", e, e?.stack);
          setCallError(friendlyCallError(e));
          reset("ended");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [status, callType, reset]);

  // Keep the ringtone playing for exactly as long as there's an unanswered
  // incoming call — see the matching effect in lib/call.js for why this is
  // needed: the ring banner's own notify() call is silent, so without this
  // an incoming call makes no sound at all unless you're staring at the
  // screen already.
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
      sendTo(remoteIdentityRef.current, "end");
      setCallError({ friendly: "No answer", raw: "" });
      reset("timeout");
    }, RING_TIMEOUT_MS);
    return clearRingTimer;
  }, [status, sendTo, reset]);

  // target = { type, id, name } — a row from the Dealers list, a
  // dealer_staff row, or an admin staff row.
  const startCall = useCallback((target, type = "audio") => {
    if (!identityRef.current || status !== "idle" || !target?.id || !target?.type) return;
    setCallError(null);
    // Only a value both sides agree matches *this* call attempt -- a plain
    // random UUID is enough. It is NOT the Agora channel name any more: the
    // server derives that from (both participants + this id) when each side
    // asks for a token (see api/agora-token.js), so nobody who isn't on the
    // call can get a token for it.
    sessionIdRef.current = crypto.randomUUID();
    remoteIdentityRef.current = { type: target.type, id: target.id };
    setCallType(type);
    setRemoteName(target.name || "");
    setRemoteIdentity(remoteIdentityRef.current);
    setStatus("ringing-outgoing");
    isCallerRef.current = true;
    answeredAtRef.current = null;
    setAnsweredAt(null);
    logCallStart({ source: "direct", caller: identityRef.current, callee: target, callType: type }).then((id) => {
      logIdRef.current = id;
    });
    sendTo(target, "ring", { callType: type });
    sendPush({
      targetType: target.type,
      targetId: target.id,
      title: identityRef.current.name || "Incoming call",
      body: `${type === "video" ? "Video" : "Voice"} call from ${identityRef.current.name || "someone"}`,
      data: { kind: "call" },
    });
  }, [status, sendTo]);

  const acceptCall = useCallback(() => {
    if (status !== "ringing-incoming") return;
    sendTo(remoteIdentityRef.current, "accept");
    setStatus("connecting");
  }, [status, sendTo]);

  const declineCall = useCallback(() => {
    if (status !== "ringing-incoming") return;
    sendTo(remoteIdentityRef.current, "decline");
    reset("declined");
  }, [status, sendTo, reset]);

  const endCall = useCallback(() => {
    if (status === "idle") return;
    sendTo(remoteIdentityRef.current, "end");
    reset("ended");
  }, [status, sendTo, reset]);

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

  // Hang up if this hook ever unmounts (e.g. sign-out) — never leave a call
  // running silently.
  useEffect(() => () => { cleanupMedia(); stopRingtone(); }, [cleanupMedia]);

  return {
    status, callType, remoteName, remoteIdentity, muted, cameraOff, speakerOn, callError, hasRemoteVideo, answeredAt,
    localVideoElRef, remoteVideoElRef,
    startCall, acceptCall, declineCall, endCall, toggleMute, toggleCamera, toggleSpeaker,
    dismissError: () => setCallError(null),
  };
}
