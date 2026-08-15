// Uses the browser's built-in WebRTC APIs directly — no external library needed
// (unlike the Android app, which has to pull in a WebRTC binding).

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
  // For networks with restrictive NATs, add a TURN server here too, e.g.:
  // { urls: "turn:your-turn-host:3478", username: "...", credential: "..." }
];

export class WebRtcClient {
  constructor({ onLocalIceCandidate, onRemoteStream, onConnectionStateChange }) {
    this.pc = null;
    this.localStream = null;
    this.onLocalIceCandidate = onLocalIceCandidate;
    this.onRemoteStream = onRemoteStream;
    this.onConnectionStateChange = onConnectionStateChange;
  }

  /** Requests mic access and sets up the peer connection. Throws if the mic is denied. */
  async initialize() {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.localStream.getTracks().forEach((track) => this.pc.addTrack(track, this.localStream));

    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.onLocalIceCandidate(event.candidate);
    };
    this.pc.ontrack = (event) => {
      this.onRemoteStream(event.streams[0]);
    };
    this.pc.onconnectionstatechange = () => {
      this.onConnectionStateChange(this.pc.connectionState);
    };
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async createAnswer() {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async setRemoteDescription(desc) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
  }

  async addRemoteIceCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      // Candidates that arrive before setRemoteDescription land here sometimes — safe to ignore
      // as long as they aren't ALL failing (which would mean something else is wrong).
      console.warn("Failed to add ICE candidate", e);
    }
  }

  setMuted(muted) {
    this.localStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  }

  dispose() {
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
  }
}