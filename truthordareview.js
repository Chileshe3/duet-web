import { auth } from "./firebase.js";
import {
  TRUTH_OR_DARE_PROMPTS, watchActiveSessionId, startSession,
  watchSession, choosePrompt, completeRound, endSession
} from "./truthordare.js";

const overlayEl = document.getElementById("truthOrDareOverlay");
const fabContainerEl = document.getElementById("truthOrDareFabContainer");

let unsubActiveSession = null;
let unsubSession = null;
let currentCoupleId = null;
let currentSessionId = null;
let currentSession = null;
let isOpen = false;

export function showGameFab(coupleId) {
  if (!fabContainerEl) return;
  fabContainerEl.innerHTML = `<button id="todFab" class="game-fab game-fab-dare">🎯</button>`;
  document.getElementById("todFab").onclick = () => openGameOverlay(coupleId);
}

export function hideGameFab() {
  if (fabContainerEl) fabContainerEl.innerHTML = "";
}

export function openGameOverlay(coupleId) {
  isOpen = true;
  currentCoupleId = coupleId;
  watchActive(coupleId);
  renderOverlay();
}

export function closeGameOverlay() {
  isOpen = false;
  renderOverlay();
}

export function teardownGameOverlay() {
  if (unsubActiveSession) { unsubActiveSession(); unsubActiveSession = null; }
  if (unsubSession) { unsubSession(); unsubSession = null; }
  currentCoupleId = null;
  currentSessionId = null;
  currentSession = null;
  isOpen = false;
  if (overlayEl) { overlayEl.style.display = "none"; overlayEl.innerHTML = ""; }
}

function watchActive(coupleId) {
  if (unsubActiveSession) unsubActiveSession();
  unsubActiveSession = watchActiveSessionId(coupleId, (sessionId) => {
    if (sessionId === currentSessionId) return;
    currentSessionId = sessionId;
    if (unsubSession) { unsubSession(); unsubSession = null; }
    currentSession = null;
    if (sessionId) {
      unsubSession = watchSession(coupleId, sessionId, (session) => {
        currentSession = session;
        renderOverlay();
      });
    } else {
      renderOverlay();
    }
  });
}

function promptFor(promptId) {
  return TRUTH_OR_DARE_PROMPTS.find((p) => p.id === promptId);
}

function pickPrompt(session, type, excludingPromptId) {
  const usedIds = new Set(Object.values(session.rounds || {}).map((r) => r.promptId));
  usedIds.delete(excludingPromptId);
  const candidates = TRUTH_OR_DARE_PROMPTS.filter((p) => p.type === type && !usedIds.has(p.id));
  const pool = candidates.length > 0 ? candidates : TRUTH_OR_DARE_PROMPTS.filter((p) => p.type === type);
  return pool[Math.floor(Math.random() * pool.length)];
}

function computeState() {
  const uid = auth.currentUser?.uid;
  if (!currentSession) return { stage: "start" };

  const playerOrder = currentSession.playerOrder || [];
  const idx = currentSession.currentRoundIndex || 0;
  const currentTurnUid = playerOrder.length > 0 ? playerOrder[idx % playerOrder.length] : null;
  const isMyTurn = uid != null && currentTurnUid === uid;
  const round = (currentSession.rounds || {})[String(idx)] || null;
  const completedTurns = Object.values(currentSession.rounds || {}).filter((r) => r.status === "complete").length;

  if (!round) {
    return { stage: isMyTurn ? "choose_type" : "waiting_choice", turnNumber: idx + 1, completedTurns };
  }

  return {
    stage: "round",
    turnNumber: idx + 1,
    completedTurns,
    round,
    prompt: promptFor(round.promptId),
    isMyChoice: round.chooserUid === uid,
    isMyTurn
  };
}

function renderOverlay() {
  if (!overlayEl) return;
  if (!isOpen) { overlayEl.style.display = "none"; overlayEl.innerHTML = ""; return; }
  overlayEl.style.display = "flex";

  const state = computeState();
  let bodyHtml = "";

  if (state.stage === "start") {
    bodyHtml = `
      <h2>Truth or dare</h2>
      <p>Take turns — pick truth or dare, then hand it back.</p>
      <button id="todStart">Start</button>
    `;
  } else if (state.stage === "choose_type") {
    bodyHtml = `
      <p class="game-round-label">Turn ${state.turnNumber}${state.completedTurns > 0 ? ` · ${state.completedTurns} completed` : ""}</p>
      <p class="game-prompt">Truth or dare?</p>
      <button class="game-option" id="chooseTruth">💬 Truth</button>
      <button class="game-option" id="chooseDare">🎲 Dare</button>
    `;
  } else if (state.stage === "waiting_choice") {
    bodyHtml = `
      <p class="game-round-label">Turn ${state.turnNumber}${state.completedTurns > 0 ? ` · ${state.completedTurns} completed` : ""}</p>
      <p class="hint">Waiting for your partner to choose…</p>
    `;
  } else if (state.stage === "round") {
    const { round, prompt, isMyChoice, completedTurns, turnNumber } = state;
    bodyHtml = `
      <p class="game-round-label">Turn ${turnNumber}${completedTurns > 0 ? ` · ${completedTurns} completed` : ""}</p>
      <p class="game-note" style="text-transform:uppercase;font-weight:600;color:#d1477a;">
        ${round.type === "truth" ? "Truth" : "Dare"}
      </p>
      <p class="game-prompt">${prompt ? prompt.text : "Loading prompt…"}</p>
      <button id="todComplete">We did it — next turn</button>
      ${isMyChoice ? `<button id="todReroll" style="background:#eee;color:#333;margin-top:6px;">Try another</button>` : ""}
    `;
  }

  overlayEl.innerHTML = `
    <div class="game-card">
      <div class="game-header">
        <span>Truth or dare</span>
        <button id="todClose" class="icon-btn">×</button>
      </div>
      <div class="game-body">${bodyHtml}</div>
    </div>
  `;

  document.getElementById("todClose").onclick = () => {
    endSession(currentCoupleId).catch((e) => console.error("endSession failed", e));
    closeGameOverlay();
  };

  if (state.stage === "start") {
    document.getElementById("todStart").onclick = () => {
      const uid = auth.currentUser?.uid;
      if (!uid) return;
      startSession(currentCoupleId, uid).catch((e) => console.error("startSession failed", e));
    };
  } else if (state.stage === "choose_type") {
    document.getElementById("chooseTruth").onclick = () => chooseType("truth");
    document.getElementById("chooseDare").onclick = () => chooseType("dare");
  } else if (state.stage === "round") {
    document.getElementById("todComplete").onclick = () => {
      completeRound(currentCoupleId, currentSessionId, currentSession.currentRoundIndex)
        .catch((e) => console.error("completeRound failed", e));
    };
    const rerollBtn = document.getElementById("todReroll");
    if (rerollBtn) {
      rerollBtn.onclick = () => {
        const uid = auth.currentUser?.uid;
        const round = state.round;
        const newPrompt = pickPrompt(currentSession, round.type, round.promptId);
        choosePrompt(currentCoupleId, currentSessionId, currentSession.currentRoundIndex, uid, round.type, newPrompt.id)
          .catch((e) => console.error("reroll failed", e));
      };
    }
  }
}

function chooseType(type) {
  const uid = auth.currentUser?.uid;
  if (!uid || !currentSession) return;
  const prompt = pickPrompt(currentSession, type, null);
  choosePrompt(currentCoupleId, currentSessionId, currentSession.currentRoundIndex, uid, type, prompt.id)
    .catch((e) => console.error("choosePrompt failed", e));
}