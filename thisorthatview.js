import { auth } from "./firebase.js";
import {
  THIS_OR_THAT_PAIRS, watchActiveSessionId, startSession,
  watchSession, submitChoice, advanceRound, endSession
} from "./thisorthat.js";

const overlayEl = document.getElementById("gameOverlay");
const fabContainerEl = document.getElementById("gameFabContainer");

let unsubActiveSession = null;
let unsubSession = null;
let currentCoupleId = null;
let currentSessionId = null;
let currentSession = null;
let isOpen = false;

export function showGameFab(coupleId) {
  if (!fabContainerEl) return;
  fabContainerEl.innerHTML = `<button id="gameFab" class="game-fab">🎲</button>`;
  document.getElementById("gameFab").onclick = () => openGameOverlay(coupleId);
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

function pairFor(pairId) {
  return THIS_OR_THAT_PAIRS.find((p) => p.id === pairId);
}

function countMatches(session) {
  const rounds = session.rounds || {};
  return Object.values(rounds).filter((r) => {
    const choices = Object.values(r.answers || {}).map((a) => a.choice);
    return choices.length === 2 && choices[0] === choices[1];
  }).length;
}

function computeState() {
  const uid = auth.currentUser?.uid;
  if (!currentSession) return { stage: "start" };

  const idx = currentSession.currentRoundIndex;
  if (idx >= currentSession.roundIds.length) {
    return { stage: "complete", matchCount: countMatches(currentSession), total: currentSession.roundIds.length };
  }

  const round = (currentSession.rounds || {})[String(idx)] || {};
  const answers = round.answers || {};
  const myChoice = answers[uid]?.choice || null;
  const partnerEntry = Object.entries(answers).find(([k]) => k !== uid);
  // Same convention as Daily Question: partner's pick only reveals once you've locked yours in.
  const partnerChoice = myChoice ? (partnerEntry?.[1]?.choice || null) : null;

  return {
    stage: "round",
    pair: pairFor(currentSession.roundIds[idx]),
    roundNumber: idx + 1,
    total: currentSession.roundIds.length,
    myChoice,
    partnerChoice,
    bothAnswered: myChoice != null && partnerChoice != null,
    matchCount: countMatches(currentSession)
  };
}

function lockChoice(choice) {
  const uid = auth.currentUser?.uid;
  if (!uid || !currentCoupleId || !currentSessionId || !currentSession) return;
  submitChoice(currentCoupleId, currentSessionId, currentSession.currentRoundIndex, uid, choice)
    .catch((e) => console.error("submitChoice failed", e));
}

function renderOverlay() {
  if (!overlayEl) return;
  if (!isOpen) { overlayEl.style.display = "none"; overlayEl.innerHTML = ""; return; }
  overlayEl.style.display = "flex";

  const state = computeState();
  let bodyHtml = "";

  if (state.stage === "start") {
    bodyHtml = `
      <h2>Ready for a round?</h2>
      <p>Eight quick picks. Lock in your answer before your partner does — see how many match.</p>
      <button id="gameStart">Start</button>
    `;
  } else if (state.stage === "round") {
    const { pair, roundNumber, total, myChoice, partnerChoice, bothAnswered, matchCount } = state;
    bodyHtml = `
      <p class="game-round-label">Round ${roundNumber} of ${total}${matchCount > 0 ? ` · 🏆 ${matchCount} matched` : ""}</p>
      <button class="game-option ${myChoice === "A" ? "selected" : ""}" id="optA" ${myChoice ? "disabled" : ""}>${pair.optionA}</button>
      <p class="game-or">or</p>
      <button class="game-option ${myChoice === "B" ? "selected" : ""}" id="optB" ${myChoice ? "disabled" : ""}>${pair.optionB}</button>
      <div class="game-reveal">
        ${
          bothAnswered
            ? `<p class="game-result">${myChoice === partnerChoice ? "🎉 You matched!" : "Different picks this time"}</p><button id="gameNext">Next</button>`
            : (myChoice ? `<p class="hint">Waiting for your partner…</p>` : "")
        }
      </div>
    `;
  } else if (state.stage === "complete") {
    bodyHtml = `
      <h2>🏆 ${state.matchCount} / ${state.total} matched</h2>
      <div class="row">
        <button id="gamePlayAgain">Play again</button>
        <button id="gameDone">Done</button>
      </div>
    `;
  }

  overlayEl.innerHTML = `
    <div class="game-card">
      <div class="game-header">
        <span>This or that</span>
        <button id="gameClose" class="icon-btn">×</button>
      </div>
      <div class="game-body">${bodyHtml}</div>
    </div>
  `;

  document.getElementById("gameClose").onclick = () => {
    endSession(currentCoupleId).catch((e) => console.error("endSession failed", e));
    closeGameOverlay();
  };

  if (state.stage === "start") {
    document.getElementById("gameStart").onclick = () => {
      startSession(currentCoupleId).catch((e) => console.error("startSession failed", e));
    };
  } else if (state.stage === "round") {
    if (!state.myChoice) {
      document.getElementById("optA").onclick = () => lockChoice("A");
      document.getElementById("optB").onclick = () => lockChoice("B");
    }
    if (state.bothAnswered) {
      document.getElementById("gameNext").onclick = () => {
        advanceRound(currentCoupleId, currentSessionId, currentSession.currentRoundIndex + 1)
          .catch((e) => console.error("advanceRound failed", e));
      };
    }
  } else if (state.stage === "complete") {
    document.getElementById("gamePlayAgain").onclick = () => {
      startSession(currentCoupleId).catch((e) => console.error("startSession failed", e));
    };
    document.getElementById("gameDone").onclick = () => {
      endSession(currentCoupleId).catch((e) => console.error("endSession failed", e));
      closeGameOverlay();
    };
  }
}