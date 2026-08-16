import { db } from "./firebase.js";
import {
  collection, addDoc, doc, updateDoc,
  onSnapshot, orderBy, limit, query
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Same shape as com.duet.couples.data.thinkingofyou — nudges live under the
// shared couple document at couples/{coupleId}/nudges.

function nudgesCollection(coupleId) {
  return collection(db, "couples", coupleId, "nudges");
}

export async function sendNudge(coupleId, fromUid, emoji, message) {
  await addDoc(nudgesCollection(coupleId), {
    fromUid,
    emoji,
    message,
    timestampMillis: Date.now(),
    seen: false
  });
}

/** Live stream of the most recent nudges for the couple, newest first. */
export function watchRecentNudges(coupleId, onChange, count = 20) {
  const q = query(nudgesCollection(coupleId), orderBy("timestampMillis", "desc"), limit(count));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function markNudgeSeen(coupleId, nudgeId) {
  await updateDoc(doc(db, "couples", coupleId, "nudges", nudgeId), { seen: true });
}