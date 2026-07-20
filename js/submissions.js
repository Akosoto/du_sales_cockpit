import {
  db, CU, CP, MANDATORY_DOC_TYPES, ORG_DEFAULTS,
  doc, collection, runTransaction, getDoc, getDocs, query, where
} from './state.js';
import { newBatch, batchAdd, batchUpdate } from './db.js';
import { now } from './helpers.js';
import { orgId } from '../config.js';
import * as storage from './storage/index.js';

// Backend-attachable doc types (step 5b) — distinct from the
// agent-required checklist (MANDATORY_DOC_TYPES + product-specific), these
// are ADDITIONAL evidence backend adds after the fact.
export const BACKEND_ATTACHMENT_TYPES = ['Affidavit', 'Email Extension', 'Other'];

// Every recognized event type (ARCHITECTURE.md §5) — 'resubmit' isn't in
// that list's prose but IS one of the explicit status-transition types per
// step 3's own instructions, so it's included here. 'proceededWithoutVerification'
// is deliberately excluded — it's auto-appended by appendEvent() itself, never
// caller-supplied.
const EVENT_TYPES = [
  'docsVerified','verificationCall','verificationEmail','submittedToDu',
  'activityNo','workOrderNo','appointment','biometric','sprObtained',
  'correction','note','activated','rejected','resubmit'
];

// Display labels/colors — shared by every submission-status-rendering UI
// (the agent's Submit modal + read-only timeline in js/leads.js, the
// backend Queue/action panel in js/queue.js) so they can't drift apart.
export const SUBMISSION_STATUS_LABELS = {
  pendingVerification: 'Pending Verification', submittedToDu: 'Submitted to du',
  inProgress: 'In Progress', activated: 'Activated', rejected: 'Rejected'
};
export const SUBMISSION_STATUS_COLORS = {
  pendingVerification: 'var(--amber)', submittedToDu: 'var(--blue)',
  inProgress: 'var(--purple2)', activated: 'var(--green)', rejected: 'var(--red)'
};
export const EVENT_LABELS = {
  created:'Created', docsVerified:'Documents Verified', verificationCall:'Verified by Call',
  verificationEmail:'Verified by Email', submittedToDu:'Submitted to du',
  proceededWithoutVerification:'Proceeded Without Verification',
  activityNo:'Activity Number', workOrderNo:'Work Order Number', appointment:'Appointment Scheduled',
  biometric:'Biometric', sprObtained:'SPR Obtained', correction:'Correction', note:'Note',
  activated:'Activated', rejected:'Rejected', resubmit:'Resubmitted'
};

// ════════════════════════════════════════════════════
// SUBMISSIONS — agent → backend handoff (ARCHITECTURE.md Section 5)
// v2: one submission DOC per product line (not an items[] array) — see
// createSubmissions() below. Replaces the old 5-fixed-stage per-item design
// (SUBMISSION_STAGES, removed from state.js) with a coarse status + an
// append-only events[] timeline, per submission.
//
// Storage/file upload is NOT this session — the StorageAdapter (b64 driver +
// pdf.js) arrives next session. requiredDocs here captures the agent's doc
// checklist + expiry dates only (self-attested, status:'attested'), not
// actual file bytes.
// ════════════════════════════════════════════════════

// MANDATORY_DOC_TYPES + every selected item's product-specific requirements
// (products.requiredDocuments, empty/TBD until Ashok defines them), deduped
// across the whole bundle being submitted — the agent attests company-level
// docs (Trade License, Emirates ID) ONCE per form, not once per product
// line, even though each resulting submission doc gets its own copy of the
// same requiredDocs snapshot (ARCHITECTURE.md §3 — standalone per doc, since
// a rejected line's re-verification is independent of its siblings).
export function computeRequiredDocs(items, productsById){
  const set = new Set(MANDATORY_DOC_TYPES);
  items.forEach(it => {
    const p = productsById[it.productId];
    (p?.requiredDocuments||[]).forEach(rd => set.add(rd.docType));
  });
  return [...set];
}

// Flags any of the company's on-file documents (docExpiries, entered via the
// Org tab's Edit Company modal) expiring within 15 days — the agent-desk
// warning at submit time (ARCHITECTURE.md §5). Establishment card is flagged
// specially since an expired one risks SIM suspension, not just a compliance
// nag.
export function docExpiryWarnings(company){
  if(!company?.docExpiries) return [];
  const soon = new Date(); soon.setDate(soon.getDate()+15);
  const labels = { tradeLicense:'Trade License', establishmentCard:'Establishment Card', eid:'Emirates ID' };
  return Object.entries(company.docExpiries)
    .filter(([,date]) => date && new Date(date) <= soon)
    .map(([key,date]) => ({ key, label: labels[key]||key, date, isEstablishmentCard: key==='establishmentCard' }));
}

