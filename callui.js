import { db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CallController } from "./callcontroller.js";
import { escapeHtml } from "./domutils.js";
import { formatDuration } from "./domutils.js";

let callController = null;
let cachedPartnerUsername = "";

/** Call whenever the partner's username becomes known, so incoming calls can show a name
 *  without an extra Firestore read. */
export function setKnownPartnerUsername(name) {
  cachedPartnerUsername = name || "";
}

async function resolvePartnerName(uid) {
  if (cachedPartnerUsername) return cachedPartnerUsername;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.data()?.username || "Partner";
  } catch {
    return "Partner";
  }
}

/** Call once per session, as soon as the user's coupleId/partnerUid are known. Safe to call repeatedly. */
export function ensureCallController(uid) {
  if (callController) return;
  callController = new CallController({ myUid: uid, onStateChange: renderCallOverlay });
  callController.startListeningForIncomingCalls(resolvePartnerName);
}

export function disposeCallController() {
  if (!callController) return;
  callController.unsubIncoming?.();
  callController.unsubCall?.();
  callController.unsubCandidates?.();
  callController.rtcClient?.dispose();
  callController.remoteAudioEl?.remove();
  callController = null;
  cachedPartnerUsername = "";
  renderCallOverlay({ status: "idle" });
}

export function startCallWithPartner(coupleId, calleeUid, calleeName) {
  callController?.startCall(coupleId, calleeUid, calleeName);
}

function callStatusHtml(name, subtitle) {
  return `
    <div class="call-avatar">💜</div>
    ${name ? `<div class="call-name">${escapeHtml(name)}</div>` : ""}
    <div class="call-subtitle">${escapeHtml(subtitle)}</div>
  `;
}

function renderCallOverlay(state) {
  const overlay = document.getElementById("callOverlay");
  if (!overlay) return;

  if (state.status === "idle") {
    overlay.style.display = "none";
    overlay.innerHTML = "";
    return;
  }
  overlay.style.display = "flex";

  if (state.status === "outgoing") {
    overlay.innerHTML = `
      ${callStatusHtml(state.peerName, "Calling…")}
      <div class="call-actions">
        <button id="callEndBtn" class="call-btn call-btn-end" title="End call">📞</button>
      </div>`;
  } else if (state.status === "incoming") {
    overlay.innerHTML = `
      ${callStatusHtml(state.peerName, "Incoming call…")}
      <div class="call-actions">
        <button id="callDeclineBtn" class="call-btn call-btn-end" title="Decline">📞</button>
        <button id="callAcceptBtn" class="call-btn call-btn-accept" title="Accept">📞</button>
      </div>`;
  } else if (state.status === "connecting") {
    overlay.innerHTML = `
      ${callStatusHtml(state.peerName, "Connecting…")}
      <div class="call-actions">
        <button id="callEndBtn" class="call-btn call-btn-end" title="End call">📞</button>
      </div>`;
  } else if (state.status === "connected") {
    overlay.innerHTML = `
      ${callStatusHtml(state.peerName, formatDuration(state.durationSeconds ?? 0))}
      <div class="call-actions">
        <button id="callMuteBtn" class="call-btn ${state.isMuted ? "call-btn-active" : ""}" title="Mute">${state.isMuted ? "🔇" : "🎙️"}</button>
        <button id="callEndBtn" class="call-btn call-btn-end" title="End call">📞</button>
      </div>`;
  } else if (state.status === "ended") {
    overlay.innerHTML = callStatusHtml("", state.reason || "Call ended");
  }

  overlay.querySelector("#callEndBtn")?.addEventListener("click", () => callController?.endCall());
  overlay.querySelector("#callAcceptBtn")?.addEventListener("click", () => callController?.acceptCall());
  overlay.querySelector("#callDeclineBtn")?.addEventListener("click", () => callController?.declineCall());
  overlay.querySelector("#callMuteBtn")?.addEventListener("click", () => callController?.toggleMute());
}