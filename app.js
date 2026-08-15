import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  ensureUserDocument, watchProfile, completeProfile,
  sendPairRequest, watchOutgoingPairRequest, watchIncomingPairRequest,
  acceptPairRequest, rejectPairRequest, cancelPairRequest
} from "./pairing.js";

import { setPresence } from "./chat.js";

import { renderChat, teardownChatListeners } from "./chatview.js";
import { ensureCallController, disposeCallController } from "./callui.js";

const root = document.getElementById("app");

let currentProfile = null;
let unsubProfile = null;
let unsubIncoming = null;
let unsubOutgoing = null;

let incomingRequest = null;   // { fromUid, fromUsername } | null
let outgoingRequest = null;   // { toUid, toUsername, fromUid, ... } | null
let isResponding = false;     // accepting/declining an incoming invite

let uiStep = "choice";
let usernameInput = "";        // for choosing my own username
let partnerUsernameInput = ""; // for inviting a partner
let submitError = "";
let isSubmitting = false;

// ---------------- Wiring profile/pairing listeners ----------------

function watchProfileAndRender(uid) {
  if (unsubProfile) unsubProfile();
  unsubProfile = watchProfile(uid, (profile) => {
    currentProfile = profile;
    if (currentProfile?.coupleId && currentProfile?.partnerUid) {
      ensureCallController(uid);
    }
    render();
  });
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
    ensureUserDocument(user.uid, user.email || "").then(() => {
      watchProfileAndRender(user.uid);

      unsubIncoming = watchIncomingPairRequest(user.uid, (req) => {
        incomingRequest = req;
        render();
      });
      unsubOutgoing = watchOutgoingPairRequest(user.uid, (req) => {
        outgoingRequest = req;
        if (req) uiStep = "waiting";
        render();
      });
    });
    if (stopOwnPresence) stopOwnPresence();
    stopOwnPresence = startOwnPresenceTracking(user.uid);
  } else {
    if (unsubProfile) unsubProfile();
    if (unsubIncoming) unsubIncoming();
    if (unsubOutgoing) unsubOutgoing();
    teardownChatListeners();
    disposeCallController();
    if (stopOwnPresence) { stopOwnPresence(); stopOwnPresence = null; }
    currentProfile = null;
    incomingRequest = null;
    outgoingRequest = null;
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

// ---------------- Rendering (auth/profile/pairing screens) ----------------

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

  // An incoming invite takes priority over whatever pairing screen is showing —
  // mirrors GlobalPairingOverlay.kt on the Android side.
  if (!currentProfile.coupleId && incomingRequest) {
    root.innerHTML = `
      <div class="card">
        <h1>Pairing invite</h1>
        <p>@${incomingRequest.fromUsername} wants to pair with you on Duet.</p>
        <p class="error">${submitError}</p>
        <div class="row">
          <button id="accept" ${isResponding ? "disabled" : ""}>${isResponding ? "…" : "Accept"}</button>
          <button id="decline" ${isResponding ? "disabled" : ""}>Decline</button>
        </div>
      </div>
    `;
    document.getElementById("accept").onclick = async () => {
      isResponding = true; submitError = "";
      render();
      try {
        await acceptPairRequest(user.uid);
      } catch (e) {
        submitError = e.message;
      }
      isResponding = false;
      render();
    };
    document.getElementById("decline").onclick = async () => {
      isResponding = true;
      render();
      try {
        await rejectPairRequest(user.uid);
      } catch (e) {
        console.error("reject failed", e);
      }
      isResponding = false;
      render();
    };
    return;
  }

  if (currentProfile.coupleId) {
    renderChat(user, currentProfile);
    return;
  }

  teardownChatListeners();

  if (uiStep === "waiting") {
    const partnerName = outgoingRequest?.toUsername || "";
    root.innerHTML = `
      <div class="card">
        <h1>Waiting for @${partnerName}…</h1>
        <p>Signed in as ${user.email}</p>
        <p class="hint">You'll be paired automatically once they accept.</p>
        <div class="row">
          <button id="cancel">Cancel invite</button>
          <button id="signout">Sign Out</button>
        </div>
      </div>
    `;
    document.getElementById("cancel").onclick = async () => {
      if (outgoingRequest?.toUid) {
        await cancelPairRequest(user.uid, outgoingRequest.toUid);
      }
      uiStep = "choice";
      render();
    };
    document.getElementById("signout").onclick = () => signOut(auth);
    return;
  }

  if (uiStep === "enterUsername") {
    root.innerHTML = `
      <div class="card">
        <h1>Enter your partner's username</h1>
        <p>Signed in as ${user.email}</p>
        <input id="partnerUsername" type="text" placeholder="Partner's username" value="${partnerUsernameInput}" />
        <p class="error">${submitError}</p>
        <div class="row">
          <button id="submit" ${isSubmitting ? "disabled" : ""}>${isSubmitting ? "Submitting…" : "Send invite"}</button>
          <button id="back">Back</button>
        </div>
      </div>
    `;
    document.getElementById("back").onclick = () => { uiStep = "choice"; submitError = ""; render(); };
    document.getElementById("submit").onclick = async () => {
      partnerUsernameInput = document.getElementById("partnerUsername").value;
      isSubmitting = true; submitError = "";
      render();
      try {
        await sendPairRequest(user.uid, currentProfile.username, partnerUsernameInput);
        isSubmitting = false;
        uiStep = "waiting";
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
  document.getElementById("inRelationship").onclick = () => { uiStep = "enterUsername"; render(); };
  document.getElementById("later").onclick = () => updateDoc(doc(db, "users", user.uid), { pairingSkipped: true });
  document.getElementById("signout").onclick = () => signOut(auth);
}