// v2 auto-assignment (ARCHITECTURE.md §4): available backend agents whose
// specialties include this category, or who are generalists (no specialties
// set). If NONE match — not even a generalist — fall back to ANY available
// backend agent; a specialty mismatch should never leave a submission
// unassigned when staff exist to work it. Zero available agents at all (or
// an empty/no backend team) → unassigned (shared queue). Rotation cursor
// advances once per call — per SUBMISSION now, not per bundle
// (ARCHITECTURE.md §5), since each product line is assigned independently.
// Collapses a bundle's sibling submission statuses into the small badge
// vocabulary the pipeline list renders (ARCHITECTURE.md §5/this session's
// step 0d) — 'none' is the caller's job (a lead with no submissions at all
// never calls this). Priority: any rejected line needs attention regardless
// of how far along its siblings are; only when EVERY line has activated does
// the whole bundle read as activated; otherwise it's the furthest-along
// in-flight state, collapsed down to the two badge buckets 'submitted'
// (pendingVerification/submittedToDu — nothing's actively being worked yet)
// and 'inProgress' (inProgress, or a partial activation with no rejects).
const STATUS_RANK = { pendingVerification:0, submittedToDu:1, inProgress:2, activated:3 };
export function collapseSubmissionSummary(lines){
  if(!lines.length) return 'none';
  if(lines.some(l => l.status === 'rejected')) return 'rejected';
  if(lines.every(l => l.status === 'activated')) return 'activated';
  const furthest = lines.reduce((max,l) => Math.max(max, STATUS_RANK[l.status] ?? 0), 0);
  return furthest >= STATUS_RANK.inProgress ? 'inProgress' : 'submitted';
}

export function pickBackendAgent(category, backendAgents, cursor){
  const available = backendAgents.filter(u => u.available !== false);
  const specialtyMatches = available.filter(u => !(u.specialties||[]).length || u.specialties.includes(category));
  const candidates = specialtyMatches.length ? specialtyMatches : available;
  if(!candidates.length) return { agentId: null, nextCursor: cursor };
  const idx = cursor % candidates.length;
  return { agentId: candidates[idx].id, nextCursor: cursor + 1 };
}

// Creates one submission DOC PER PRODUCT LINE (ARCHITECTURE.md §3/§5 — this
// is the schema amendment that replaces v2.0's original items[] array). All
// docs from one Submit-to-Backend form share a client-generated bundleId so
// the agent's view can group them into one visual package, but each has its
// own status, events[] timeline, and assignedBackendAgent — the real master
// tracker is one row per product order, and partial bundle activation (one
// line activated, another still pending) is the normal case.
//
// v1 simplification carried over unchanged: backend assignment only
// considers the FIRST team with department:'backend' found in `teams`
// (multi-backend-team routing isn't specified yet). No backend team →
// every submission is left unassigned (shared queue fallback).
//
// hasDuAccount skip logic is GONE — every submission starts at
// 'pendingVerification' regardless; hasDuAccount is purely an informational
// badge now (ARCHITECTURE.md §5).
//
// Client-side random id, reused purely as the shared bundle key — no doc is
// ever written at this path, so allocating it costs no network round-trip.
// Exported so callers (the Submit-to-Backend modal) that need the bundleId
// BEFORE submissions are created — to tag document pages uploaded via
// js/storage — can generate it up front and pass it into createSubmissions().
export function generateBundleId(){
  return doc(collection(db,'submissions')).id;
}

