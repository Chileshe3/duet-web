import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, collection, query, where, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA7AyU-rb01OLe38Ee885KDTD3hAG53-po",
  authDomain: "duet-8b557.firebaseapp.com",
  databaseURL: "https://duet-8b557-default-rtdb.firebaseio.com",
  projectId: "duet-8b557",
  storageBucket: "duet-8b557.firebasestorage.app",
  messagingSenderId: "391763841086",
  appId: "1:391763841086:web:b8c7d540f50da9c5c4c16f",
  measurementId: "G-0M5VXDDDEJ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const root = document.getElementById("app");

let currentProfile = null;
let unsubProfile = null;
let unsubIntent = null;
let startedIncomingListener = false;

let uiStep = "choice"; // choice | enterEmail | waiting
let emailInput = "";
let submitError = "";
let isSubmitting = false;

// ---------------- Firestore logic (mirrors CoupleRepository.kt) ----------------

async function ensureUserDocument(uid, email) {
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

function watchProfile(uid) {
  if (unsubProfile) unsubProfile();
  unsubProfile = onSnapshot(doc(db, "users", uid), (snap) => {
    currentProfile = snap.exists() ? snap.data() : null;
    if (currentProfile?.email && !startedIncomingListener) {
      startedIncomingListener = true;
      listenForIncomingPairing(uid, currentProfile.email);
    }
    render();
  });
}

function listenForIncomingPairing(myUid, myEmail) {
  const normalized = myEmail.trim().toLowerCase();
  const q = query(collection(db, "pairIntents"), where("targetEmail", "==", normalized));
  unsubIntent = onSnapshot(q, async (snap) => {
    const docSnap = snap.docs.find(d => d.exists());
    if (!docSnap) return;
    if (currentProfile?.coupleId) return;
    const intent = {
      fromUid: docSnap.data().fromUid,
      fromEmail: docSnap.id,
      targetEmail: docSnap.data().targetEmail
    };
    if (!intent.fromUid) return;
    await completeIncomingPairing(myUid, normalized, intent);
  });
}

async function completeIncomingPairing(myUid, myEmail, intent) {
  const intentRef = doc(db, "pairIntents", intent.fromEmail);
  const myIntentRef = doc(db, "pairIntents", myEmail);
  try {
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
  } catch (e) {
    console.error("completeIncomingPairing failed", e);
  }
}

async function submitPartnerEmail(myUid, myEmail, partnerEmailRaw) {
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

async function unpairPartner(uid) {
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

// ---------------- Auth wiring ----------------

onAuthStateChanged(auth, (user) => {
  if (user) {
    uiStep = "choice";
    ensureUserDocument(user.uid, user.email || "").then(() => watchProfile(user.uid));
  } else {
    if (unsubProfile) unsubProfile();
    if (unsubIntent) unsubIntent();
    startedIncomingListener = false;
    currentProfile = null;
    renderAuth();
  }
});

async function doAuth(fn) {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("authError");
  errEl.textContent = "";
  try {
    await fn(auth, email, password);
  } catch (e) {
    errEl.textContent = e.message;
  }
}

// ---------------- Rendering ----------------

function renderAuth() {
  root.innerHTML = `
    <div class="card">
      <h1>Duet — Web Test Client</h1>
      <p class="hint">Sign in with a second test account (different email than your phone's account) to test pairing.</p>
      <input id="email" type="email" placeholder="Email" autocomplete="username" />
      <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
      <div class="row">
        <button id="signin">Sign In</button>
        <button id="signup">Create Account</button>
      </div>
      <p id="authError" class="error"></p>
    </div>
  `;
  document.getElementById("signin").onclick = () => doAuth(signInWithEmailAndPassword);
  document.getElementById("signup").onclick = () => doAuth(createUserWithEmailAndPassword);
}

function render() {
  if (!currentProfile) {
    root.innerHTML = `<div class="card"><p>Loading profile…</p></div>`;
    return;
  }
  const user = auth.currentUser;

  if (currentProfile.coupleId) {
    root.innerHTML = `
      <div class="card">
        <h1>💕 Paired</h1>
        <p>Signed in as ${user.email}</p>
        <p>Couple ID: <b>${currentProfile.coupleId}</b></p>
        <p>Partner UID: ${currentProfile.partnerUid || "—"}</p>
        <div class="row">
          <button id="unpair">Unpair</button>
          <button id="signout">Sign Out</button>
        </div>
      </div>
    `;
    document.getElementById("unpair").onclick = () => unpairPartner(user.uid);
    document.getElementById("signout").onclick = () => signOut(auth);
    return;
  }

  if (uiStep === "waiting") {
    root.innerHTML = `
      <div class="card">
        <h1>Waiting for partner…</h1>
        <p>Signed in as ${user.email}</p>
        <p class="hint">Now enter this account's email (<b>${user.email}</b>) as the partner email on your phone.</p>
        <div class="row">
          <button id="back">Back</button>
          <button id="signout">Sign Out</button>
        </div>
      </div>
    `;
    document.getElementById("back").onclick = () => { uiStep = "choice"; render(); };
    document.getElementById("signout").onclick = () => signOut(auth);
    return;
  }

  if (uiStep === "enterEmail") {
    root.innerHTML = `
      <div class="card">
        <h1>Enter partner's email</h1>
        <p>Signed in as ${user.email}</p>
        <input id="partnerEmail" type="email" placeholder="Partner's email" value="${emailInput}" />
        <p class="error">${submitError}</p>
        <div class="row">
          <button id="submit" ${isSubmitting ? "disabled" : ""}>${isSubmitting ? "Submitting…" : "Submit"}</button>
          <button id="back">Back</button>
        </div>
      </div>
    `;
    document.getElementById("back").onclick = () => { uiStep = "choice"; submitError = ""; render(); };
    document.getElementById("submit").onclick = async () => {
      emailInput = document.getElementById("partnerEmail").value;
      isSubmitting = true; submitError = "";
      render();
      try {
        const outcome = await submitPartnerEmail(user.uid, currentProfile.email || user.email, emailInput);
        isSubmitting = false;
        if (outcome.type === "waiting") uiStep = "waiting";
        render();
      } catch (e) {
        isSubmitting = false;
        submitError = e.message;
        render();
      }
    };
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h1>Duet — Web Test Client</h1>
      <p>Signed in as ${user.email}</p>
      <div class="row">
        <button id="inRelationship">I'm in a relationship</button>
        <button id="later">Pair later</button>
      </div>
      <div class="row">
        <button id="signout">Sign Out</button>
      </div>
    </div>
  `;
  document.getElementById("inRelationship").onclick = () => { uiStep = "enterEmail"; render(); };
  document.getElementById("later").onclick = () => updateDoc(doc(db, "users", user.uid), { pairingSkipped: true });
  document.getElementById("signout").onclick = () => signOut(auth);
}