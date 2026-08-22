import { db } from "./firebase.js";
import {
  doc, setDoc, updateDoc, onSnapshot, collection, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Static prompt bank — mirrors TruthOrDareModels.kt on the Android side.
// Keep both lists in sync if you add/edit prompts.
export const TRUTH_OR_DARE_PROMPTS = [
  ...[
    "What's a small thing I do that makes you fall for me all over again?",
    "What's a habit of mine that secretly annoys you (be honest)?",
    "What's the most nervous you've ever been around me?",
    "What's something you thought about telling me but chickened out?",
    "What's a memory of us you replay when you're having a bad day?",
    "What's one thing you'd want to change about how we argue?",
    "Who said 'I love you' first, and were you expecting it?",
    "What's a fear you have about our relationship that you don't say out loud?",
    "What's the most attractive thing I do without realizing it?",
    "What's a compliment you wish I gave you more often?",
    "What's something your friends know about how you feel about me that I don't?",
    "What's a compromise in this relationship you're proud of making?",
    "What's a moment you knew this was serious?",
    "What's your honest first impression of me?",
    "What's something you've never told me because it felt silly?",
    "What's a way I could make an ordinary Tuesday feel special to you?"
  ].map((text, i) => ({ id: `truth_${String(i + 1).padStart(3, "0")}`, type: "truth", text })),
  ...[
    "Give your partner a 30-second shoulder massage right now.",
    "Do your best impression of your partner for 20 seconds.",
    "Send your partner a text right now saying why you're glad you're together — no rereading, just send it.",
    "Let your partner pick your ringtone for the next 24 hours.",
    "Recreate the pose from your favorite photo of the two of you.",
    "Slow dance with your partner for 30 seconds, no music required.",
    "Whisper the plot of your favorite movie in your partner's ear like it's a secret.",
    "Give your partner three genuine compliments in a row, no repeats.",
    "Let your partner draw something on your hand with their finger and guess what it is.",
    "Do your partner's next chore for them without being asked twice.",
    "Speak in an accent for the next two turns.",
    "Write a two-line love note and read it out loud.",
    "Let your partner style your hair for the next five minutes, no complaints.",
    "Show your partner the most embarrassing photo on your phone.",
    "Serenade your partner with the first song that comes to mind.",
    "Hold eye contact with your partner for 30 seconds without laughing."
  ].map((text, i) => ({ id: `dare_${String(i + 1).padStart(3, "0")}`, type: "dare", text }))
];

function coupleRef(coupleId) {
  return doc(db, "couples", coupleId);
}

function sessionRef(coupleId, sessionId) {
  return doc(db, "couples", coupleId, "truthOrDareSessions", sessionId);
}

export function watchActiveSessionId(coupleId, callback) {
  return onSnapshot(coupleRef(coupleId), (snap) => {
    callback(snap.data()?.activeTruthOrDareSessionId || null);
  });
}

export async function startSession(coupleId, requestingUid) {
  const coupleSnap = await getDoc(coupleRef(coupleId));
  const members = coupleSnap.data()?.members || [];
  const partnerUid = members.find((m) => m !== requestingUid) || null;
  const playerOrder = partnerUid ? [requestingUid, partnerUid] : [requestingUid];

  const ref = doc(collection(db, "couples", coupleId, "truthOrDareSessions"));
  await setDoc(ref, {
    playerOrder,
    currentRoundIndex: 0,
    createdAtMillis: Date.now()
  });
  await setDoc(coupleRef(coupleId), { activeTruthOrDareSessionId: ref.id }, { merge: true });
  return ref.id;
}

export function watchSession(coupleId, sessionId, callback) {
  return onSnapshot(sessionRef(coupleId, sessionId), (snap) => {
    if (!snap.exists()) {
      callback(null);
      return;
    }
    callback({ sessionId, ...snap.data() });
  });
}

export async function choosePrompt(coupleId, sessionId, roundIndex, chooserUid, type, promptId) {
  await updateDoc(sessionRef(coupleId, sessionId), {
    [`rounds.${roundIndex}`]: { type, promptId, chooserUid, status: "in_progress" }
  });
}

export async function completeRound(coupleId, sessionId, roundIndex) {
  await updateDoc(sessionRef(coupleId, sessionId), {
    [`rounds.${roundIndex}.status`]: "complete",
    [`rounds.${roundIndex}.completedAtMillis`]: Date.now(),
    currentRoundIndex: roundIndex + 1
  });
}

export async function endSession(coupleId) {
  await updateDoc(coupleRef(coupleId), { activeTruthOrDareSessionId: null });
}