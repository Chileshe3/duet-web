import { db } from "./firebase.js";
import {
  doc, collection, addDoc, onSnapshot, query, orderBy, limitToLast,
  updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const MESSAGES_LIMIT = 50;
const TYPING_TIMEOUT_MS = 3000;
const TYPING_STALE_MS = 6000;

export function observeMessages(coupleId, onChange) {
  const q = query(
    collection(db, "couples", coupleId, "messages"),
    orderBy("timestamp", "asc"),
    limitToLast(MESSAGES_LIMIT)
  );
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        text: data.text,
        senderUid: data.senderUid,
        timestampMillis: data.timestamp?.toMillis?.() ?? null,
        type: data.type ?? "TEXT",
        mediaUrl: data.mediaUrl ?? null,
        mediaFileName: data.mediaFileName ?? null,
        mediaSizeBytes: data.mediaSizeBytes ?? null,
        mediaDurationMillis: data.mediaDurationMillis ?? null
      };
    }));
  });
}

export async function sendMessage(coupleId, senderUid, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  await addDoc(collection(db, "couples", coupleId, "messages"), {
    text: trimmed,
    senderUid,
    timestamp: serverTimestamp(),
    type: "TEXT"
  });
}

export async function sendMediaMessage(coupleId, senderUid, { type, url, fileName, sizeBytes, durationMillis = null }, caption = "") {
  await addDoc(collection(db, "couples", coupleId, "messages"), {
    text: caption.trim(),
    senderUid,
    timestamp: serverTimestamp(),
    type,
    mediaUrl: url,
    mediaFileName: fileName,
    mediaSizeBytes: sizeBytes,
    mediaDurationMillis: durationMillis
  });
}

export function observeTyping(coupleId, partnerUid, onChange) {
  return onSnapshot(doc(db, "couples", coupleId), (snap) => {
    const partnerTyping = snap.data()?.typing?.[partnerUid];
    if (!partnerTyping?.isTyping) return onChange(false);
    const at = partnerTyping.at?.toMillis?.() ?? 0;
    const isStale = Date.now() - at > TYPING_STALE_MS;
    onChange(!isStale);
  });
}

let typingClearTimer = null;

export async function setTyping(coupleId, uid, isTyping) {
  await updateDoc(doc(db, "couples", coupleId), {
    [`typing.${uid}`]: { isTyping, at: serverTimestamp() }
  });
}

export function scheduleTypingClear(coupleId, uid) {
  clearTimeout(typingClearTimer);
  typingClearTimer = setTimeout(() => setTyping(coupleId, uid, false), TYPING_TIMEOUT_MS);
}

export function observePresence(uid, onChange) {
  return onSnapshot(doc(db, "users", uid), (snap) => onChange(!!snap.data()?.isOnline));
}

export async function setPresence(uid, isOnline) {
  await updateDoc(doc(db, "users", uid), { isOnline, lastActiveAt: serverTimestamp() });
}