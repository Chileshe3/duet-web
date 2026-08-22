import { db } from "./firebase.js";
import {
  doc, setDoc, updateDoc, onSnapshot, collection
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ROUNDS_PER_SESSION = 8;
const GUESS_ROUNDS_PER_SESSION = 2;

export const WOULD_YOU_RATHER_PAIRS = [
  { id: "wyr_texting_calling", optionA: "Never text again (calls only)", optionB: "Never call again (texts only)" },
  { id: "wyr_read_mind", optionA: "Read your partner's mind for a day", optionB: "Have your partner read yours" },
  { id: "wyr_forget_remember_arguments", optionA: "Forget every argument you've ever had", optionB: "Remember every one in perfect detail" },
  { id: "wyr_famous_anonymous", optionA: "Be famous together", optionB: "Stay anonymous forever" },
  { id: "wyr_time_travel", optionA: "Time travel to your first date", optionB: "Time travel to see your future together" },
  { id: "wyr_cook_eat_out", optionA: "Never cook again", optionB: "Never eat out again" },
  { id: "wyr_taste_smell", optionA: "Lose your sense of taste", optionB: "Lose your sense of smell" },
  { id: "wyr_lottery_decade", optionA: "Win the lottery", optionB: "Get ten extra healthy years together" },
  { id: "wyr_right_forgiven", optionA: "Always be right in arguments", optionB: "Always be instantly forgiven" },
  { id: "wyr_no_ac_no_heat", optionA: "Live somewhere with no AC", optionB: "Live somewhere with no heat" },
  { id: "wyr_abroad_never_travel", optionA: "Live abroad for a year", optionB: "Never travel outside your country" },
  { id: "wyr_silent_yelling", optionA: "Get the silent treatment", optionB: "Get yelled at (then it's over)" },
  { id: "wyr_relive_kiss_see_ending", optionA: "Relive your first kiss on repeat", optionB: "See how your story ends" },
  { id: "wyr_same_job_opposite_hobbies", optionA: "Have the exact same job as your partner", optionB: "Have completely opposite hobbies" },
  { id: "wyr_no_phones_no_privacy", optionA: "No phones for a month", optionB: "Zero privacy from each other for a month" },
  { id: "wyr_bigger_house_more_time", optionA: "Have a bigger house", optionB: "Have more free time together" }
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
  return doc(db, "couples", coupleId, "wouldYouRatherSessions", sessionId);
}

export function watchActiveSessionId(coupleId, callback) {
  return onSnapshot(coupleRef(coupleId), (snap) => {
    callback(snap.data()?.activeWouldYouRatherSessionId || null);
  });
}

export async function startSession(coupleId) {
  const roundIds = shuffle(WOULD_YOU_RATHER_PAIRS.map((p) => p.id)).slice(0, ROUNDS_PER_SESSION);
  const guessableIndices = shuffle(roundIds.map((_, i) => i).filter((i) => i >= 2));
  const guessIndexSet = new Set(guessableIndices.slice(0, GUESS_ROUNDS_PER_SESSION));
  const roundTypes = roundIds.map((_, i) => (guessIndexSet.has(i) ? "guess" : "match"));

  const ref = doc(collection(db, "couples", coupleId, "wouldYouRatherSessions"));
  await setDoc(ref, {
    roundIds,
    roundTypes,
    currentRoundIndex: 0,
    createdAtMillis: Date.now()
  });
  await setDoc(coupleRef(coupleId), { activeWouldYouRatherSessionId: ref.id }, { merge: true });
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

export async function submitChoice(coupleId, sessionId, roundIndex, uid, choice) {
  await updateDoc(sessionRef(coupleId, sessionId), {
    [`rounds.${roundIndex}.answers.${uid}`]: { choice, timestampMillis: Date.now() }
  });
}

export async function submitPrediction(coupleId, sessionId, roundIndex, uid, predictedChoice) {
  await updateDoc(sessionRef(coupleId, sessionId), {
    [`rounds.${roundIndex}.predictions.${uid}`]: { predictedChoice, timestampMillis: Date.now() }
  });
}

export async function advanceRound(coupleId, sessionId, nextRoundIndex) {
  await updateDoc(sessionRef(coupleId, sessionId), { currentRoundIndex: nextRoundIndex });
}

export async function endSession(coupleId) {
  await updateDoc(coupleRef(coupleId), { activeWouldYouRatherSessionId: null });
}