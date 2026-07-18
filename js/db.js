import {
  db, CU, CP,
  doc, getDoc, collection, writeBatch
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
// scripts.pendingApproval), the orgId migration, or auth.js's self-
// registration bootstrap (CU/CP are still null there) — adding audit fields
// or an auditLog entry referencing CU there would throw or widen the write
// beyond what the rule allows. skipAudit skips BOTH.
//
// auditLog (ARCHITECTURE.md §3): one append-only doc per mutation, written
// in the SAME batch as the mutation itself so it can never go missing on a
// partial failure. Manager-only read (see rules/firestore.rules). No UI yet
// — this is just the write path.
function auditLogEntry(collectionName, docId, action){
  return { who: CU.uid, what: collectionName, action, docRef: docId, ts: now(), orgId };
}

export async function dbAdd(collectionName, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  const ref = doc(collection(db, collectionName));
  const bat = writeBatch(db);
  bat.set(ref, payload);
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, ref.id, 'create'));
  await bat.commit();
  return ref;
}

export async function dbSet(collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  const ref = doc(db, collectionName, id);
  const bat = writeBatch(db);
  bat.set(ref, payload);
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, id, 'create'));
  await bat.commit();
  return ref;
}

export async function dbUpdate(collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { ...(opts.skipAudit ? {} : auditUpdate()), ...data }
  ));
  const bat = writeBatch(db);
  bat.update(doc(db, collectionName, id), payload);
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, id, 'update'));
  return bat.commit();
}

export async function dbDelete(collectionName, id, opts = {}){
  const bat = writeBatch(db);
  bat.delete(doc(db, collectionName, id));
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, id, 'delete'));
  return bat.commit();
}

// ── Batch variants — same stamping rules, for use inside a writeBatch ──
export function newBatch(){ return writeBatch(db); }

export function batchAdd(bat, collectionName, data, opts = {}){
  const ref = doc(collection(db, collectionName));
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  bat.set(ref, payload);
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, ref.id, 'create'));
  return ref;
}

export function batchSet(bat, collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { orgId, ...(opts.skipAudit ? {} : auditCreate()), ...data }
  ));
  bat.set(doc(db, collectionName, id), payload);
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, id, 'create'));
}

export function batchUpdate(bat, collectionName, id, data, opts = {}){
  const payload = withHistoryCap(withStageTimestamp(
    { ...(opts.skipAudit ? {} : auditUpdate()), ...data }
  ));
  bat.update(doc(db, collectionName, id), payload);
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, id, 'update'));
}

export function batchDelete(bat, collectionName, id, opts = {}){
  bat.delete(doc(db, collectionName, id));
  if(!opts.skipAudit) bat.set(doc(collection(db,'auditLog')), auditLogEntry(collectionName, id, 'delete'));
}

// One summary entry for an entire bulk run (backfills, cascades, imports).
// Every batch* call in a bulk loop must pass {skipAudit:true} — N ops would
// otherwise double to 2N writes per batch and blow Firestore's 500-write cap
// well before N reaches the 500-op chunk sizes those loops used to assume.
// This single record is the tradeoff: no per-doc audit trail for a bulk run,
// but a record that one happened, by whom, affecting how many docs, exists.
export async function logBulkAudit(description, count){
  return dbAdd('auditLog', { who: CU.uid, what: 'bulk', action: 'bulk', count, description, ts: now() }, { skipAudit: true });
}
