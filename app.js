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
  observeMessages, sendMessage, observeTyping, setTyping, scheduleTypingClear
} from "./chat.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const root = document.getElementById("app");

let currentProfile = null;
let unsubProfile = null;
let unsubIntent = null;
let startedIncomingListener = false;

let unsubMessages = null;
let unsubTyping = null;

let uiStep = "choice"; // username | choice | enterEmail | waiting
let emailInput = "";
let usernameInput = "";
let submitError = "";
let isSubmitting = false;

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
}

// ---------------- Auth wiring ----------------

onAuthStateChanged(auth, (user) => {
  if (user) {
    uiStep = "choice";
    ensureUserDocument(user.uid, user.email || "").then(() => watchProfileAndRender(user.uid));
  } else {
    if (unsubProfile) unsubProfile();
    if (unsubIntent) unsubIntent();
    teardownChatListeners();
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

// ---------------- Rendering ----------------

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
        // watchProfile's onSnapshot will pick up profileComplete and re-render.
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

function renderChat(user) {
  root.innerHTML = `
    <div class="chat-card">
      <div class="chat-header">
        <div>
          <div class="chat-title">Couple ${currentProfile.coupleId}</div>
          <div class="chat-status"><span class="dot"></span><span id="typingStatus">online</span></div>
        </div>
        <button id="unpair" class="icon-btn" style="margin-left:auto;width:auto;">Unpair</button>
        <button id="signout" class="icon-btn" style="width:auto;">Sign Out</button>
      </div>
      <div id="messages" class="messages"></div>
      <div class="chat-input-row">
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

  // Re-subscribe to messages/typing for this couple. Guarded so re-renders
  // triggered by profile snapshot changes don't stack up listeners.
  if (unsubMessages) unsubMessages();
  unsubMessages = observeMessages(currentProfile.coupleId, (msgs) => {
    const el = document.getElementById("messages");
    if (!el) return;
    el.innerHTML = msgs.map(m => `
      <div class="bubble ${m.senderUid === user.uid ? "mine" : "theirs"}">${escapeHtml(m.text)}</div>
    `).join("");
    el.scrollTop = el.scrollHeight;
  });

  if (unsubTyping) unsubTyping();
  if (currentProfile.partnerUid) {
    unsubTyping = observeTyping(currentProfile.coupleId, currentProfile.partnerUid, (isTyping) => {
      const el = document.getElementById("typingStatus");
      if (el) el.textContent = isTyping ? "typing…" : "online";
    });
  }

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
}