// accTransfer: when items.accTransfer.flag is set, also appends a
// partnerHistory 'gained' event to the company doc in the SAME batch —
// atomic with the submissions themselves.
//
// bundleId/externalBat: optional. When the Submit-to-Backend modal's total
// upload (submissions + document pages) is small enough to safely combine
// into ONE atomic writeBatch, it generates the bundleId itself, builds a
// shared batch, passes both in here (and to js/storage's put() calls), and
// commits ONCE itself — this function then adds its writes to that batch
// WITHOUT committing. Omit both for the normal standalone case (this
// function generates its own bundleId and commits its own batch, as before).
export async function createSubmissions({ lead, company, items, requiredDocs, accTransfer, teams, users, bundleId: providedBundleId, externalBat }){
  const backendTeam   = teams.find(t => t.department === 'backend');
  const backendAgents = backendTeam
    ? users.filter(u => u.role === 'agent' && u.teamId === backendTeam.id)
    : [];
  const autoMode = backendTeam?.assignmentMode === 'auto';
  let cursor = backendTeam?.assignmentCursor || 0;

  const bundleId = providedBundleId || generateBundleId();
  const requiredDocsPayload = requiredDocs.map(rd => ({ type: rd.type, status: rd.status || 'attested', expiryDate: rd.expiryDate || null, storageRef: rd.storageRef || null }));
  const accTransferPayload = accTransfer?.flag ? { flag: true, fromPartner: accTransfer.fromPartner || '' } : { flag: false, fromPartner: '' };

  // Resolve teamId/tlId from the ASSIGNED AGENT's own profile at submit time
  // (step 0e root-cause fix) — the lead's own teamId/tlId can be stale or
  // never stamped at all (e.g. an agent self-creating their own lead used to
  // skip team resolution entirely — see js/leads.js showAddLeadModal), and
  // this must never silently freeze '' onto a submission the way the old
  // `lead.teamId||''` copy did: that's exactly what made a whole bundle
  // permanently invisible to the TL even after the LEAD itself was later
  // repaired, since the fix never touched the already-created submissions.
  // Falling back to the lead's own fields covers the case where the
  // assignee's profile itself is somehow missing (shouldn't happen, but
  // cheap insurance); refusing outright when BOTH are empty surfaces the gap
  // at submit time instead of writing another silent blank.
  const assignedAgent = users.find(u => u.id === lead.assignedTo);
  const teamId = assignedAgent?.teamId || lead.teamId || '';
  const tlId   = assignedAgent?.tlId   || lead.tlId   || '';
  if(!teamId){
    throw new Error('This lead has no team data — run Repair Lead Data or contact your manager.');
  }

  const bat = externalBat || newBatch();
  const subIds = [];
  items.forEach(it => {
    let assignedBackendAgent = null;
    if(autoMode){
      const picked = pickBackendAgent(it.category, backendAgents, cursor);
      assignedBackendAgent = picked.agentId;
      cursor = picked.nextCursor;
    }
    const subRef = batchAdd(bat, 'submissions', {
      bundleId, leadId: lead.id, companyId: lead.companyId,
      agentId: CU.uid, agentName: CP.name,
      teamId, tlId,
      productId: it.productId, productName: it.productName, category: it.category,
      qty: Number(it.qty)||1, mrc: Number(it.mrc)||0,
      typeOfRequest: it.typeOfRequest || 'NEW', contractTerm: it.contractTerm || null,
      categoryFields: it.categoryFields || {}, sprFlag: !!it.sprFlag, sprNote: it.sprNote || '',
      accTransfer: accTransferPayload,
      status: 'pendingVerification',
      events: [{ type:'created', actorId:CU.uid, actorName:CP.name, ts:now(), payload:{} }],
      verification: null,
      requiredDocs: requiredDocsPayload,
      assignedBackendAgent
    });
    subIds.push(subRef.id);
  });

  // Pipeline submission-status badge (step 0d) — denormalized onto the LEAD
  // so the pipeline list never needs a per-lead submissions query just to
  // show a badge. A fresh bundle is always all-pendingVerification, which
  // collapseSubmissionSummary always resolves to 'submitted'.
  batchUpdate(bat, 'leads', lead.id, { submissionSummary: 'submitted' });

  if(accTransferPayload.flag && accTransferPayload.fromPartner && company){
    batchUpdate(bat, 'companies', company.id, {
      partnerHistory: [...(company.partnerHistory||[]), {
        type: 'gained', partner: accTransferPayload.fromPartner,
        date: now().slice(0,10), note: `Transferred via submission bundle ${bundleId}`
      }]
    });
  }

  if(backendTeam && cursor !== (backendTeam.assignmentCursor||0)){
    // skipAudit: bound by the Firestore rule's
    // affectedKeys().hasOnly(['assignmentCursor']) restriction.
    batchUpdate(bat, 'teams', backendTeam.id, { assignmentCursor: cursor }, {skipAudit:true});
  }

  if(!externalBat) await bat.commit();
  return { bundleId, submissionIds: subIds };
}

