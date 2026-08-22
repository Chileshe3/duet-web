import { db } from "./firebase.js";
import {
  doc, setDoc, updateDoc, onSnapshot, collection
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ROUNDS_PER_SESSION = 8;

export const THIS_OR_THAT_PAIRS = [
  { id: "beach_mountains", optionA: "Beach vacation", optionB: "Mountain cabin" },
  { id: "morning_night", optionA: "Morning person", optionB: "Night owl" },
  { id: "save_spend", optionA: "Save it", optionB: "Spend it" },
  { id: "dogs_cats", optionA: "Dog person", optionB: "Cat person" },
  { id: "home_travel", optionA: "Cozy night in", optionB: "Spontaneous trip" },
  { id: "sweet_savory", optionA: "Sweet snacks", optionB: "Savory snacks" },
  { id: "plan_wing", optionA: "Plan every detail", optionB: "Wing it" },
  { id: "early_late", optionA: "Early to bed", optionB: "Up late" },
  { id: "text_call", optionA: "Text it out", optionB: "Call to talk" },
  { id: "city_nature", optionA: "Big city", optionB: "Out in nature" },
  { id: "coffee_tea", optionA: "Coffee", optionB: "Tea" },
  { id: "movie_book", optionA: "Movie night", optionB: "Curl up with a book" },
  { id: "summer_winter", optionA: "Summer", optionB: "Winter" },
  { id: "silence_noise", optionA: "Comfortable silence", optionB: "Always talking" },
  { id: "indoor_outdoor", optionA: "Indoor date", optionB: "Outdoor date" }
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function coupleRef(coupleId) {
  return doc(db, "couples", coupleId);
}

function sessionRef(coupleId, sessionId) {
  return doc(db, "couples", coupleId, "thisOrThatSessions", sessionId);
}

// Which session is "live" is a pointer field on the couple doc itself, so either
// partner opening the overlay joins the same session with no separate invite step.
export function watchActiveSessionId(coupleId, callback) {
  return onSnapshot(coupleRef(coupleId), (snap) => {
    callback(snap.data()?.activeThisOrThatSessionId || null);
  });
}

export async function startSession(coupleId) {
  const roundIds = shuffle(THIS_OR_THAT_PAIRS.map((p) => p.id)).slice(0, ROUNDS_PER_SESSION);
  const ref = doc(collection(db, "couples", coupleId, "thisOrThatSessions"));
  await setDoc(ref, {
    roundIds,
    currentRoundIndex: 0,
    createdAtMillis: Date.now()
  });
  await setDoc(coupleRef(coupleId), { activeThisOrThatSessionId: ref.id }, { merge: true });
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

// Dotted-path update on rounds.<index>.answers.<uid> — same convention as
// DailyAnswerRepository, so this can never clobber a partner's answer already
// written for this round.
export async function submitChoice(coupleId, sessionId, roundIndex, uid, choice) {
  await updateDoc(sessionRef(coupleId, sessionId), {
    [`rounds.${roundIndex}.answers.${uid}`]: { choice, timestampMillis: Date.now() }
  });
}

export async function advanceRound(coupleId, sessionId, nextRoundIndex) {
  await updateDoc(sessionRef(coupleId, sessionId), { currentRoundIndex: nextRoundIndex });
}

export async function endSession(coupleId) {
  await updateDoc(coupleRef(coupleId), { activeThisOrThatSessionId: null });
}