import { sendMediaMessage } from "./chat.js";
import { uploadChatMedia } from "./supabase.js";
import { AudioRecorder, VoiceNotePlayer } from "./voicenote.js";
import { formatMillis, formatDuration } from "./domutils.js";

const audioRecorder = new AudioRecorder();
let isRecordingVoiceNote = false;
let recordingTimerId = null;
let currentContext = { coupleId: null, uid: null };

let voiceNoteState = { nowPlayingId: null, currentTimeMillis: 0 };
let onPlaybackTick = () => {};

/** Call once from chat-view.js — fires whenever playback state changes, so the message list re-renders. */
export function setPlaybackTickListener(cb) {
  onPlaybackTick = cb || (() => {});
}

const voiceNotePlayer = new VoiceNotePlayer((state) => {
  voiceNoteState = state;
  onPlaybackTick();
});

export function toggleVoiceNotePlayback(messageId, url) {
  voiceNotePlayer.toggle(messageId, url);
}

/** Bubble HTML for a VOICE_NOTE message — play/pause button + progress bar + duration. */
export function renderVoiceNoteBubbleHtml(m) {
  const isPlaying = voiceNoteState.nowPlayingId === m.id;
  const durationMillis = m.mediaDurationMillis || 0;
  const shownMillis = isPlaying ? voiceNoteState.currentTimeMillis : durationMillis;
  const progressPct = isPlaying && durationMillis > 0
    ? Math.min(100, (voiceNoteState.currentTimeMillis / durationMillis) * 100)
    : 0;
  return `
    <div class="voice-note">
      <button class="voice-note-toggle" data-message-id="${m.id}" data-url="${m.mediaUrl}" title="${isPlaying ? "Pause" : "Play"}">${isPlaying ? "⏸" : "▶"}</button>
      <div class="voice-note-body">
        <div class="voice-note-progress"><div class="voice-note-progress-fill" style="width:${progressPct}%;"></div></div>
        <div class="voice-note-time">${formatMillis(shownMillis)}</div>
      </div>
    </div>
  `;
}

async function sendVoiceNote(result) {
  const { coupleId, uid } = currentContext;
  if (!coupleId) return;
  const statusEl = document.getElementById("uploadStatus");
  if (statusEl) { statusEl.style.display = "block"; statusEl.textContent = "Sending voice note…"; }
  try {
    const file = new File([result.blob], `voice_${Date.now()}.webm`, { type: result.mimeType });
    const uploaded = await uploadChatMedia(coupleId, file);
    await sendMediaMessage(coupleId, uid, {
      type: "VOICE_NOTE",
      url: uploaded.url,
      fileName: uploaded.fileName,
      sizeBytes: uploaded.sizeBytes,
      durationMillis: result.durationMillis
    });
    if (statusEl) statusEl.style.display = "none";
  } catch (e) {
    console.error("Voice note failed to send", e);
    if (statusEl) {
      statusEl.textContent = "Voice note failed to send";
      setTimeout(() => { statusEl.style.display = "none"; }, 3000);
    }
  }
}

function showRecordingUI() {
  const normal = document.getElementById("composerNormal");
  const recording = document.getElementById("composerRecording");
  if (normal) normal.style.display = "none";
  if (recording) recording.style.display = "flex";
}

function hideRecordingUI() {
  const normal = document.getElementById("composerNormal");
  const recording = document.getElementById("composerRecording");
  if (normal) normal.style.display = "flex";
  if (recording) recording.style.display = "none";
}

async function beginRecording(e) {
  e.preventDefault();
  if (isRecordingVoiceNote) return;
  const started = await audioRecorder.start();
  if (!started) {
    alert("Couldn't access your microphone.");
    return;
  }
  isRecordingVoiceNote = true;
  showRecordingUI();
  clearInterval(recordingTimerId);
  recordingTimerId = setInterval(() => {
    const el = document.getElementById("recordingTimer");
    if (el) el.textContent = formatDuration(Math.floor(audioRecorder.elapsedMillis() / 1000));
  }, 100);
}

async function finishRecording() {
  if (!isRecordingVoiceNote) return;
  isRecordingVoiceNote = false;
  clearInterval(recordingTimerId);
  hideRecordingUI();
  const result = await audioRecorder.stopAndFinish();
  if (!result) return; // too short / failed — dropped silently, matches WhatsApp
  await sendVoiceNote(result);
}

function cancelRecording() {
  if (!isRecordingVoiceNote) return;
  isRecordingVoiceNote = false;
  clearInterval(recordingTimerId);
  audioRecorder.cancel();
  hideRecordingUI();
}

// Attached once, module-wide — "release anywhere on the page" needs to keep working
// even if the pointer drifts off the mic button, so this can't live on the button itself.
window.addEventListener("mouseup", finishRecording);
window.addEventListener("touchend", finishRecording);

/** Call once per renderChat() — (re)binds the mic/cancel buttons and refreshes the coupleId/uid context. */
export function wireComposer({ coupleId, uid }) {
  currentContext = { coupleId, uid };
  const micBtn = document.getElementById("micBtn");
  const cancelBtn = document.getElementById("cancelRecordingBtn");
  micBtn?.addEventListener("mousedown", beginRecording);
  micBtn?.addEventListener("touchstart", beginRecording, { passive: false });
  if (cancelBtn) cancelBtn.onclick = cancelRecording;
}