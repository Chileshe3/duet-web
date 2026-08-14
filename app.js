import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  ensureUserDocument, watchProfile, listenForIncomingPairing,
  submitPartnerEmail, completeProfile, unpairPartner
} from "./pairing.js";

import {
  observeMessages, sendMessage, sendMediaMessage, observeTyping, setTyping, scheduleTypingClear,
  observePresence, setPresence
} from "./chat.js";

import { uploadChatMedia, mediaTypeFromMime } from "./supabase.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const root = document.getElementById("app");

let currentProfile = null;
let unsubProfile = null;
let unsubIntent = null;
let startedIncomingListener = false;

let unsubMessages = null;
let unsubTyping = null;
let unsubPresence = null;

let uiStep = "choice";
let emailInput = "";
let usernameInput = "";
let submitError = "";
let isSubmitting = false;
let isUploadingMedia = false;
let partnerLastActiveMillis = null;

// ---------------- Wiring pairing/profile listeners ----------------

function watchProfileAndRender(uid) {
  if (unsubProfile) unsubProfile();
  unsubProfile = watchProfile(uid, (profile) => {
    currentProfile = profile;
    if (currentProfile?.email && !startedIncomingListener) {
      startedIncomingListener = true;
      unsubIntent = listenForIncomingPairing(
        uid,
        currentProfile.email,
        () => currentProfile,
        (e) => console.error("pairing failed", e)
      );
    }
    render();
  });
}

function teardownChatListeners() {
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  if (unsubTyping) { unsubTyping(); unsubTyping = null; }
  if (unsubPresence) { unsubPresence(); unsubPresence = null; }
}

// ---------------- Presence: mark this account online/offline ----------------
// Runs for the whole session, independent of which UI step is showing, so
// "online" on this web client actually reflects reality instead of being hardcoded.

function startOwnPresenceTracking(uid) {
  setPresence(uid, true);
  const heartbeat = setInterval(() => setPresence(uid, true), 20_000);

  const markOffline = () => setPresence(uid, false);
  window.addEventListener("beforeunload", markOffline);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") markOffline();
    else setPresence(uid, true);
  });

  return () => {
    clearInterval(heartbeat);
    window.removeEventListener("beforeunload", markOffline);
  };
}

let stopOwnPresence = null;

// ---------------- Auth wiring ----------------

onAuthStateChanged(auth, (user) => {
  if (user) {
    uiStep = "choice";
    ensureUserDocument(user.uid, user.email || "").then(() => watchProfileAndRender(user.uid));
    if (stopOwnPresence) stopOwnPresence();
    stopOwnPresence = startOwnPresenceTracking(user.uid);
  } else {
    if (unsubProfile) unsubProfile();
    if (unsubIntent) unsubIntent();
    teardownChatListeners();
    if (stopOwnPresence) { stopOwnPresence(); stopOwnPresence = null; }
    startedIncomingListener = false;
    currentProfile = null;
    renderAuth();
  }
});

async function doAuth(fn) {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("authError");
  errEl.textContent = "";
  try {
    await fn(auth, email, password);
  } catch (e) {
    errEl.textContent = e.message;
  }
}

// ---------------- Rendering (auth/profile/pairing screens unchanged) ----------------

function renderAuth() {
  root.innerHTML = `
    <div class="card">
      <h1>Duet — Web Test Client</h1>
      <p class="hint">Sign in with a second test account (different email than your phone's account) to test pairing.</p>
      <input id="email" type="email" placeholder="Email" autocomplete="username" />
      <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
      <div class="row">
        <button id="signin">Sign In</button>
        <button id="signup">Create Account</button>
      </div>
      <p id="authError" class="error"></p>
    </div>
  `;
  document.getElementById("signin").onclick = () => doAuth(signInWithEmailAndPassword);
  document.getElementById("signup").onclick = () => doAuth(createUserWithEmailAndPassword);
}

