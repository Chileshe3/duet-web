import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  onSnapshot, collection, query, where, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function listenForIncomingPairing(myUid, myEmail, getCurrentProfile, onError) {
  const normalized = myEmail.trim().toLowerCase();
  const q = query(collection(db, "pairIntents"), where("targetEmail", "==", normalized));
  return onSnapshot(q, async (snap) => {
    const docSnap = snap.docs.find(d => d.exists());
    if (!docSnap) return;
    if (getCurrentProfile()?.coupleId) return;
    const intent = {
      fromUid: docSnap.data().fromUid,
      fromEmail: docSnap.id,
      targetEmail: docSnap.data().targetEmail
    };
    if (!intent.fromUid) return;
    try {
      await completeIncomingPairing(myUid, normalized, intent);
    } catch (e) {
      onError?.(e);
    }
  });
}

async function completeIncomingPairing(myUid, myEmail, intent) {
  const intentRef = doc(db, "pairIntents", intent.fromEmail);
  const myIntentRef = doc(db, "pairIntents", myEmail);
  await runTransaction(db, async (txn) => {
    const mySnap = await txn.get(doc(db, "users", myUid));
    if (mySnap.data()?.coupleId) return;

    const intentSnap = await txn.get(intentRef);
    if (!intentSnap.exists() || intentSnap.data().targetEmail !== myEmail) return;
    const partnerUid = intentSnap.data().fromUid;
    if (!partnerUid) return;

    const coupleId = "CP-" + Math.floor(100000 + Math.random() * 900000);
    txn.update(doc(db, "users", myUid), { partnerUid, coupleId });
    txn.update(doc(db, "users", partnerUid), { partnerUid: myUid, coupleId });
    txn.set(doc(db, "couples", coupleId), {
      members: [myUid, partnerUid],
      pairedAt: serverTimestamp(),
      active: true
    });
    txn.delete(intentRef);
    txn.delete(myIntentRef);
  });
}

export async function submitPartnerEmail(myUid, myEmail, partnerEmailRaw) {
  const myNormalized = myEmail.trim().toLowerCase();
  const partnerNormalized = partnerEmailRaw.trim().toLowerCase();

  if (!EMAIL_REGEX.test(partnerNormalized)) throw new Error("Enter a valid email address");
  if (partnerNormalized === myNormalized) throw new Error("You can't pair with yourself");

  const myIntentRef = doc(db, "pairIntents", myNormalized);
  const reverseIntentRef = doc(db, "pairIntents", partnerNormalized);

  return await runTransaction(db, async (txn) => {
    const mySnap = await txn.get(doc(db, "users", myUid));
    if (mySnap.data()?.coupleId) throw new Error("You're already paired");

    const reverseSnap = await txn.get(reverseIntentRef);
    const reverseTarget = reverseSnap.exists() ? reverseSnap.data().targetEmail : null;
    const reverseFromUid = reverseSnap.exists() ? reverseSnap.data().fromUid : null;

    if (reverseSnap.exists() && reverseTarget === myNormalized && reverseFromUid) {
      const coupleId = "CP-" + Math.floor(100000 + Math.random() * 900000);
      txn.update(doc(db, "users", myUid), { partnerUid: reverseFromUid, coupleId });
      txn.update(doc(db, "users", reverseFromUid), { partnerUid: myUid, coupleId });
      txn.set(doc(db, "couples", coupleId), {
        members: [myUid, reverseFromUid],
        pairedAt: serverTimestamp(),
        active: true
      });
      txn.delete(reverseIntentRef);
      txn.delete(myIntentRef);
      return { type: "paired", coupleId };
    } else {
      txn.set(myIntentRef, {
        fromUid: myUid,
        fromEmail: myNormalized,
        targetEmail: partnerNormalized,
        createdAt: serverTimestamp()
      });
      return { type: "waiting" };
    }
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

  try {
    await deleteDoc(doc(db, "pairIntents", (profile?.email || "").trim().toLowerCase()));
  } catch {}
  if (partnerUid) {
    const partnerSnap = await getDoc(doc(db, "users", partnerUid));
    const partnerEmail = partnerSnap.data()?.email;
    if (partnerEmail) {
      try { await deleteDoc(doc(db, "pairIntents", partnerEmail.trim().toLowerCase())); } catch {}
    }
  }
}