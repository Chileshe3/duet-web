import { WebRtcClient } from "./webrtcclient.js";
import * as CallRepo from "./call.js";

const RING_TIMEOUT_MS = 30_000;

/**
 * Usage:
 *   const controller = new CallController({ myUid, onStateChange: renderCallOverlay });
 *   controller.startListeningForIncomingCalls(resolveCallerName);
 *   controller.startCall(coupleId, calleeUid, calleeName);
 *
 * state.status is one of: "idle" | "outgoing" | "incoming" | "connecting" | "connected" | "ended"
 */
export class CallController {
  constructor({ myUid, onStateChange }) {
    this.myUid = myUid;
    this.onStateChange = onStateChange;
    this.state = { status: "idle" };

    this.rtcClient = null;
    this.callId = null;
    this.isCaller = false;
    this.peerName = "Partner";

    this.remoteAudioEl = document.createElement("audio");
    this.remoteAudioEl.autoplay = true;
    document.body.appendChild(this.remoteAudioEl);

    this.unsubIncoming = null;
    this.unsubCall = null;
    this.unsubCandidates = null;
    this.durationTimer = null;
    this.ringTimeoutTimer = null;
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.state);
  }

  /** resolveCallerName(callerUid) => Promise<string> — call once, e.g. right after pairing completes. */
  startListeningForIncomingCalls(resolveCallerName) {
    if (this.unsubIncoming) return;
    this.unsubIncoming = CallRepo.observeIncomingCalls(this.myUid, async (call) => {
      if (call && this.state.status === "idle") {
        this.callId = call.id;
        this.isCaller = false;
        this.peerName = (await resolveCallerName(call.callerUid)) || "Partner";
        this._setState({ status: "incoming", peerName: this.peerName });
      } else if (!call && this.state.status === "incoming") {
        // The ringing call doc dropped out of this query because its status moved away
        // from "ringing". If we're still showing "incoming", the caller ended/cancelled
        // before we answered — not that we accepted (accepting moves state to "connecting"
        // synchronously before that status change even reaches Firestore, so this branch
        // can't fire for a call we're actually answering).
        this._cleanup("Missed call");
      }
    });
  }

  async startCall(coupleId, calleeUid, calleeName) {
    if (this.state.status !== "idle") return;
    this.isCaller = true;
    this.peerName = calleeName;
    this._setState({ status: "outgoing", peerName: calleeName });

    try {
      this.rtcClient = this._buildClient();
      await this.rtcClient.initialize();
      const offer = await this.rtcClient.createOffer();
      this.callId = await CallRepo.createCall(coupleId, this.myUid, calleeUid, offer.sdp);
      this._listenForCallDocChanges();
      this._listenForRemoteCandidates();
    } catch (e) {
      console.error("Failed to start call", e);
      this._cleanup("Couldn't access microphone");
      return;
    }

    clearTimeout(this.ringTimeoutTimer);
    this.ringTimeoutTimer = setTimeout(() => {
      // Still ringing/negotiating after the timeout, with no answer — end it as unanswered,
      // same as clicking the end-call button ourselves. _cleanup's reason ("Call ended" on an
      // outgoing call that never connected) already matches how the caller's own hangup reads.
      if (this.state.status === "outgoing" || this.state.status === "connecting") {
        this.endCall();
      }
    }, RING_TIMEOUT_MS);
  }

  async acceptCall() {
    if (!this.callId) return;
    this._setState({ status: "connecting", peerName: this.peerName });
    try {
      const call = await this._waitForOffer(this.callId);
      this.rtcClient = this._buildClient();
      await this.rtcClient.initialize();
      await this.rtcClient.setRemoteDescription({ type: "offer", sdp: call.offerSdp });
      const answer = await this.rtcClient.createAnswer();
      await CallRepo.setAnswer(this.callId, answer.sdp);
      this._listenForRemoteCandidates();
      this._listenForCallDocChanges();
    } catch (e) {
      console.error("Failed to accept call", e);
      this._cleanup("Couldn't access microphone");
    }
  }

  _waitForOffer(callId) {
    return new Promise((resolve) => {
      const unsub = CallRepo.observeCall(callId, (call) => {
        if (call?.offerSdp) {
          unsub();
          resolve(call);
        }
      });
    });
  }

  async declineCall() {
    if (this.callId) await CallRepo.updateCallStatus(this.callId, CallRepo.CALL_STATUS.DECLINED);
    this._cleanup("Declined");
  }

  async endCall() {
    if (this.callId) await CallRepo.updateCallStatus(this.callId, CallRepo.CALL_STATUS.ENDED);
    this._cleanup("Call ended");
  }

  toggleMute() {
    if (this.state.status !== "connected") return;
    const muted = !this.state.isMuted;
    this.rtcClient?.setMuted(muted);
    this._setState({ isMuted: muted });
  }

  _buildClient() {
    return new WebRtcClient({
      onLocalIceCandidate: (candidate) => {
        if (!this.callId) return;
        CallRepo.addIceCandidate(this.callId, this.isCaller, candidate.toJSON());
      },
      onRemoteStream: (stream) => {
        this.remoteAudioEl.srcObject = stream;
      },
      onConnectionStateChange: (connState) => {
        if (connState === "connected") this._onConnected();
        else if (["failed", "disconnected", "closed"].includes(connState)) {
          if (this.state.status !== "idle" && this.state.status !== "ended") this._cleanup("Call ended");
        }
      }
    });
  }

  _onConnected() {
    clearTimeout(this.ringTimeoutTimer);
    this.ringTimeoutTimer = null;
    this._setState({ status: "connected", peerName: this.peerName, durationSeconds: 0, isMuted: false });
    clearInterval(this.durationTimer);
    let seconds = 0;
    this.durationTimer = setInterval(() => {
      seconds++;
      if (this.state.status === "connected") this._setState({ durationSeconds: seconds });
    }, 1000);
  }

  _listenForCallDocChanges() {
    this.unsubCall?.();
    this.unsubCall = CallRepo.observeCall(this.callId, (call) => {
      if (!call) return;
      if (call.status === CallRepo.CALL_STATUS.ACCEPTED && this.isCaller && call.answerSdp) {
        clearTimeout(this.ringTimeoutTimer);
        this.ringTimeoutTimer = null;
        this.rtcClient?.setRemoteDescription({ type: "answer", sdp: call.answerSdp });
        this._setState({ status: "connecting", peerName: this.peerName });
      } else if (call.status === CallRepo.CALL_STATUS.DECLINED) {
        this._cleanup("Declined");
      } else if (call.status === CallRepo.CALL_STATUS.ENDED) {
        this._cleanup("Call ended");
      }
    });
  }

  _listenForRemoteCandidates() {
    this.unsubCandidates?.();
    // I'm the caller -> I want the callee's candidates, and vice versa.
    this.unsubCandidates = CallRepo.observeCandidates(this.callId, !this.isCaller, (candidate) => {
      this.rtcClient?.addRemoteIceCandidate(candidate);
    });
  }

  _cleanup(reason) {
    clearTimeout(this.ringTimeoutTimer);
    this.ringTimeoutTimer = null;
    clearInterval(this.durationTimer);
    this.durationTimer = null;
    this.unsubCall?.(); this.unsubCall = null;
    this.unsubCandidates?.(); this.unsubCandidates = null;
    this.rtcClient?.dispose();
    this.rtcClient = null;
    this.remoteAudioEl.srcObject = null;
    this.callId = null;
    this._setState({ status: "ended", reason });
    setTimeout(() => {
      if (this.state.status === "ended") this._setState({ status: "idle" });
    }, 1500);
  }
}
    
