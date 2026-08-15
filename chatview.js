import { auth, db } from "./firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  observeMessages, sendMessage, sendMediaMessage, observeTyping, setTyping, scheduleTypingClear,
  observePresence
} from "./chat.js";
import { uploadChatMedia, mediaTypeFromMime } from "./supabase.js";
import { unpairPartner } from "./pairing.js";

import { escapeHtml } from "./domutils.js";
import { startCallWithPartner, setKnownPartnerUsername } from "./callui.js";
import {
  wireComposer, toggleVoiceNotePlayback, renderVoiceNoteBubbleHtml, setPlaybackTickListener
} from "./voicenotesui.js";

let unsubMessages = null;
let unsubTyping = null;
let unsubPresence = null;
let unsubPartnerProfile = null;
let partnerUsername = "";
let partnerLastActiveMillis = null;
let lastRenderedMessages = [];
let isUploadingMedia = false;

export function teardownChatListeners() {
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  if (unsubTyping) { unsubTyping(); unsubTyping = null; }
  if (unsubPresence) { unsubPresence(); unsubPresence = null; }
  if (unsubPartnerProfile) { unsubPartnerProfile(); unsubPartnerProfile = null; }
}

function formatLastSeen(millis) {
  if (!millis) return "offline";
  const diffMs = Date.now() - millis;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "last seen just now";
  if (min < 60) return `last seen ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `last seen ${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `last seen ${days}d ago`;
  return "last seen a while ago";
}

function bubbleContentHtml(m) {
  if (m.type === "IMAGE" && m.mediaUrl) {
    const caption = m.text ? `<div class="bubble-caption">${escapeHtml(m.text)}</div>` : "";
    return `
      <img class="bubble-media" src="${m.mediaUrl}" alt="Photo" data-viewer-url="${m.mediaUrl}" data-viewer-name="${escapeHtml(m.mediaFileName || 'photo.jpg')}" />
      ${caption}
    `;
  }
  if (m.type === "VIDEO" && m.mediaUrl) {
    const caption = m.text ? `<div class="bubble-caption">${escapeHtml(m.text)}</div>` : "";
    return `
      <video class="bubble-media" src="${m.mediaUrl}" controls></video>
      <a class="bubble-download" href="${m.mediaUrl}" download="${escapeHtml(m.mediaFileName || 'video.mp4')}" title="Save video">⬇</a>
      ${caption}
    `;
  }
  if (m.type === "VOICE_NOTE" && m.mediaUrl) {
    return renderVoiceNoteBubbleHtml(m);
  }
  return escapeHtml(m.text);
}

function openLightbox(url, fileName) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.innerHTML = `
    <div class="lightbox-actions">
      <a class="lightbox-btn" href="${url}" download="${escapeHtml(fileName)}" title="Save to device">⬇</a>
      <button class="lightbox-btn" id="lightboxClose" title="Close">✕</button>
    </div>
    <img class="lightbox-image" src="${url}" alt="Photo" />
  `;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) document.body.removeChild(overlay);
  });
  overlay.querySelector("#lightboxClose").onclick = () => document.body.removeChild(overlay);
  document.body.appendChild(overlay);
}

function renderMessagesList(msgs, { scrollToBottom }) {
  lastRenderedMessages = msgs;
  const el = document.getElementById("messages");
  if (!el) return;
  const user = auth.currentUser;
  el.innerHTML = msgs.map(m => `
    <div class="bubble ${m.senderUid === user.uid ? "mine" : "theirs"}">${bubbleContentHtml(m)}</div>
  `).join("");
  if (scrollToBottom) el.scrollTop = el.scrollHeight;

  el.querySelectorAll("img.bubble-media").forEach((img) => {
    img.style.cursor = "pointer";
    img.addEventListener("click", () => openLightbox(img.dataset.viewerUrl, img.dataset.viewerName));
  });
  el.querySelectorAll(".voice-note-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleVoiceNotePlayback(btn.dataset.messageId, btn.dataset.url);
    });
  });
}

// Re-render the (already-fetched) message list whenever playback progresses,
// without re-querying Firestore.
setPlaybackTickListener(() => renderMessagesList(lastRenderedMessages, { scrollToBottom: false }));