// Event engine (ARCHITECTURE.md §5) — every timeline entry on a submission
// goes through here, never a direct dbUpdate. Status transitions ride the
// SAME call as the event that causes them:
//   submittedToDu → status:'submittedToDu' (+ auto-appends
//     'proceededWithoutVerification' if no verification event/field exists
//     yet — never silently loses that signal)
//   activated     → status:'activated'
//   rejected      → status:'rejected' (payload.reason is REQUIRED, from
//     ORG_DEFAULTS.rejectionReasons)
//   resubmit      → status:'pendingVerification' (agent fixed a rejected
//     submission; the resubmit event itself is the record of that)
//   anything else → no explicit status change, EXCEPT: if the submission is
//     currently 'submittedToDu', any other logged event bumps it to
//     'inProgress' — the first real backend touch after submission implies
//     work has started, and nothing else in the schema sets that status.
// verification {done, method, ts} is a separate structured summary field
// (not just a timeline entry) — set whenever a verification-type event
// fires, so the UI can show "verified" at a glance without scanning events[].
//
// Queryable top-level timestamps (submittedToDuAt/activatedAt/rejectedAt) are
// stamped ALONGSIDE the corresponding status, on the FIRST transition only —
// reports and the future contract-expiry pipeline (activatedAt + contractTerm)
// need to query/sort on these directly; scanning events[] for every
// submission to find "when did this activate" doesn't scale.
//
// Runs inside a Firestore transaction (read + append + status change +
// auditLog write, all atomic) instead of the previous getDoc-then-dbUpdate
// sequence — two concurrent appendEvent calls on the same submission (e.g.
// backend logging an activityNo while the agent's own resubmit races in)
// could otherwise read the same stale events[] and one write would silently
// clobber the other's event. A transaction detects that conflict and
// automatically retries the whole read+write with fresh data.
// extraFields: internal-only — merged into the same transactional update as
// the event/status change, for the few cases where a field OTHER than
// events/status needs to change atomically with a logged event (claim/
// reassign's assignedBackendAgent below). Not a general escape hatch for
// arbitrary UI callers.
export async function appendEvent(submissionId, { type, payload = {}, extraFields = {} }){
  if(!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  if(type === 'rejected' && !payload.reason) throw new Error('A rejection reason is required.');
  if(type === 'rejected' && !ORG_DEFAULTS.rejectionReasons.includes(payload.reason)){
    throw new Error(`"${payload.reason}" is not a configured rejection reason.`);
  }

  const subRef = doc(db,'submissions',submissionId);
  let finalStatus;

  // Sibling bundle enumeration — a plain query BEFORE the transaction, since
  // Firestore transactions can only re-read specific document refs
  // (transaction.get), never run a query. The IDs found here are re-read
  // fresh INSIDE the transaction below, so the actual collapse is still
  // computed from consistent, as-of-commit data (and retried automatically
  // if a sibling changes between this enumeration and the commit).
  //
  // LIST-query gotcha (found live in this session's regression, same class
  // of bug as f0c34bd): a bare where('bundleId','==',bundleId) query is
  // only provable for manager/backend, whose read-rule clauses don't touch
  // resource.data at all — for the SUBMITTING AGENT calling this (e.g. Fix &
  // Resubmit's resubmit event), Firestore can't prove every possible result
  // satisfies resource.data.agentId==request.auth.uid without that field IN
  // the query, and denies the whole thing. Mirrored here with the known
  // agentId from the single-doc read above (provable for any role, unlike a
  // list query) — every sibling in a bundle always shares the same agentId
  // (one bundle = one agent's Submit-to-Backend session), so this is both
  // correct for manager/backend's broader case AND provable for the agent's.
  const preSnap = await getDoc(subRef);
  if(!preSnap.exists()) throw new Error('Submission not found.');
  const { bundleId, leadId, agentId: bundleAgentId } = preSnap.data();
  const siblingsSnap = await getDocs(query(collection(db,'submissions'), where('bundleId','==',bundleId), where('agentId','==',bundleAgentId)));
  const otherSiblingRefs = siblingsSnap.docs.map(d => d.ref).filter(r => r.id !== submissionId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(subRef);
    if(!snap.exists()) throw new Error('Submission not found.');
    const sub = snap.data();
    // Reads-before-writes: every transaction.get() in this transaction must
    // happen before any transaction.set()/update() call below.
    const otherSiblingSnaps = await Promise.all(otherSiblingRefs.map(r => transaction.get(r)));

    const events = [...(sub.events||[]), { type, actorId: CU.uid, actorName: CP.name, ts: now(), payload }];
    const update = { events, lastEditedBy: CP.name, lastEditedAt: now(), ...extraFields };

    if(['docsVerified','verificationCall','verificationEmail'].includes(type)){
      update.verification = {
        done: true,
        method: type==='verificationCall' ? 'call' : type==='verificationEmail' ? 'email' : null,
        ts: now()
      };
    }

    if(type === 'submittedToDu'){
      const alreadyVerified = sub.verification?.done || update.verification?.done;
      if(!alreadyVerified){
        events.push({ type:'proceededWithoutVerification', actorId:CU.uid, actorName:CP.name, ts:now(), payload:{} });
        update.verification = { done:false, method:null, ts:null };
      }
      update.status = 'submittedToDu';
      if(!sub.submittedToDuAt) update.submittedToDuAt = now();
    } else if(type === 'activated'){
      update.status = 'activated';
      if(!sub.activatedAt) update.activatedAt = now();
    } else if(type === 'rejected'){
      update.status = 'rejected';
      if(!sub.rejectedAt) update.rejectedAt = now();
    } else if(type === 'resubmit'){
      update.status = 'pendingVerification';
    } else if(sub.status === 'submittedToDu'){
      update.status = 'inProgress';
    }

    transaction.update(subRef, update);
    // auditLog write kept intact (per step 0a) even though this bypasses
    // db.js's dbUpdate — same shape as db.js's own auditLogEntry().
    transaction.set(doc(collection(db,'auditLog')), {
      who: CU.uid, what: 'submissions', action: 'update', docRef: submissionId, ts: now(), orgId
    });

    finalStatus = update.status || sub.status;

    // Pipeline submission-status badge (step 0d) — recomputed across every
    // sibling in the bundle, using THIS submission's just-computed new
    // status rather than its stale pre-transaction one, and stamped onto the
    // LEAD in the same transaction as the status change itself.
    if(leadId){
      const siblingStatuses = [
        { status: finalStatus },
        ...otherSiblingSnaps.filter(s => s.exists()).map(s => ({ status: s.data().status }))
      ];
      transaction.update(doc(db,'leads',leadId), { submissionSummary: collapseSubmissionSummary(siblingStatuses) });
    }
  });

  return finalStatus;
}