function render() {
  if (!currentProfile) {
    root.innerHTML = `<div class="card"><p>Loading profile…</p></div>`;
    return;
  }
  const user = auth.currentUser;

  if (!currentProfile.profileComplete) {
    teardownChatListeners();
    root.innerHTML = `
      <div class="card">
        <h1>Choose a username</h1>
        <p>Signed in as ${user.email}</p>
        <input id="usernameField" type="text" placeholder="Username (min 3 chars)" value="${usernameInput}" />
        <p class="error">${submitError}</p>
        <div class="row">
          <button id="saveUsername" ${isSubmitting ? "disabled" : ""}>${isSubmitting ? "Saving…" : "Save"}</button>
          <button id="signout">Sign Out</button>
        </div>
      </div>
    `;
    document.getElementById("saveUsername").onclick = async () => {
      usernameInput = document.getElementById("usernameField").value;
      isSubmitting = true; submitError = "";
      render();
      try {
        await completeProfile(user.uid, usernameInput);
        isSubmitting = false;
      } catch (e) {
        isSubmitting = false;
        submitError = e.message;
        render();
      }
    };
    document.getElementById("signout").onclick = () => signOut(auth);
    return;
  }

  if (currentProfile.coupleId) {
    renderChat(user);
    return;
  }

  teardownChatListeners();

  if (uiStep === "waiting") {
    root.innerHTML = `
      <div class="card">
        <h1>Waiting for partner…</h1>
        <p>Signed in as ${user.email}</p>
        <p class="hint">Now enter this account's email (<b>${user.email}</b>) as the partner email on your phone.</p>
        <div class="row">
          <button id="back">Back</button>
          <button id="signout">Sign Out</button>
        </div>
      </div>
    `;
    document.getElementById("back").onclick = () => { uiStep = "choice"; render(); };
    document.getElementById("signout").onclick = () => signOut(auth);
    return;
  }

  if (uiStep === "enterEmail") {
    root.innerHTML = `
      <div class="card">
        <h1>Enter partner's email</h1>
        <p>Signed in as ${user.email}</p>
        <input id="partnerEmail" type="email" placeholder="Partner's email" value="${emailInput}" />
        <p class="error">${submitError}</p>
        <div class="row">
          <button id="submit" ${isSubmitting ? "disabled" : ""}>${isSubmitting ? "Submitting…" : "Submit"}</button>
          <button id="back">Back</button>
        </div>
      </div>
    `;
    document.getElementById("back").onclick = () => { uiStep = "choice"; submitError = ""; render(); };
    document.getElementById("submit").onclick = async () => {
      emailInput = document.getElementById("partnerEmail").value;
      isSubmitting = true; submitError = "";
      render();
      try {
        const outcome = await submitPartnerEmail(user.uid, currentProfile.email || user.email, emailInput);
        isSubmitting = false;
        if (outcome.type === "waiting") uiStep = "waiting";
        render();
      } catch (e) {
        isSubmitting = false;
        submitError = e.message;
        render();
      }
    };
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h1>Duet — Web Test Client</h1>
      <p>Signed in as ${user.email}</p>
      <div class="row">
        <button id="inRelationship">I'm in a relationship</button>
        <button id="later">Pair later</button>
      </div>
      <div class="row">
        <button id="signout">Sign Out</button>
      </div>
    </div>
  `;
  document.getElementById("inRelationship").onclick = () => { uiStep = "enterEmail"; render(); };
  document.getElementById("later").onclick = () => updateDoc(doc(db, "users", user.uid), { pairingSkipped: true });
  document.getElementById("signout").onclick = () => signOut(auth);
}

// ---------------- Chat view ----------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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

function renderChat(user) {
  root.innerHTML = `
    <div class="chat-card">
      <div class="chat-header">
        <div>
          <div class="chat-title">Couple ${currentProfile.coupleId}</div>
          <div class="chat-status"><span class="dot" id="statusDot" style="display:none;"></span><span id="typingStatus">offline</span></div>
        </div>
        <button id="unpair" class="icon-btn" style="margin-left:auto;width:auto;">Unpair</button>
        <button id="signout" class="icon-btn" style="width:auto;">Sign Out</button>
      </div>
      <div id="messages" class="messages"></div>
      <div id="uploadStatus" class="upload-status" style="display:none;">Uploading…</div>
      <div class="chat-input-row">
        <button id="attachBtn" class="icon-btn" title="Attach photos or videos">📎</button>
        <input id="fileInput" type="file" accept="image/*,video/*" multiple style="display:none;" />
        <input id="msgInput" type="text" placeholder="Type a message…" autocomplete="off" />
        <button id="sendBtn">Send</button>
      </div>
    </div>
  `;

  document.getElementById("unpair").onclick = async () => {
    teardownChatListeners();
    await unpairPartner(user.uid);
  };
  document.getElementById("signout").onclick = () => signOut(auth);

  if (unsubMessages) unsubMessages();
  unsubMessages = observeMessages(currentProfile.coupleId, (msgs) => {
    const el = document.getElementById("messages");
    if (!el) return;
    el.innerHTML = msgs.map(m => `
      <div class="bubble ${m.senderUid === user.uid ? "mine" : "theirs"}">${bubbleContentHtml(m)}</div>
    `).join("");
    el.scrollTop = el.scrollHeight;

    // Wire up image tap-to-view after render.
    el.querySelectorAll("img.bubble-media").forEach((img) => {
      img.style.cursor = "pointer";
      img.addEventListener("click", () => openLightbox(img.dataset.viewerUrl, img.dataset.viewerName));
    });
  });

  if (unsubTyping) unsubTyping();
  if (unsubPresence) unsubPresence();

  const statusEl = document.getElementById("typingStatus");
  const dotEl = document.getElementById("statusDot");
  let partnerIsTyping = false;
  let partnerIsOnline = false;

  function refreshStatusText() {
    if (!statusEl) return;
    statusEl.textContent = partnerIsTyping ? "typing…" : (partnerIsOnline ? "online" : formatLastSeen(partnerLastActiveMillis));
    if (dotEl) dotEl.style.display = partnerIsOnline ? "inline-block" : "none";
  }

  if (currentProfile.partnerUid) {
    unsubTyping = observeTyping(currentProfile.coupleId, currentProfile.partnerUid, (isTyping) => {
      partnerIsTyping = isTyping;
      refreshStatusText();
    });
    unsubPresence = observePresence(currentProfile.partnerUid, (isOnline) => {
      partnerIsOnline = isOnline;
      // observePresence in chat.js only reports the boolean; if you want an exact
      // "last seen" timestamp on this client too, extend observePresence to also
      // pass back lastActiveAt the same way ChatRepository.kt does on Android.
      refreshStatusText();
    });
  }
  refreshStatusText();

  const input = document.getElementById("msgInput");
  const send = async () => {
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    await sendMessage(currentProfile.coupleId, user.uid, text);
    await setTyping(currentProfile.coupleId, user.uid, false);
  };
  document.getElementById("sendBtn").onclick = send;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
  input.addEventListener("input", () => {
    setTyping(currentProfile.coupleId, user.uid, true);
    scheduleTypingClear(currentProfile.coupleId, user.uid);
  });

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
        const uploaded = await uploadChatMedia(currentProfile.coupleId, files[i]);
        const type = mediaTypeFromMime(files[i].type);
        await sendMediaMessage(currentProfile.coupleId, user.uid, {
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