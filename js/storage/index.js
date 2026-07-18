import { storageDriver } from '../../config.js';
import * as firestoreB64 from './firestore-b64.js';

// ════════════════════════════════════════════════════
// STORAGE ADAPTER (ARCHITECTURE.md §6) — the ONLY module feature code
// (js/leads.js's Submit-to-Backend flow, the Submission Timeline viewer, the
// retention sweep) is allowed to import for document storage. Never import a
// driver module directly from feature code — swapping drivers (e.g. a future
// firebase-storage driver for Blaze clients) must only ever mean adding an
// entry here, not touching every call site.
//
// Interface:
//   put({bundleId, docType, pages}) → storageRefs
//     `pages` is the array of {pageIndex, mime, blob, bytes} that
//     js/documents.js's capture pipeline produces. Returns one ref per page
//     — [{bundleId, docType, pageIndex}, ...] — opaque beyond that shape;
//     callers store pageCount (storageRefs.length) alongside bundleId/docType
//     on requiredDocs[].storageRef, not the individual per-page refs (pages
//     are re-derived by bundleId+docType+pageIndex when viewing, never
//     enumerated and stored inline).
//   get(ref) → { mime, dataURL } for ONE page (ref = {bundleId, docType,
//     pageIndex}) — viewing a multi-page doc means calling this once per
//     pageIndex from 0 to pageCount-1, never a single call for "all pages".
//   deleteByBundle(bundleId) → deletes every stored page for every docType
//     in that bundle (the retention sweep's primary tool).
// ════════════════════════════════════════════════════

const DRIVERS = {
  'firestore-b64': firestoreB64
  // 'firebase-storage': Blaze-client driver — ARCHITECTURE.md §6, not built
  // yet (Phase G). Adding it later is exactly one more entry here.
};

function currentDriver(){
  const driver = DRIVERS[storageDriver];
  if(!driver) throw new Error(`Unknown config.storageDriver: "${storageDriver}"`);
  return driver;
}

// NOTE: extends the literal {bundleId, docType, pages} shape with agentId/
// teamId — the firestore-b64 driver's schema denormalizes these from the
// submission onto every page doc (so the read rule and query mirroring work
// the same way as submissions), and the adapter has no other way to know
// them without reaching into feature-layer state itself.
export async function put({bundleId, docType, pages, agentId, teamId}){
  return currentDriver().put({bundleId, docType, pages, agentId, teamId});
}

export async function get(ref){
  return currentDriver().get(ref);
}

export async function deleteByBundle(bundleId){
  return currentDriver().deleteByBundle(bundleId);
}
