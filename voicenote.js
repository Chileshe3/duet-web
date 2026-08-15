export class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get isRecording() {
    return !!this.mediaRecorder;
  }

  elapsedMillis() {
    return this.isRecording ? Date.now() - this.startedAt : 0;
  }

  /** Requests mic access and starts recording. Returns false if the mic couldn't be opened. */
  async start() {
    if (this.isRecording) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error("Mic access denied/unavailable", e);
      return false;
    }

    this.chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();
    this.startedAt = Date.now();
    return true;
  }

  /** Stops recording and resolves { blob, durationMillis, mimeType }, or null if too short/failed. */
  stopAndFinish() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) return resolve(null);
      const durationMillis = Date.now() - this.startedAt;
      const recorder = this.mediaRecorder;
      const mimeType = recorder.mimeType;

      recorder.onstop = () => {
        this._releaseStream();
        this.mediaRecorder = null;
        if (durationMillis < 500 || this.chunks.length === 0) {
          resolve(null);
        } else {
          resolve({ blob: new Blob(this.chunks, { type: mimeType }), durationMillis, mimeType });
        }
        this.chunks = [];
      };
      recorder.stop();
    });
  }

  /** Discards the in-progress recording. */
  cancel() {
    if (!this.mediaRecorder) return;
    const recorder = this.mediaRecorder;
    recorder.onstop = () => this._releaseStream();
    recorder.stop();
    this.mediaRecorder = null;
    this.chunks = [];
  }

  _releaseStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/**
 * Single shared <audio> player for voice-note playback in the message list —
 * starting a new note stops whichever one was already playing, matching WhatsApp.
 */
export class VoiceNotePlayer {
  constructor(onStateChange) {
    this.audio = null;
    this.nowPlayingId = null;
    this.onStateChange = onStateChange;
    this.tickTimer = null;
  }

  toggle(messageId, url) {
    if (this.nowPlayingId === messageId) {
      this.stop();
      return;
    }
    this.stop();
    this.audio = new Audio(url);
    this.nowPlayingId = messageId;
    this.audio.addEventListener("ended", () => this.stop());
    this.audio.play().catch((e) => {
      console.error("Playback failed", e);
      this.stop();
    });
    this._notify();
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this._notify(), 150);
  }

  stop() {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.nowPlayingId = null;
    this._notify();
  }

  _notify() {
    this.onStateChange({
      nowPlayingId: this.nowPlayingId,
      currentTimeMillis: (this.audio?.currentTime ?? 0) * 1000
    });
  }
}