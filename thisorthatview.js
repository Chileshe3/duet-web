import { auth } from "./firebase.js";
import {
  THIS_OR_THAT_PAIRS, watchActiveSessionId, startSession,
  watchSession, submitChoice, submitPrediction, advanceRound, endSession
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

function roundTypeAt(session, index) {
  return (session.roundTypes && session.roundTypes[index]) || "match";
}

function optionText(pair, choice) {
  return choice === "A" ? pair.optionA : pair.optionB;
}

function computeMatchStats(session) {
  const rounds = session.rounds || {};
  const matchIndices = session.roundIds.map((_, i) => i).filter((i) => roundTypeAt(session, i) === "match");
  const agreed = matchIndices.filter((i) => {
    const choices = Object.values((rounds[String(i)] || {}).answers || {}).map((a) => a.choice);
    return choices.length === 2 && choices[0] === choices[1];
  }).length;
  return { total: matchIndices.length, agreed };
}

function computeGuessStats(session) {
  const rounds = session.rounds || {};
  const guessIndices = session.roundIds.map((_, i) => i).filter((i) => roundTypeAt(session, i) === "guess");
  let total = 0;
  let correct = 0;
  guessIndices.forEach((i) => {
    const round = rounds[String(i)] || {};
    const answers = round.answers || {};
    const predictions = round.predictions || {};
    if (Object.keys(answers).length === 2 && Object.keys(predictions).length === 2) {
      total += 2;
      Object.entries(predictions).forEach(([predictorUid, prediction]) => {
        const theirEntry = Object.entries(answers).find(([uid]) => uid !== predictorUid);
        if (theirEntry && theirEntry[1].choice === prediction.predictedChoice) correct += 1;
      });
    }
  });
  return { total, correct };
}

function computeState() {
  const uid = auth.currentUser?.uid;
  if (!currentSession) return { stage: "start" };

  const idx = currentSession.currentRoundIndex;
  if (idx >= currentSession.roundIds.length) {
    const matchStats = computeMatchStats(currentSession);
    const guessStats = computeGuessStats(currentSession);
    const percent = matchStats.total === 0 ? 0 : Math.round((matchStats.agreed / matchStats.total) * 100);
    return { stage: "complete", percent, guessStats };
  }

  const roundType = roundTypeAt(currentSession, idx);
  const round = (currentSession.rounds || {})[String(idx)] || {};
  const answers = round.answers || {};
  const predictions = round.predictions || {};
  const pair = pairFor(currentSession.roundIds[idx]);

  const myChoice = answers[uid]?.choice || null;
  const partnerAnswerEntry = Object.entries(answers).find(([k]) => k !== uid);
  const partnerChoice = myChoice ? (partnerAnswerEntry?.[1]?.choice || null) : null;

  if (roundType === "guess") {
    const myPrediction = predictions[uid]?.predictedChoice || null;
    const partnerPredictionEntry = Object.entries(predictions).find(([k]) => k !== uid);
    const partnerPrediction = myChoice ? (partnerPredictionEntry?.[1]?.predictedChoice || null) : null;
    const bothAnswered = myChoice != null && partnerChoice != null;

    let guessStage;
    if (myPrediction == null) guessStage = "predicting";
    else if (myChoice == null) guessStage = "choosing";
    else if (!bothAnswered) guessStage = "waiting";
    else guessStage = "revealed";

    return {
      stage: "guess_round",
      roundNumber: idx + 1,
      total: currentSession.roundIds.length,
      pair, myChoice, partnerChoice, myPrediction, partnerPrediction, bothAnswered, guessStage
    };
  }

  return {
    stage: "round",
    roundNumber: idx + 1,
    total: currentSession.roundIds.length,
    pair,
    myChoice,
    partnerChoice,
    bothAnswered: myChoice != null && partnerChoice != null,
    matchCount: computeMatchStats(currentSession).agreed
  };
}

function lockChoice(choice) {
  const uid = auth.currentUser?.uid;
  if (!uid || !currentCoupleId || !currentSessionId || !currentSession) return;
  submitChoice(currentCoupleId, currentSessionId, currentSession.currentRoundIndex, uid, choice)
    .catch((e) => console.error("submitChoice failed", e));
}

function lockPrediction(choice) {
  const uid = auth.currentUser?.uid;
  if (!uid || !currentCoupleId || !currentSessionId || !currentSession) return;
  submitPrediction(currentCoupleId, currentSessionId, currentSession.currentRoundIndex, uid, choice)
    .catch((e) => console.error("submitPrediction failed", e));
}

function connectionTagline(percent) {
  if (percent >= 85) return "Two peas in a pod 💕";
  if (percent >= 50) return "Well matched 🙂";
  return "Opposites attract 😅";
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
      <p>Eight rounds — most are quick picks, a couple are "guess what they'll choose." Lock in first, see who knows who best.</p>
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
  } else if (state.stage === "guess_round") {
    const { pair, roundNumber, total, myChoice, partnerChoice, myPrediction, guessStage } = state;
    bodyHtml = `<p class="game-round-label">Round ${roundNumber} of ${total} · 🔮 Guess round</p>`;

    if (guessStage === "predicting") {
      bodyHtml += `
        <p class="game-prompt">What will your partner choose?</p>
        <button class="game-option" id="predA">${pair.optionA}</button>
        <p class="game-or">or</p>
        <button class="game-option" id="predB">${pair.optionB}</button>
      `;
    } else if (guessStage === "choosing") {
      bodyHtml += `
        <p class="game-note">Your guess: ${optionText(pair, myPrediction)}</p>
        <p class="game-prompt">Now, what do YOU choose?</p>
        <button class="game-option" id="optA">${pair.optionA}</button>
        <p class="game-or">or</p>
        <button class="game-option" id="optB">${pair.optionB}</button>
      `;
    } else if (guessStage === "waiting") {
      bodyHtml += `<p class="hint">Waiting for your partner…</p>`;
    } else {
      const called = myPrediction === partnerChoice;
      const bothMatched = myChoice === partnerChoice;
      bodyHtml += `
        <p class="game-result">${called ? "❤️ You called it!" : "😭 Not this time"}</p>
        <p class="game-note">You guessed ${optionText(pair, myPrediction)} — they picked ${optionText(pair, partnerChoice)}</p>
        ${bothMatched ? `<p class="game-note">✨ Bonus — you both picked the same thing!</p>` : ""}
        <button id="gameNext">Next</button>
      `;
    }
  } else if (state.stage === "complete") {
    const { percent, guessStats } = state;
    bodyHtml = `
      <h2>💕 ${percent}% connected</h2>
      <p class="game-note">${connectionTagline(percent)}</p>
      ${guessStats.total > 0 ? `<p class="game-note">🔮 Mind Reader: ${guessStats.correct}/${guessStats.total} correct guesses</p>` : ""}
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
  } else if (state.stage === "guess_round") {
    if (state.guessStage === "predicting") {
      document.getElementById("predA").onclick = () => lockPrediction("A");
      document.getElementById("predB").onclick = () => lockPrediction("B");
    } else if (state.guessStage === "choosing") {
      document.getElementById("optA").onclick = () => lockChoice("A");
      document.getElementById("optB").onclick = () => lockChoice("B");
    } else if (state.guessStage === "revealed") {
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