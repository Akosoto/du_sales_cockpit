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
  collection, query, where, getDocs, writeBatch,
  orderBy, limit, startAfter, getCountFromServer, runTransaction, increment
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { firebaseConfig } from '../config.js';

export {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
  createUserWithEmailAndPassword, sendPasswordResetEmail,
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, writeBatch,
  orderBy, limit, startAfter, getCountFromServer, runTransaction, increment,
  ref, uploadBytes
};

// firebaseConfig now lives in the gitignored, per-deployment config.js
// (ARCHITECTURE.md Section 2) — see config.example.js for the template.
const primaryApp   = initializeApp(firebaseConfig);
const secondaryApp = initializeApp(firebaseConfig,'Secondary');
export const auth    = getAuth(primaryApp);
export const auth2   = getAuth(secondaryApp);
export const db      = getFirestore(primaryApp);
export const storage = getStorage(primaryApp);

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

// Backend submission pipeline (Phase B, ARCHITECTURE.md §5) — coarse status,
// not the old 5 fixed stages (SUBMISSION_STAGES, removed; hasDuAccount no
// longer skips any step, it's an informational badge only).
export const SUBMISSION_STATUSES = ['pendingVerification','submittedToDu','inProgress','activated','rejected'];
// Required on every submission regardless of product. Per-product extras live on
// products.requiredDocuments (empty/TBD until Ashok defines them — no schema
// change needed when he does).
export const MANDATORY_DOC_TYPES = ['Trade License','Emirates ID (Front)','Emirates ID (Back)'];

// Org-level config defaults (ARCHITECTURE.md §3's orgs/{orgId} doc) —
// hardcoded here for now since there's no org-config UI yet; the shape is
// deliberately the same as what that future UI would read/write from
// Firestore, so migrating later is a data move, not a schema change.
export const ORG_DEFAULTS = {
  typeOfRequestList: ['NEW','FNP','MNP','Migration'],
  rejectionReasons: [
    'Documents missing','Documents suspected fake','Verification failed',
    'Expired document','Wrong/incomplete details','Duplicate order',
    'Customer withdrew','Other'
  ],
  // Per-category optional fields the Submit-to-Backend form offers for a
  // line item (ARCHITECTURE.md §3 categoryFields). Starter/Essential/Ultimate
  // are fiber/internet plans (gaid); Mobile is SIM-based. Keyed by category
  // ID (Session B4 category-identity refactor — see js/orgConfig.js), NOT
  // the display label; this object itself isn't org-editable this session,
  // so it stays a hardcoded JS constant rather than moving into Firestore.
  itemFieldsByCategory: {
    starter: ['gaid'], essential: ['gaid'], ultimate: ['gaid'],
    mobile: ['msisdn','simSerial','passcode','commitmentPlan','handset']
  },
  // Document retention window (ARCHITECTURE.md §6) — the Org tab's cleanup
  // sweep only touches bundles where EVERY sibling submission has been
  // terminal (activated/rejected) for at least this many days.
  docRetentionDays: 90
};

// ════════════════════════════════════════════════════
// SHARED MUTABLE STATE
// Live bindings: other modules `import { CU, CP, TAB }` and always see the
// current value, but only this module may reassign them — hence the setters.
// ════════════════════════════════════════════════════
export let CU  = null;   // Firebase Auth user
export let CP  = null;   // Firestore profile
export let TAB = '';
export let OC  = null;   // Org config (orgs/{orgId} doc — categories today; Session B4)

export function setUser(u, p){ CU = u; CP = p; }
export function setTab(id){ TAB = id; }
export function setOrgConfig(oc){ OC = oc; }
