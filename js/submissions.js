import {
  db, CU, CP, storage, MANDATORY_DOC_TYPES,
  doc, getDoc, collection, writeBatch,
  ref, uploadBytes
} from './state.js';
import { now } from './helpers.js';

// ════════════════════════════════════════════════════
// SUBMISSIONS — agent → backend handoff (Phase 7+)
// See PHASE5_SPEC_AND_HANDOFF.md section 1 for the full schema/design.
// ════════════════════════════════════════════════════

// MANDATORY_DOC_TYPES + every selected item's product-specific requirements
// (products.requiredDocuments, empty/TBD until Ashok defines them), deduped.
export function computeRequiredDocs(items, productsById){
  const set = new Set(MANDATORY_DOC_TYPES);
  items.forEach(it => {
    const p = productsById[it.productId];
    (p?.requiredDocuments||[]).forEach(rd => set.add(rd.docType));
  });
  return [...set];
}

// v1 auto-assignment: available backend agents (in the given team) whose
// specialties include this category, or who are generalists (no specialties
// set — handles anything). Zero matches → unassigned (shared queue). One
// match → assign directly. Multiple matches → simple rotation via a cursor
// persisted on the team doc (not a load-balancer — see spec section 1).
export function pickBackendAgent(category, backendAgents, cursor){
  const candidates = backendAgents.filter(u =>
    u.available !== false && (!(u.specialties||[]).length || u.specialties.includes(category))
  );
  if(!candidates.length) return { agentId: null, nextCursor: cursor };
  const idx = cursor % candidates.length;
  return { agentId: candidates[idx].id, nextCursor: cursor + 1 };
}

// Orchestrates one submission: uploads files, resolves each item's starting
// stage (skips Account Creation when the company already has a du account)
// and backend assignment, then writes everything in one batch.
//
// NOTE — v1 simplification: assignment only considers the FIRST team with
// department:'backend' found in `teams` (multi-backend-team routing isn't
// specified yet; not a week-one build, per spec's own framing for the
// assignment engine). If no backend team exists, every item is left
// unassigned — harmless, matches the "shared queue" fallback behavior.
export async function createSubmission({ lead, company, items, files, requiredDocs, teams, users }){
  const backendTeam   = teams.find(t => t.department === 'backend');
  const backendAgents = backendTeam
    ? users.filter(u => u.role === 'agent' && u.teamId === backendTeam.id)
    : [];
  const autoMode = backendTeam?.assignmentMode === 'auto';

  let cursor = backendTeam?.assignmentCursor || 0;
  const startStage = company?.hasDuAccount ? 'Financial Approval' : 'Account Creation';

  const resolvedItems = items.map(it => {
    let assignedBackendAgent = null;
    if(autoMode){
      const picked = pickBackendAgent(it.category, backendAgents, cursor);
      assignedBackendAgent = picked.agentId;
      cursor = picked.nextCursor;
    }
    return {
      itemId: it.itemId, productId: it.productId, productName: it.productName,
      category: it.category, subType: it.subType, dealValue: Number(it.dealValue)||0,
      stage: startStage, activityRef: null, workOrderRef: null,
      blocked: null, pausedAtStage: null, correctionNote: '',
      stageHistory: [{ ts: now(), actorId: CU.uid, actorName: CP.name, stage: startStage, note: 'Submitted' }],
      assignedBackendAgent, activatedAt: null
    };
  });

  const subRef = doc(collection(db,'submissions'));
  const uploadedFiles = [];
  for(const f of files){
    const storagePath = `submissions/${subRef.id}/${Date.now()}_${f.file.name}`;
    await uploadBytes(ref(storage, storagePath), f.file);
    uploadedFiles.push({
      docType: f.docType, name: f.file.name, storagePath,
      uploadedAt: now(), uploadedBy: CU.uid, size: f.file.size, type: f.file.type
    });
  }

  const bat = writeBatch(db);
  bat.set(subRef, {
    leadId: lead.id, companyId: lead.companyId,
    agentId: CU.uid, agentName: CP.name,
    teamId: lead.teamId||'', tlId: lead.tlId||'',
    items: resolvedItems,
    requiredDocs,
    files: uploadedFiles,
    submittedAt: now(), submittedBy: CU.uid,
    createdAt: now(), lastEditedBy: CP.name, lastEditedAt: now()
  });
  if(backendTeam && cursor !== (backendTeam.assignmentCursor||0)){
    bat.update(doc(db,'teams',backendTeam.id), { assignmentCursor: cursor });
  }
  await bat.commit();
  return subRef.id;
}
