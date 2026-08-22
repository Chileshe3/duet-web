import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  ensureUserDocument, watchProfile, completeProfile,
  sendPairRequest, watchOutgoingPairRequest, watchIncomingPairRequest,
  acceptPairRequest, rejectPairRequest, cancelPairRequest
} from "./pairing.js";

import { sendNudge, watchRecentNudges } from "./thinkingofyou.js";

import { setPresence } from "./chat.js";

import { renderChat, teardownChatListeners } from "./chatview.js";
import { ensureCallController, disposeCallController } from "./callui.js";
import {
  showGameFab as showThisOrThatFab,
  hideGameFab as hideThisOrThatFab,
  teardownGameOverlay as teardownThisOrThatOverlay
} from "./thisorthatview.js";
import {
  showGameFab as showTruthOrDareFab,
  hideGameFab as hideTruthOrDareFab,
  teardownGameOverlay as teardownTruthOrDareOverlay
} from "./truthordareview.js";
import {
  showGameFab as showWouldYouRatherFab,
  hideGameFab as hideWouldYouRatherFab,
  teardownGameOverlay as teardownWouldYouRatherOverlay
} from "./wouldyouratherview.js";

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

// ---------------- Thinking of You (floating widget, independent of uiStep) ----------------

const presetNudges = [
  ["💭", "Thinking of you"],
  ["🥰", "Miss you already"],
  ["😘", "Sending a kiss your way"],
  ["☀️", "Hope your day is going well"],
  ["💪", "You've got this today"],
  ["😴", "Can't wait to see you"]
];

let nudgeCoupleId = null;
let unsubNudges = null;
let recentNudges = [];
let nudgeWatermark = Date.now();
let nudgePanelOpen = false;
let nudgeToast = null;
let nudgeToastTimer = null;

const nudgeOverlayEl = document.getElementById("nudgeOverlay");

function watchNudgesFor(coupleId) {
  if (unsubNudges) unsubNudges();
  nudgeCoupleId = coupleId;
  nudgeWatermark = Date.now();
  unsubNudges = watchRecentNudges(coupleId, (nudges) => {
    recentNudges = nudges;
    const uid = auth.currentUser?.uid;
    const newFromPartner = nudges.filter(n => n.fromUid !== uid && n.timestampMillis > nudgeWatermark);
    if (newFromPartner.length > 0) {
      nudgeWatermark = Math.max(...newFromPartner.map(n => n.timestampMillis));
      const latest = newFromPartner.reduce((a, b) => (a.timestampMillis > b.timestampMillis ? a : b));
      showNudgeToast(`${latest.emoji} ${latest.message}`);
    }
    renderNudgeOverlay();
  });
}

function stopWatchingNudges() {
  if (unsubNudges) { unsubNudges(); unsubNudges = null; }
  recentNudges = [];
  nudgeCoupleId = null;
  nudgePanelOpen = false;
  renderNudgeOverlay();
}

function showNudgeToast(text) {
  nudgeToast = text;
  renderNudgeOverlay();
  clearTimeout(nudgeToastTimer);
  nudgeToastTimer = setTimeout(() => { nudgeToast = null; renderNudgeOverlay(); }, 4000);
}

function renderNudgeOverlay() {
  if (!nudgeOverlayEl) return;

  if (!currentProfile?.coupleId || !nudgeCoupleId) {
    nudgeOverlayEl.innerHTML = "";
    return;
  }

  const toastHtml = nudgeToast ? `<div class="nudge-toast">${nudgeToast}</div>` : "";

  if (!nudgePanelOpen) {
    nudgeOverlayEl.innerHTML = `${toastHtml}<button id="nudgeFab" class="nudge-fab">💭</button>`;
    document.getElementById("nudgeFab").onclick = () => { nudgePanelOpen = true; renderNudgeOverlay(); };
    return;
  }

  const myUid = auth.currentUser?.uid;
  const presetsHtml = presetNudges
    .map(([emoji, msg], i) => `<button class="nudge-preset" data-i="${i}">${emoji} ${msg}</button>`)
    .join("");

  const recentHtml = recentNudges.length
    ? recentNudges.slice(0, 8).map(n => `
        <div class="nudge-row">
          <span>${n.emoji} ${n.message}</span>
          <span class="nudge-who">${n.fromUid === myUid ? "You" : "Partner"}</span>
        </div>
      `).join("")
    : `<p class="hint">No nudges yet</p>`;

  nudgeOverlayEl.innerHTML = `
    ${toastHtml}
    <div class="nudge-panel">
      <div class="nudge-panel-header">
        <span>Thinking of You</span>
        <button id="nudgeClose" class="nudge-close">×</button>
      </div>
      <div class="nudge-presets">${presetsHtml}</div>
      <div class="nudge-recent">${recentHtml}</div>
    </div>
  `;
  document.getElementById("nudgeClose").onclick = () => { nudgePanelOpen = false; renderNudgeOverlay(); };
  presetNudges.forEach((preset, i) => {
    const btn = nudgeOverlayEl.querySelector(`.nudge-preset[data-i="${i}"]`);
    btn.onclick = async () => {
      if (!myUid || !nudgeCoupleId) return;
      btn.disabled = true;
      try {
        await sendNudge(nudgeCoupleId, myUid, preset[0], preset[1]);
      } catch (e) {
        console.error("sendNudge failed", e);
      }
      btn.disabled = false;
    };
  });
}

// ---------------- Wiring profile/pairing listeners ----------------

function watchProfileAndRender(uid) {
  if (unsubProfile) unsubProfile();
  unsubProfile = watchProfile(uid, (profile) => {
    currentProfile = profile;
    if (currentProfile?.coupleId && currentProfile?.partnerUid) {
      ensureCallController(uid);
    }
    if (currentProfile?.coupleId) {
      showThisOrThatFab(currentProfile.coupleId);
      showTruthOrDareFab(currentProfile.coupleId);
      showWouldYouRatherFab(currentProfile.coupleId);
    } else {
      hideThisOrThatFab();
      hideTruthOrDareFab();
      hideWouldYouRatherFab();
    }
    if (currentProfile?.coupleId && currentProfile.coupleId !== nudgeCoupleId) {
      watchNudgesFor(currentProfile.coupleId);
    } else if (!currentProfile?.coupleId && nudgeCoupleId) {
      stopWatchingNudges();
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
    stopWatchingNudges();
    teardownChatListeners();
    disposeCallController();
    hideThisOrThatFab();
    hideTruthOrDareFab();
    hideWouldYouRatherFab();
    teardownThisOrThatOverlay();
    teardownTruthOrDareOverlay();
    teardownWouldYouRatherOverlay();
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

async function doGoogleSignIn() {
  const errEl = document.getElementById("authError");
  errEl.textContent = "";
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    // Popup closed / blocked shouldn't read as a scary error during testing.
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      errEl.textContent = e.message;
    }
  }
}

// ---------------- Rendering (auth/profile/pairing screens) ----------------

function renderAuth() {
  root.innerHTML = `
    <div class="card">
      <h1>Duet — Web Test Client</h1>
      <p class="hint">Sign in with a second test account (different email than your phone's account) to test pairing.</p>
      <button id="googleSignIn" class="google-btn">Continue with Google</button>
      <div class="divider"><span>or</span></div>
      <input id="email" type="email" placeholder="Email" autocomplete="username" />
      <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
      <div class="row">
        <button id="signin">Sign In</button>
        <button id="signup">Create Account</button>
      </div>
      <p id="authError" class="error"></p>
    </div>
  `;
  document.getElementById("googleSignIn").onclick = doGoogleSignIn;
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