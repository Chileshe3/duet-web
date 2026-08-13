import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);