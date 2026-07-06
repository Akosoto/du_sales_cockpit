// ════════════════════════════════════════════════════
// FIREBASE
// ════════════════════════════════════════════════════
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
  createUserWithEmailAndPassword, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from '../config.js';

export {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
  createUserWithEmailAndPassword, sendPasswordResetEmail,
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, writeBatch
};

// firebaseConfig now lives in the gitignored, per-deployment config.js
// (ARCHITECTURE.md Section 2) — see config.example.js for the template.
const primaryApp = initializeApp(firebaseConfig);
const secondaryApp = initializeApp(firebaseConfig,'Secondary');
export const auth  = getAuth(primaryApp);
export const auth2 = getAuth(secondaryApp);
export const db    = getFirestore(primaryApp);

// ════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════
export const SEED_EMAILS = {
  'manager@shauntech.app':  { role:'manager',   name:'Sales Manager'  },
  'teamlead1@shauntech.app':{ role:'team_lead', name:'Team Lead 1'    },
  'agent1@shauntech.app':   { role:'agent',     name:'Agent 1'        },
  'agent2@shauntech.app':   { role:'agent',     name:'Agent 2'        },
};
export const STAGES = ['New','Contacted','Interested','Proposal Sent','Closed','Lost'];
export const SP = { 'New':'sp-new','Contacted':'sp-contacted','Interested':'sp-interested','Proposal Sent':'sp-proposal','Closed':'sp-won','Lost':'sp-lost' };

// ════════════════════════════════════════════════════
// SHARED MUTABLE STATE
// Live bindings: other modules `import { CU, CP, TAB }` and always see the
// current value, but only this module may reassign them — hence the setters.
// ════════════════════════════════════════════════════
export let CU  = null;   // Firebase Auth user
export let CP  = null;   // Firestore profile
export let TAB = '';

export function setUser(u, p){ CU = u; CP = p; }
export function setTab(id){ TAB = id; }
