import { WebRtcClient } from "./webrtcclient.js";
import * as CallRepo from "./call.js";

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
    }
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