// Claim/reassignment (ARCHITECTURE.md §4, step 2) — both just an
// assignedBackendAgent change logged as a 'note' event, atomic with it via
// appendEvent's extraFields. Distinguishing "any backend user may claim an
// UNASSIGNED submission" from "backend TL/manager may reassign ANY
// submission" is a CLIENT-SIDE workflow/UI policy, not a server-side
// restriction — the submissions rule already gives the whole backend
// department unrestricted update rights on every submission (ARCHITECTURE.md
// §4: "whole dept sees all submissions"), and isActiveBackend() doesn't
// distinguish a coordinator/TL from a regular backend agent at the rule
// level at all. See js/queue.js for which button each role actually sees.
export async function claimSubmission(submissionId){
  return appendEvent(submissionId, {
    type: 'note',
    payload: { text: `Claimed by ${CP.name}` },
    extraFields: { assignedBackendAgent: CU.uid }
  });
}

export async function reassignSubmission(submissionId, newAgentId, oldAgentName, newAgentName){
  return appendEvent(submissionId, {
    type: 'note',
    payload: { text: `Reassigned from ${oldAgentName||'Unassigned'} to ${newAgentName}` },
    extraFields: { assignedBackendAgent: newAgentId }
  });
}

// Backend attachment (step 5b, ARCHITECTURE.md §5/§6) — adds an ADDITIONAL
// document (BACKEND_ATTACHMENT_TYPES) to EVERY sibling submission in a
// bundle, same as how the agent's originally-submitted docs are duplicated
// across all lines at creation. The page's agentId/teamId are the
// ORIGINAL submitting agent's own values (read from the bundle's own
// submissions, not the backend uploader) — the submissionDocs read rule's
// agentId/teamId-scoped clauses (agent-self, their TL) must keep working
// for a doc backend attaches on someone else's behalf; uploadedBy (already
// a separate field on the page) records who actually attached it. Requires
// the submissionDocs create rule to also allow isActiveBackend() (step
// 5c) — a backend user's own uid otherwise never matches the page's
// agentId the way the existing agentId==self clause expects.
export async function attachBackendDocument({ bundleId, docType, pages }){
  const siblingsSnap = await getDocs(query(collection(db,'submissions'), where('bundleId','==',bundleId)));
  const lines = siblingsSnap.docs.map(d => ({id:d.id, ...d.data()}));
  if(!lines.length) throw new Error('No submissions found for this bundle.');
  const { agentId, teamId } = lines[0];

  const refs = await storage.put({ bundleId, docType, pages, version: 1, agentId, teamId });
  const newEntry = { type: docType, status: 'uploaded', expiryDate: null, storageRef: { bundleId, docType, version: 1, pageCount: refs.length } };

  for(const line of lines){
    const requiredDocs = [...(line.requiredDocs||[]), newEntry];
    await appendEvent(line.id, { type: 'note', payload: { text: `Attached ${docType}` }, extraFields: { requiredDocs } });
  }
}
