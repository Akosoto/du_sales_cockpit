import {
  db, CU, CP, MANDATORY_DOC_TYPES, ORG_DEFAULTS,
  doc, collection, runTransaction
} from './state.js';
import { newBatch, batchAdd, batchUpdate } from './db.js';
import { now } from './helpers.js';
import { orgId } from '../config.js';

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
// accTransfer: when items.accTransfer.flag is set, also appends a
// partnerHistory 'gained' event to the company doc in the SAME batch —
// atomic with the submissions themselves.
export async function createSubmissions({ lead, company, items, requiredDocs, accTransfer, teams, users }){
  const backendTeam   = teams.find(t => t.department === 'backend');
  const backendAgents = backendTeam
    ? users.filter(u => u.role === 'agent' && u.teamId === backendTeam.id)
    : [];
  const autoMode = backendTeam?.assignmentMode === 'auto';
  let cursor = backendTeam?.assignmentCursor || 0;

  // Client-side random id, reused purely as the shared bundle key — no doc is
  // ever written at this path, so allocating it costs no network round-trip.
  const bundleId = doc(collection(db,'submissions')).id;
  const requiredDocsPayload = requiredDocs.map(rd => ({ type: rd.type, status: 'attested', expiryDate: rd.expiryDate || null }));
  const accTransferPayload = accTransfer?.flag ? { flag: true, fromPartner: accTransfer.fromPartner || '' } : { flag: false, fromPartner: '' };

  const bat = newBatch();
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
      teamId: lead.teamId||'', tlId: lead.tlId||'',
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

  await bat.commit();
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
export async function appendEvent(submissionId, { type, payload = {} }){
  if(!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  if(type === 'rejected' && !payload.reason) throw new Error('A rejection reason is required.');
  if(type === 'rejected' && !ORG_DEFAULTS.rejectionReasons.includes(payload.reason)){
    throw new Error(`"${payload.reason}" is not a configured rejection reason.`);
  }

  const subRef = doc(db,'submissions',submissionId);
  let finalStatus;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(subRef);
    if(!snap.exists()) throw new Error('Submission not found.');
    const sub = snap.data();

    const events = [...(sub.events||[]), { type, actorId: CU.uid, actorName: CP.name, ts: now(), payload }];
    const update = { events, lastEditedBy: CP.name, lastEditedAt: now() };

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
  });

  return finalStatus;
}
