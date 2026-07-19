import {
  db, CU, CP,
  collection, getDocs, doc, getDoc
} from './state.js';
import { esc, fmtDate, toast, modal, closeModal } from './helpers.js';
import { SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_COLORS } from './submissions.js';

// ════════════════════════════════════════════════════
// BACKEND QUEUE (ARCHITECTURE.md §4/§5, this session's step 1-3)
// Visible to active backend-department staff and managers only (gated in
// js/main.js's getTabs(), mirroring the submissions read rule's
// isActiveBackend() clause).
//
// Query note: the submissions read rule's backend/manager clause
// (role()=='manager' || isActiveBackend()) does NOT reference resource.data
// at all — unlike team_lead/agent's clauses, it's true or false purely from
// the ACTOR's own user doc, so it's providable for ANY query shape,
// including a bare unfiltered fetch. No teamId/agentId mirroring is needed
// here the way the Pipeline tab's per-role queries need it (see the
// LIST-query gotcha in PROJECT_SPEC.md's Firestore Security Rules section).
//
// This deliberately fetches the whole submissions collection once (bounded
// by QUEUE_SCAN_CAP) rather than a handful of narrower server-side queries,
// specifically to avoid needing new Firestore composite indexes: combining
// an equality filter (assignedBackendAgent/status) with orderBy(createdAt)
// on a different field requires one, and the queue's three views × the
// terminal-status toggle would need several. Same "manager/backend needs a
// full bounded view" exception already used by the Org tab's team/user/lead
// scans and fetchCompanies()'s two documented exceptions (ARCHITECTURE.md
// §9) — every filter/sort below runs client-side over that one fetch.
// ════════════════════════════════════════════════════

const TERMINAL_STATUSES = ['activated','rejected'];
const QUEUE_SCAN_CAP = 3000;

export async function renderQueueTab(){
  const ct = document.getElementById('content');
  ct.innerHTML = '<div class="loading"><div class="spin"></div> Loading…</div>';

  let submissions, backendUsers, byId, companyById;
  try {
    const [subSnap, userSnap] = await Promise.all([
      getDocs(collection(db,'submissions')),
      getDocs(collection(db,'users'))
    ]);
    submissions = subSnap.docs.slice(0, QUEUE_SCAN_CAP).map(d=>({id:d.id,...d.data()}));
    const allUsers = userSnap.docs.map(d=>({id:d.id,...d.data()}));
    backendUsers = allUsers.filter(u => u.department==='backend' && u.active!==false);
    byId = {}; allUsers.forEach(u=>byId[u.id]=u);

    // Company names aren't denormalized onto the submission — targeted
    // per-doc fetch of just the companies actually referenced (bounded by
    // however many UNIQUE companies appear, not a full companies scan,
    // matching ARCHITECTURE.md §9's "no fetch-all-companies" rule).
    const companyIds = [...new Set(submissions.map(s=>s.companyId).filter(Boolean))];
    const companySnaps = await Promise.all(companyIds.map(id => getDoc(doc(db,'companies',id))));
    companyById = {};
    companySnaps.forEach(s => { if(s.exists()) companyById[s.id] = s.data(); });
  } catch(e){
    ct.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><div class="empty-title">Error loading queue</div><div class="empty-sub">${esc(e.message)}</div></div>`;
    return;
  }

  let view = 'unassigned'; // 'unassigned' | 'mine' | 'all'
  let statusF = '';
  let includeTerminal = false;

  function agentName(uid){ return byId[uid]?.name || '—'; }

  function filtered(){
    let list = submissions;
    if(view==='unassigned') list = list.filter(s => !s.assignedBackendAgent);
    else if(view==='mine')  list = list.filter(s => s.assignedBackendAgent===CU.uid);
    if(statusF) list = list.filter(s => s.status===statusF);
    else if(!includeTerminal) list = list.filter(s => !TERMINAL_STATUSES.includes(s.status));
    return [...list].sort((a,b) => (a.createdAt||'').localeCompare(b.createdAt||''));
  }

  function render(){
    const list = filtered();
    const counts = {
      unassigned: submissions.filter(s=>!s.assignedBackendAgent).length,
      mine: submissions.filter(s=>s.assignedBackendAgent===CU.uid).length,
      all: submissions.length
    };
    ct.innerHTML = `
      <div class="pg-hdr">
        <div><h2>📥 Backend Queue</h2><p class="pg-hdr-sub">${list.length} submission${list.length!==1?'s':''} shown · oldest first</p></div>
      </div>
      <div class="flex gap-8 mb-12" style="flex-wrap:wrap;align-items:center">
        <button class="filter-btn ${view==='unassigned'?'active':''}" data-view="unassigned">Unassigned (${counts.unassigned})</button>
        <button class="filter-btn ${view==='mine'?'active':''}" data-view="mine">My Queue (${counts.mine})</button>
        <button class="filter-btn ${view==='all'?'active':''}" data-view="all">All (${counts.all})</button>
        <select id="q-status-filter" style="max-width:220px">
          <option value="">All statuses${includeTerminal?'':' (excl. activated/rejected)'}</option>
          ${Object.entries(SUBMISSION_STATUS_LABELS).map(([k,l])=>`<option value="${k}" ${statusF===k?'selected':''}>${esc(l)}</option>`).join('')}
        </select>
        <label class="flex" style="align-items:center;gap:6px;cursor:pointer;margin-left:4px">
          <input type="checkbox" id="q-include-terminal" ${includeTerminal?'checked':''} style="width:auto;margin:0;cursor:pointer">
          <span class="text-sm text-dim">Include activated/rejected</span>
        </label>
      </div>
      ${list.length ? `<div class="tbl-wrap"><table>
        <thead><tr><th>Company</th><th>Product</th><th>Agent</th><th>Status</th><th>Assigned To</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${list.map(s=>`<tr>
            <td class="td-company">${esc(companyById[s.companyId]?.name || '—')}</td>
            <td class="td-dim">${esc(s.productName||'—')} <span class="text-dim text-xs">${esc(s.category||'')}</span></td>
            <td class="td-dim">${esc(s.agentName||'—')}</td>
            <td><span class="text-xs" style="color:${SUBMISSION_STATUS_COLORS[s.status]||'var(--t2)'}">${esc(SUBMISSION_STATUS_LABELS[s.status]||s.status)}</span></td>
            <td class="td-dim text-sm">${s.assignedBackendAgent ? esc(agentName(s.assignedBackendAgent)) : '<span class="text-dim">Unassigned</span>'}</td>
            <td class="td-dim text-sm">${s.createdAt?fmtDate(s.createdAt):'—'}</td>
            <td><button class="btn btn-ghost btn-xs" data-open="${s.id}">Open →</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty"><div class="empty-icon">📥</div><div class="empty-title">No submissions in this view</div><div class="empty-sub">Try a different queue view, status filter, or include activated/rejected.</div></div>`}
    `;

    ct.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; render(); }));
    document.getElementById('q-status-filter').addEventListener('change', function(){ statusF = this.value; render(); });
    document.getElementById('q-include-terminal').addEventListener('change', function(){ includeTerminal = this.checked; render(); });
    ct.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
      const sub = submissions.find(s=>s.id===b.dataset.open);
      if(sub) toast('Action panel arrives in step 3.');
    }));
  }

  render();
}
