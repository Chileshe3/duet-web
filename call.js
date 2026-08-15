import { db } from "./firebase.js";
import {
  collection, addDoc, doc, updateDoc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Mirrors the Android app's calls/{callId} schema exactly, so both clients
// can call each other through the same Firestore collection + rules.

export const CALL_STATUS = {
  RINGING: "ringing",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  ENDED: "ended"
};

export async function createCall(coupleId, callerUid, calleeUid, offerSdp) {
  const ref = await addDoc(collection(db, "calls"), {
    coupleId,
    callerUid,
    calleeUid,
    status: CALL_STATUS.RINGING,
    offerSdp,
    answerSdp: null,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function setAnswer(callId, answerSdp) {
  await updateDoc(doc(db, "calls", callId), {
    answerSdp,
    status: CALL_STATUS.ACCEPTED
  });
}

export async function updateCallStatus(callId, status) {
  await updateDoc(doc(db, "calls", callId), { status });
}

export async function addIceCandidate(callId, isCaller, candidate) {
  const sub = isCaller ? "callerCandidates" : "calleeCandidates";
  await addDoc(collection(db, "calls", callId, sub), {
    sdpMid: candidate.sdpMid ?? "",
    sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
    candidate: candidate.candidate ?? ""
  });
}

/** Listens to the call doc itself — status changes, the answer arriving, etc. */
export function observeCall(callId, onChange) {
  return onSnapshot(doc(db, "calls", callId), (snap) => {
    onChange(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

/** Listens for newly-added candidates from one side. Pass listenToCaller=true to hear the caller's. */
export function observeCandidates(callId, listenToCaller, onCandidate) {
  const sub = listenToCaller ? "callerCandidates" : "calleeCandidates";
  return onSnapshot(collection(db, "calls", callId, sub), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") onCandidate(change.doc.data());
    });
  });
}

/** Listens for any call ringing for me right now. Only fires while this tab is open. */
export function observeIncomingCalls(myUid, onIncoming) {
  const q = query(
    collection(db, "calls"),
    where("calleeUid", "==", myUid),
    where("status", "==", CALL_STATUS.RINGING)
  );
  return onSnapshot(q, (snap) => {
    const d = snap.docs[0];
    onIncoming(d ? { id: d.id, ...d.data() } : null);
  });
}