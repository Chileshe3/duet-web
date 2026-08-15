import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  onSnapshot, collection, query, where, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export async function ensureUserDocument(uid, email) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    if (!data.email && email) await updateDoc(ref, { email });
    return;
  }
  await setDoc(ref, {
    uid, email,
    username: "",
    partnerUid: null,
    coupleId: null,
    pairingSkipped: false,
    profileComplete: false
  });
}

export function watchProfile(uid, onChange) {
  return onSnapshot(doc(db, "users", uid), (snap) => {
    onChange(snap.exists() ? snap.data() : null);
  });
}

export async function completeProfile(uid, usernameRaw) {
  const trimmed = usernameRaw.trim();
  if (trimmed.length < 3) throw new Error("Username must be at least 3 characters");
  const normalized = trimmed.toLowerCase();

  const usernameRef = doc(db, "usernames", normalized);
  const existingOwner = await getDoc(usernameRef);
  if (existingOwner.exists() && existingOwner.data().uid !== uid) {
    throw new Error("That username is taken");
  }

  const batch = writeBatch(db);
  batch.set(usernameRef, { uid });
  batch.set(doc(db, "users", uid), { username: trimmed, profileComplete: true }, { merge: true });
  await batch.commit();
}

// ---------------- Username-based pair requests ----------------
// Mirrors CoupleRepository.kt: `usernames/{username}` maps to a uid,
// `pairRequests/{toUid}` holds a pending invite (doc id = recipient's uid,
// so there's at most one pending invite per recipient by construction),
// and `couples/{coupleId}` holds the paired users once accepted.

/** Sends an invite to `partnerUsernameRaw`. Throws if the username doesn't exist. */
export async function sendPairRequest(myUid, myUsername, partnerUsernameRaw) {
  const partnerTrimmed = partnerUsernameRaw.trim();
  const partnerNormalized = partnerTrimmed.toLowerCase();
  if (!partnerNormalized) throw new Error("Enter your partner's username");

  const usernameSnap = await getDoc(doc(db, "usernames", partnerNormalized));
  const targetUid = usernameSnap.exists() ? usernameSnap.data().uid : null;
  if (!targetUid) throw new Error("No user found with that username");
  if (targetUid === myUid) throw new Error("You can't pair with yourself");

  try {
    await setDoc(doc(db, "pairRequests", targetUid), {
      fromUid: myUid,
      fromUsername: myUsername,
      toUid: targetUid,
      toUsername: partnerTrimmed,
      createdAt: serverTimestamp()
    });
  } catch (e) {
    if (e.code === "permission-denied") {
      throw new Error("Couldn't complete that — they may already be paired, or there's already a pending invite");
    }
    throw e;
  }

  return targetUid;
}

/** Live stream of the request I sent out (at most one at a time). */
export function watchOutgoingPairRequest(myUid, onChange) {
  const q = query(collection(db, "pairRequests"), where("fromUid", "==", myUid));
  return onSnapshot(q, (snap) => {
    const docSnap = snap.docs.find(d => d.exists());
    onChange(docSnap ? { toUid: docSnap.id, ...docSnap.data() } : null);
  });
}

/** Live stream of a request sent to me — doc id is my own uid, so there's at most one. */
export function watchIncomingPairRequest(myUid, onChange) {
  return onSnapshot(doc(db, "pairRequests", myUid), (snap) => {
    onChange(snap.exists() ? { fromUid: snap.data().fromUid, fromUsername: snap.data().fromUsername } : null);
  });
}

/** Cancels a request I sent. No-op if it's already gone or was already accepted. */
export async function cancelPairRequest(myUid, targetUid) {
  const ref = doc(db, "pairRequests", targetUid);
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists() && snap.data().fromUid === myUid) {
      txn.delete(ref);
    }
  });
}

/** Accepts the pending request addressed to me. Returns the new coupleId. */
export async function acceptPairRequest(myUid) {
  const myRequestRef = doc(db, "pairRequests", myUid);

  const coupleId = await runTransaction(db, async (txn) => {
    const requestSnap = await txn.get(myRequestRef);
    if (!requestSnap.exists()) throw new Error("That invite is no longer available");
    const fromUid = requestSnap.data().fromUid;
    if (!fromUid) throw new Error("That invite is no longer available");

    const mySnap = await txn.get(doc(db, "users", myUid));
    if (mySnap.data()?.coupleId) throw new Error("You're already paired");

    const newCoupleId = "CP-" + Math.floor(100000 + Math.random() * 900000);
    txn.update(doc(db, "users", myUid), { partnerUid: fromUid, coupleId: newCoupleId });
    txn.update(doc(db, "users", fromUid), { partnerUid: myUid, coupleId: newCoupleId });
    txn.set(doc(db, "couples", newCoupleId), {
      members: [myUid, fromUid],
      pairedAt: serverTimestamp(),
      active: true
    });
    txn.delete(myRequestRef);
    return newCoupleId;
  });

  return coupleId;
}

/** Rejects (deletes) the pending request addressed to me. */
export async function rejectPairRequest(myUid) {
  await deleteDoc(doc(db, "pairRequests", myUid));
}

// ---------------- Unpair ----------------

export async function unpairPartner(uid) {
  const profileSnap = await getDoc(doc(db, "users", uid));
  const profile = profileSnap.data();
  const partnerUid = profile?.partnerUid;
  const coupleId = profile?.coupleId;

  await runTransaction(db, async (txn) => {
    txn.update(doc(db, "users", uid), { partnerUid: null, coupleId: null });
    if (partnerUid) txn.update(doc(db, "users", partnerUid), { partnerUid: null, coupleId: null });
    if (coupleId) txn.update(doc(db, "couples", coupleId), { active: false });
  });
}