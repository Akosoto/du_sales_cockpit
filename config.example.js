// Template for config.js (ARCHITECTURE.md Section 2) — copy this file to
// config.js and fill in your deployment's real values. config.js itself is
// gitignored; never commit real Firebase keys or org-specific values here.
export const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export const orgId = "your-org-id";

export const branding = {
  appName: "Your Company · Sales Cockpit",
  logoUrl: null,
  primaryColor: "#7c3aed"
};

// "firestore-b64" (free tier, default) | "firebase-storage" (Blaze deployments)
// See ARCHITECTURE.md Section 4 for the two document-storage drivers.
export const storageDriver = "firestore-b64";

export const featureFlags = {};