export function renderChat(user, profile) {
  const root = document.getElementById("app");
  root.innerHTML = `
    <div class="chat-card">
      <div class="chat-header">
        <div>
          <div class="chat-title" id="chatTitle">${partnerUsername || ("Couple " + profile.coupleId)}</div>
          <div class="chat-status"><span class="dot" id="statusDot" style="display:none;"></span><span id="typingStatus">offline</span></div>
        </div>
        <button id="callBtn" class="icon-btn" style="margin-left:auto;" title="Call partner">📞</button>
        <button id="unpair" class="icon-btn" style="width:auto;">Unpair</button>
        <button id="signout" class="icon-btn" style="width:auto;">Sign Out</button>
      </div>
      <div id="messages" class="messages"></div>
      <div id="uploadStatus" class="upload-status" style="display:none;">Uploading…</div>
      <div class="chat-input-row" id="composerNormal">
        <button id="attachBtn" class="icon-btn" title="Attach photos or videos">📎</button>
        <input id="fileInput" type="file" accept="image/*,video/*" multiple style="display:none;" />
        <input id="msgInput" type="text" placeholder="Type a message…" autocomplete="off" />
        <button id="micBtn" class="icon-btn mic-btn" title="Hold to record a voice note">🎤</button>
        <button id="sendBtn" style="display:none;">Send</button>
      </div>
      <div class="chat-input-row recording-row" id="composerRecording" style="display:none;">
        <button id="cancelRecordingBtn" class="icon-btn" title="Cancel recording">🗑️</button>
        <div class="recording-indicator">
          <span class="rec-dot"></span>
          <span id="recordingTimer">0:00</span>
        </div>
        <div class="recording-hint">Release to send</div>
      </div>
    </div>
  `;

  document.getElementById("unpair").onclick = async () => {
    teardownChatListeners();
    await unpairPartner(user.uid);
  };
  document.getElementById("signout").onclick = () => signOut(auth);
  document.getElementById("callBtn").onclick = () => {
    if (!profile.partnerUid) return;
    startCallWithPartner(profile.coupleId, profile.partnerUid, partnerUsername || "Partner");
  };

  if (unsubMessages) unsubMessages();
  unsubMessages = observeMessages(profile.coupleId, (msgs) => {
    renderMessagesList(msgs, { scrollToBottom: true });
  });

  if (unsubTyping) unsubTyping();
  if (unsubPresence) unsubPresence();
  if (unsubPartnerProfile) unsubPartnerProfile();

  const statusEl = document.getElementById("typingStatus");
  const dotEl = document.getElementById("statusDot");
  let partnerIsTyping = false;
  let partnerIsOnline = false;

  function refreshStatusText() {
    if (!statusEl) return;
    statusEl.textContent = partnerIsTyping ? "typing…" : (partnerIsOnline ? "online" : formatLastSeen(partnerLastActiveMillis));
    if (dotEl) dotEl.style.display = partnerIsOnline ? "inline-block" : "none";
  }

  if (profile.partnerUid) {
    unsubTyping = observeTyping(profile.coupleId, profile.partnerUid, (isTyping) => {
      partnerIsTyping = isTyping;
      refreshStatusText();
    });
    unsubPresence = observePresence(profile.partnerUid, (isOnline) => {
      partnerIsOnline = isOnline;
      refreshStatusText();
    });
    unsubPartnerProfile = onSnapshot(doc(db, "users", profile.partnerUid), (snap) => {
      partnerUsername = snap.data()?.username || "Partner";
      setKnownPartnerUsername(partnerUsername);
      const titleEl = document.getElementById("chatTitle");
      if (titleEl) titleEl.textContent = partnerUsername;
    });
  }
  refreshStatusText();

  const input = document.getElementById("msgInput");

  function updateComposerButtons() {
    const sendBtn = document.getElementById("sendBtn");
    const micBtn = document.getElementById("micBtn");
    if (!sendBtn || !micBtn) return;
    const hasText = input.value.trim().length > 0;
    sendBtn.style.display = hasText ? "inline-block" : "none";
    micBtn.style.display = hasText ? "none" : "inline-block";
  }

  const send = async () => {
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    updateComposerButtons();
    await sendMessage(profile.coupleId, user.uid, text);
    await setTyping(profile.coupleId, user.uid, false);
  };
  document.getElementById("sendBtn").onclick = send;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
  input.addEventListener("input", () => {
    updateComposerButtons();
    setTyping(profile.coupleId, user.uid, true);
    scheduleTypingClear(profile.coupleId, user.uid);
  });

  wireComposer({ coupleId: profile.coupleId, uid: user.uid });

  // ---- Attach / upload (multi-file) ----
  const fileInput = document.getElementById("fileInput");
  document.getElementById("attachBtn").onclick = () => {
    if (!isUploadingMedia) fileInput.click();
  };
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files);
    fileInput.value = "";
    if (files.length === 0) return;

    const statusEl2 = document.getElementById("uploadStatus");
    isUploadingMedia = true;
    statusEl2.style.display = "block";

    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      statusEl2.textContent = `Uploading ${i + 1} of ${files.length}…`;
      try {
        const uploaded = await uploadChatMedia(profile.coupleId, files[i]);
        const type = mediaTypeFromMime(files[i].type);
        await sendMediaMessage(profile.coupleId, user.uid, {
          type,
          url: uploaded.url,
          fileName: uploaded.fileName,
          sizeBytes: uploaded.sizeBytes
        });
      } catch (e) {
        failed++;
      }
    }

    isUploadingMedia = false;
    if (failed > 0) {
      statusEl2.textContent = `${failed} file(s) failed to send`;
      setTimeout(() => { statusEl2.style.display = "none"; }, 3000);
    } else {
      statusEl2.style.display = "none";
    }
  });
}