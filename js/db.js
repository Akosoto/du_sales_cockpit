import {
  db, CU, CP,
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, writeBatch
} from './state.js';
import { orgId } from '../config.js';
import { now } from './helpers.js';

// ════════════════════════════════════════════════════
// DB.JS — the single mutation gateway (ARCHITECTURE.md Phase A step 2)
// Every Firestore create/update/delete in the app goes through here so
// orgId stamping, audit fields, and (Phase C) rollup hooks can never be
// bypassed by a call site that forgets them. Re-exports getDoc/collection
// for modules that only need reads — those don't need gateway wrapping.
// ════════════════════════════════════════════════════
export { getDoc, collection };

const HISTORY_CAP = 100;

// Keeps the most recent HISTORY_CAP entries — history[] only ever grows by
// appending the newest entry at the end (see every call site), so the tail
// is always the recent end.
function capHistory(historyArr){
  return historyArr.length > HISTORY_CAP ? historyArr.slice(historyArr.length - HISTORY_CAP) : historyArr;
}

// Structured closedAt timestamp on stage->Closed (audit item 10) — replaces
// the fragile history[]-text-scan (closeMonthKey() scanning for '→ Closed')
// the dashboard currently relies on. Only stamped once per transition; a
// caller that already set closedAt explicitly (e.g. a data-import script
// backfilling a historical date) is never overridden.
function withStageTimestamp(payload){
  if(payload.stage === 'Closed' && !payload.closedAt) payload.closedAt = now();
  return payload;
}

function withHistoryCap(payload){
  if(payload.history) payload.history = capHistory(payload.history);
  return payload;
}

// Every existing create call site sets createdBy/createdAt and
// lastEditedBy/lastEditedAt identically (a fresh doc's "last edit" is its
// own creation) — centralized here instead of repeated at every call site.
// `...data` is spread AFTER these defaults so a caller can still override
// (e.g. a future historical-data importer backfilling a real createdAt).
function auditCreate(){
  return { createdBy: CU.uid, createdAt: now(), lastEditedBy: CP.name, lastEditedAt: now() };
}
function auditUpdate(){
  return { lastEditedBy: CP.name, lastEditedAt: now() };
}

// opts.skipAudit: for the handful of call sites bound by a Firestore rule's
// affectedKeys().hasOnly([...]) restriction (teams.assignmentCursor,
// scripts.pendingApproval) — adding audit fields there would widen the
// write beyond what the rule allows and get rejected.
export async function dbAdd(collectionName, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  return addDoc(collection(db, collectionName), payload);
}

export async function dbSet(collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  return setDoc(doc(db, collectionName, id), payload);
}

export async function dbUpdate(collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { ...(opts.skipAudit ? {} : auditUpdate()), ...data }
  ));
  return updateDoc(doc(db, collectionName, id), payload);
}

export async function dbDelete(collectionName, id){
  return deleteDoc(doc(db, collectionName, id));
}

// ── Batch variants — same stamping rules, for use inside a writeBatch ──
export function newBatch(){ return writeBatch(db); }

export function batchAdd(bat, collectionName, data, opts = {}){
  const ref = doc(collection(db, collectionName));
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  bat.set(ref, payload);
  return ref;
}

export function batchSet(bat, collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  bat.set(doc(db, collectionName, id), payload);
}

export function batchUpdate(bat, collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { ...(opts.skipAudit ? {} : auditUpdate()), ...data }
  ));
  bat.update(doc(db, collectionName, id), payload);
}

export function batchDelete(bat, collectionName, id){
  bat.delete(doc(db, collectionName, id));
}
