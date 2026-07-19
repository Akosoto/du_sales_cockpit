import {
  db, CU, CP, STAGES, MANDATORY_DOC_TYPES, ORG_DEFAULTS,
  doc, getDoc,
  collection, query, where, getDocs,
  orderBy, limit, startAfter, getCountFromServer
} from './state.js';
import { dbAdd, dbUpdate, dbDelete, newBatch, batchUpdate, logBulkAudit } from './db.js';
import { v, esc, now, fmtDate, disable, enable, toast, modal, closeModal, confirmModal, stagePill, buildMsFilter, wireMsFilter, fixSelectScrollClip } from './helpers.js';
import { searchCompanies, findCompanyByAccountCode, findOrCreateCompany, findFuzzyMatch, normalizeCompanyName } from './companies.js';
import {
  computeRequiredDocs, docExpiryWarnings, createSubmissions, generateBundleId,
  SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_COLORS, EVENT_LABELS
} from './submissions.js';
import { captureFile, PDF_PAGE_CAP } from './documents.js';
import * as storage from './storage/index.js';

// ════════════════════════════════════════════════════
// PIPELINE TAB
// ════════════════════════════════════════════════════
// ARCHITECTURE.md Phase A quota-discipline stopgap: the old version of this
// tab did one unbounded getDocs(collection(db,'leads')) per role — fine at
// 115 seed leads, but a hard 50K reads/day quota problem within weeks of
// real usage at the stated growth rate. Replaced with:
//  - Real server-side pagination (orderBy+limit+startAfter) for the default
//    browse path (role scope + stage tabs) — Firestore auto-appends a
//    document-ID tiebreaker to every orderBy, so cursors stay stable even
//    when many leads share one lastEditedAt (e.g. a bulk-assign batch).
//    Visited pages are cached in memory (both their cursor AND their
//    rendered rows), so revisiting a page costs zero additional reads;
//    jumping to an unvisited page walks the intervening pages once.
//  - getCountFromServer() (a cheap aggregation query, ~1 read per 1000
//    matched docs) for stage-tab counts and total-page count, instead of
//    scanning everything just to count it.
//  - Team/TL/Agent filters and free-text search can't be pushed server-side
//    without a paid full-text index, so they auto-load additional pages of
//    the current stage+role query in the background (up to SCAN_CAP) and
//    filter client-side over everything loaded so far — correctness over
//    the search box's coverage, bounded so one search action can't runaway
//    into a full-collection scan.
const PAGE_SIZE = 25;
const SCAN_CAP  = 5000;

export async function renderPipelineTab(){
  const ct   = document.getElementById('content');
  const role = CP.role;

  if(role==='team_lead' && !CP.teamId){
    ct.innerHTML=`<div class="empty mt-16"><div class="empty-icon">👥</div><div class="empty-title">Not assigned to a team</div><div class="empty-sub">Contact your manager.</div></div>`;
    return;
  }

  // Load users
  const uSnap  = await getDocs(collection(db,'users'));
  const byId   = {}; uSnap.docs.forEach(d=>byId[d.id]={id:d.id,...d.data()});

  function roleScopeWhere(){
    if(role==='team_lead') return [where('teamId','==',CP.teamId)];
    if(role==='agent')     return [where('assignedTo','==',CU.uid)];
    return [];
  }
  function dataQuery(stage, cursor){
    const c = [...roleScopeWhere()];
    if(stage) c.push(where('stage','==',stage));
    c.push(orderBy('lastEditedAt','desc'));
    if(cursor) c.push(startAfter(cursor));
    c.push(limit(PAGE_SIZE));
    return query(collection(db,'leads'), ...c);
  }
  function countQuery(stage){
    const c = [...roleScopeWhere()];
    if(stage) c.push(where('stage','==',stage));
    return query(collection(db,'leads'), ...c);
  }

  // Available agents for assignment dropdown — TL scoped to own sub-group only (Model B)
  let agents = [];
  if(role==='manager')   agents = Object.values(byId).filter(u=>u.role==='agent'&&u.active!==false);
  if(role==='team_lead') agents = Object.values(byId).filter(u=>u.role==='agent'&&u.tlId===CU.uid&&u.active!==false);

  // Bulk-assign eligibility — TL can only reassign leads already in their own
  // sub-group (or unowned); a lead in another TL's sub-group would fail the
  // Firestore rule and fail the whole batch, so keep it out of the picker entirely.
  function bulkEligible(l){
    if(role==='agent') return false;
    if(role==='team_lead') return l.tlId===CU.uid || !l.tlId;
    return true; // manager
  }

  // Filter option lists
  let teamsForFilter = [];
  if(role==='manager'){
    const tSnap = await getDocs(collection(db,'teams'));
    teamsForFilter = tSnap.docs.map(d=>({id:d.id,...d.data()}));
  }
  const tlsForFilter    = role==='manager' ? Object.values(byId).filter(u=>u.role==='team_lead'&&u.active!==false) : [];
  const agentsForFilter = agents;

  // Manager-only pending delete-request banner — a separate, small bounded
  // query (deletion requests are inherently rare; doesn't need pagination).
  // Firestore's != excludes both null AND missing-field docs, which is
  // exactly "no pending request" either way.
  let pendingDeletes = [];
  if(role==='manager'){
    const pdSnap = await getDocs(query(collection(db,'leads'), where('deleteRequest','!=',null), limit(200)));
    pendingDeletes = pdSnap.docs.map(d=>({id:d.id,...d.data()}));
  }

  // Stage-tab counts — cheap aggregation queries instead of a full scan.
  const sCounts = {};
  const [totalAgg, ...stageAggs] = await Promise.all([
    getCountFromServer(countQuery('')),
    ...STAGES.map(s => getCountFromServer(countQuery(s)))
  ]);
  STAGES.forEach((s,i) => sCounts[s] = stageAggs[i].data().count);

  let stageF='', searchF='';
  let teamFs=[], tlFs=[], agentFs=[];
  const selected = new Set();

  // ── Paged mode state (default) ──
  let pageContent = {};      // {pageNum: [...leads]} — cached rendered rows
  let pageBoundaries = [];   // pageBoundaries[i] = last doc snapshot of page i+1
  let totalCount = totalAgg.data().count;

  // ── Expanded mode state (team/TL/agent filter or search active) ──
  let expandedLeads = [];
  let expandedCursor = null;
  let expandedDone = false;
  let expandedCapped = false;

  let currentPage = 1;
  let totalPages = 1;
  let visibleLeads = [];

  function filtersActive(){ return !!searchF || teamFs.length || tlFs.length || agentFs.length; }

  function applyClientFilters(list){
    let r = list;
    if(searchF){ const q=searchF.toLowerCase(); r=r.filter(l=>(l.company||'').toLowerCase().includes(q)||(l.contact||'').toLowerCase().includes(q)||(l.email||'').toLowerCase().includes(q)||(l.phone||'').includes(q)); }
    if(teamFs.length)  r = r.filter(l=>teamFs.includes(l.teamId));
    if(tlFs.length)    r = r.filter(l=>tlFs.includes(l.tlId));
    if(agentFs.length) r = r.filter(l=>agentFs.includes(l.assignedTo));
    return r;
  }

  async function ensureExpandedLoaded(){
    while(!expandedDone && expandedLeads.length < SCAN_CAP){
      const snap = await getDocs(dataQuery(stageF, expandedCursor));
      if(snap.empty){ expandedDone = true; break; }
      expandedLeads.push(...snap.docs.map(d=>({id:d.id,...d.data()})));
      expandedCursor = snap.docs[snap.docs.length-1];
      if(snap.docs.length < PAGE_SIZE) expandedDone = true;
    }
    if(!expandedDone && expandedLeads.length >= SCAN_CAP) expandedCapped = true;
  }

  // Navigate within the CURRENT mode/filter set (pager clicks) — reuses
  // cache, never resets it.
  async function goToPage(n){
    try {
      if(filtersActive()){
        const list = applyClientFilters(expandedLeads);
        totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
        n = Math.min(Math.max(1,n), totalPages);
        currentPage = n;
        visibleLeads = list.slice((n-1)*PAGE_SIZE, n*PAGE_SIZE);
      } else {
        totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
        n = Math.min(Math.max(1,n), totalPages);
        if(!pageContent[n]){
          for(let p=pageBoundaries.length+1; p<=n; p++){
            const cursor = p===1 ? null : pageBoundaries[p-2];
            const snap = await getDocs(dataQuery(stageF, cursor));
            pageContent[p] = snap.docs.map(d=>({id:d.id,...d.data()}));
            if(snap.docs.length) pageBoundaries[p-1] = snap.docs[snap.docs.length-1];
          }
        }
        currentPage = n;
        visibleLeads = pageContent[n] || [];
      }
    } catch(e){
      toast(e.code==='failed-precondition' ? 'This view needs a one-time Firestore index — check the console for the creation link.' : 'Error loading leads: '+e.message, 'err');
      console.error('Pipeline query failed', e);
      visibleLeads = [];
    }
    selected.clear();
    renderList();
  }

  // Stage tab / search / team-TL-agent filter changes all land here — the
  // underlying result SET changed, so cache/mode resets before paging to 1.
  async function refreshView(){
    try {
      if(filtersActive()){
        expandedLeads=[]; expandedCursor=null; expandedDone=false; expandedCapped=false;
        await ensureExpandedLoaded();
      } else {
        pageContent={}; pageBoundaries=[];
      }
      totalCount = stageF ? sCounts[stageF] : totalAgg.data().count;
    } catch(e){
      toast(e.code==='failed-precondition' ? 'This view needs a one-time Firestore index — check the console for the creation link.' : 'Error loading leads: '+e.message, 'err');
      console.error('Pipeline query failed', e);
    }
    await goToPage(1);
  }

  ct.innerHTML = `
    <div class="pg-hdr">
      <div>
        <h2>${role==='manager'?'All Leads':role==='team_lead'?'Team Pipeline':'My Leads'}</h2>
        <p class="pg-hdr-sub" id="lead-cnt">${totalCount} leads</p>
      </div>
      <div class="pg-actions">
        <input type="text" id="srch" class="search-input" placeholder="Search company, contact…">
        <button class="btn btn-primary btn-sm" id="btn-add-lead">+ Add Lead</button>
      </div>
    </div>
    ${pendingDeletes.length ? `<div class="seed-banner" id="del-req-banner" style="flex-direction:column;align-items:stretch">
      <p>🗑 <strong>${pendingDeletes.length} deletion request${pendingDeletes.length!==1?'s':''}</strong> awaiting your approval.</p>
      <div class="tbl-wrap" style="margin-top:10px"><table>
        <thead><tr><th>Company</th><th>Requested By</th><th>Date</th><th></th></tr></thead>
        <tbody>
          ${pendingDeletes.map(l=>`<tr>
            <td class="td-company">${esc(l.company||'—')}</td>
            <td class="td-dim">${esc(l.deleteRequest.requestedByName||'—')}</td>
            <td class="td-dim text-sm">${fmtDate(l.deleteRequest.requestedAt)}</td>
            <td class="flex gap-8">
              <button class="btn btn-danger btn-xs" data-approve-del="${l.id}">✅ Approve</button>
              <button class="btn btn-ghost btn-xs" data-reject-del="${l.id}">✖ Reject</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>` : ''}
    ${role!=='agent' ? `<div class="adv-filters" id="adv-filters">
      <span class="adv-filters-lbl">Filter by</span>
      ${role==='manager' ? buildMsFilter('ms-tm','Team',teamsForFilter) : ''}
      ${role==='manager' ? buildMsFilter('ms-tl','TL',tlsForFilter) : ''}
      ${agentsForFilter.length ? buildMsFilter('ms-ag','Agent',agentsForFilter) : ''}
    </div>` : ''}
    <div class="filters" id="filters">
      <button class="filter-btn active" data-s="">All <span class="filter-count">${totalAgg.data().count}</span></button>
      ${STAGES.map(s=>`<button class="filter-btn" data-s="${s}">${s} <span class="filter-count">${sCounts[s]}</span></button>`).join('')}
    </div>
    <div id="bulk-bar-wrap"></div>
    <div id="scan-warning"></div>
    <div id="lead-list"></div>
    <div id="pager"></div>`;

  function renderBulkBar(){
    const wrap = document.getElementById('bulk-bar-wrap');
    if(role==='agent' || !selected.size){ wrap.innerHTML=''; return; }
    wrap.innerHTML = `<div class="bulk-bar">
      <strong>${selected.size} selected</strong>
      <select id="bulk-assign-sel">
        <option value="">Assign to…</option>
        ${agents.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" id="bulk-assign-btn">Assign</button>
      <button class="btn btn-ghost btn-sm" id="bulk-clear-btn">Clear selection</button>
    </div>`;
    document.getElementById('bulk-clear-btn').addEventListener('click', () => { selected.clear(); renderList(); });
    document.getElementById('bulk-assign-btn').addEventListener('click', async () => {
      const targetId = v('bulk-assign-sel');
      if(!targetId){ toast('Pick an agent to assign to first.','err'); return; }
      const target = byId[targetId];
      const ids = [...selected];
      disable('bulk-assign-btn','Assigning…');
      try {
        // CHUNK=200 + skipAudit:true per-op: same fix as every other bulk
        // path (js/db.js's auditLog write would otherwise double writes-per-
        // op). Currently bounded by pagination (selection resets per page,
        // capped at PAGE_SIZE) so this can't hit the 500-write cap today —
        // fixed anyway so a future "select all matching filter" can't
        // silently reintroduce it. lastEditedBy/lastEditedAt are passed
        // explicitly so skipAudit doesn't drop them (caller-provided fields
        // always win over the gateway's defaults, skipped or not).
        const CHUNK = 200;
        for(let i=0;i<ids.length;i+=CHUNK){
          const bat = newBatch();
          ids.slice(i,i+CHUNK).forEach(id=>{
            const lead = visibleLeads.find(l=>l.id===id); if(!lead) return;
            batchUpdate(bat, 'leads', id, {
              assignedTo: targetId,
              teamId: target.teamId||'', tlId: target.tlId||'',
              lastEditedBy: CP.name, lastEditedAt: now(),
              history: [...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:`Assigned: ${byId[lead.assignedTo]?.name||'—'} → ${target.name} (bulk)` }]
            }, {skipAudit:true});
          });
          await bat.commit();
        }
        await logBulkAudit(`Bulk-assigned ${ids.length} lead(s) to ${target.name}`, ids.length);
        toast(`${ids.length} lead${ids.length!==1?'s':''} assigned to ${target.name}.`);
        selected.clear();
        renderPipelineTab();
      } catch(e){ toast('Error: '+e.message,'err'); enable('bulk-assign-btn','Assign'); }
    });
  }

  function renderPager(){
    const el = document.getElementById('pager');
    if(totalPages <= 1){ el.innerHTML=''; return; }
    const pages = [1];
    if(currentPage - 2 > 2) pages.push('…');
    for(let p=Math.max(2,currentPage-2); p<=Math.min(totalPages-1,currentPage+2); p++) pages.push(p);
    if(currentPage + 2 < totalPages - 1) pages.push('…');
    if(totalPages>1) pages.push(totalPages);
    el.innerHTML = `<div class="flex gap-8 mt-12" style="flex-wrap:wrap;align-items:center">
      ${pages.map(p=>p==='…'?`<span class="text-dim">…</span>`:`<button class="filter-btn${p===currentPage?' active':''}" data-pg="${p}">${p}</button>`).join('')}
    </div>`;
    el.querySelectorAll('[data-pg]').forEach(b=>b.addEventListener('click',()=>goToPage(Number(b.dataset.pg))));
  }

  // Pipeline submission-status badge (step 0d) — reads the denormalized
  // lead.submissionSummary stamped by createSubmissions/appendEvent, never a
  // per-lead query. A Closed lead with no summary at all is exactly the
  // "closed but never submitted" gap a TL needs to catch, so it gets its own
  // attention-styled badge instead of just silently showing nothing.
  const SUBMISSION_BADGE_LABELS = { submitted:'Submitted', inProgress:'In Progress', activated:'Activated', rejected:'⚠ Rejected' };
  function submissionBadgeHtml(l){
    const summary = l.submissionSummary;
    if(!summary || summary === 'none'){
      return l.stage === 'Closed' ? `<span class="subb subb-none">Not submitted</span>` : '';
    }
    return `<span class="subb subb-${summary}">${SUBMISSION_BADGE_LABELS[summary]||summary}</span>`;
  }

  function renderList(){
    const cnt = filtersActive() ? applyClientFilters(expandedLeads).length : totalCount;
    document.getElementById('lead-cnt').textContent = `${cnt} lead${cnt!==1?'s':''}`;
    const warnEl = document.getElementById('scan-warning');
    warnEl.innerHTML = expandedCapped ? `<p class="text-sm" style="color:var(--amber);margin:8px 0">⚠ Search/filter scanned ${SCAN_CAP.toLocaleString()} leads (the safety limit) without reaching the end — narrow with a stage or team filter for complete results.</p>` : '';
    const el = document.getElementById('lead-list');
    renderBulkBar();
    renderPager();
    if(!visibleLeads.length){ el.innerHTML=`<div class="empty"><div class="empty-icon">📋</div><div class="empty-title">No leads found</div><div class="empty-sub">Try adjusting your search or filter.</div></div>`; return; }
    const canBulk = role !== 'agent' && agents.length > 0;
    const eligible = canBulk ? visibleLeads.filter(bulkEligible) : [];
    el.innerHTML = `<div class="tbl-wrap"><table>
      <thead><tr>${canBulk?`<th><input type="checkbox" id="chk-all" class="lead-chk"></th>`:''}<th>Company</th><th>Contact</th><th>Phone</th>${role!=='agent'?'<th>Agent</th>':''}
        <th>Stage</th><th>City</th><th>Follow-up</th><th>Updated</th><th></th></tr></thead>
      <tbody>
        ${visibleLeads.map(l=>`<tr>
          ${canBulk?(bulkEligible(l)?`<td><input type="checkbox" class="lead-chk" data-chk="${l.id}"${selected.has(l.id)?' checked':''}></td>`:'<td></td>'):''}
          <td class="td-company">${esc(l.company||'—')}${l.assignedTo===CU.uid?'<span style="font-size:10px;font-weight:700;background:rgba(16,185,129,.2);color:#34d399;padding:2px 8px;border-radius:10px;margin-left:6px;vertical-align:middle">📌 Mine</span>':''}</td>
          <td class="td-dim">${esc(l.contact||'—')}</td>
          <td class="td-dim">${l.phone?`<a href="tel:${l.phone}">${l.phone}</a>`:'—'}</td>
          ${role!=='agent'?`<td class="td-dim">${esc(byId[l.assignedTo]?.name||'—')}</td>`:''}
          <td>${stagePill(l.stage)}${submissionBadgeHtml(l)}</td>
          <td class="td-dim">${esc(l.city||'—')}</td>
          <td class="td-dim text-sm">${l.followup||'—'}</td>
          <td class="td-dim text-sm">${l.lastEditedAt?fmtDate(l.lastEditedAt):'—'}</td>
          <td><button class="btn btn-ghost btn-xs" data-lid="${l.id}">View →</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
    el.querySelectorAll('[data-lid]').forEach(b=>b.addEventListener('click',()=>{
      const lead = visibleLeads.find(x=>x.id===b.dataset.lid);
      if(lead) showLeadModal(lead, byId, agents);
    }));
    if(canBulk && eligible.length){
      const chkAll = document.getElementById('chk-all');
      chkAll.checked = eligible.every(l=>selected.has(l.id));
      chkAll.addEventListener('change', () => {
        eligible.forEach(l => chkAll.checked ? selected.add(l.id) : selected.delete(l.id));
        renderList();
      });
      el.querySelectorAll('[data-chk]').forEach(cb=>cb.addEventListener('change', () => {
        cb.checked ? selected.add(cb.dataset.chk) : selected.delete(cb.dataset.chk);
        renderBulkBar();
        chkAll.checked = eligible.every(l=>selected.has(l.id));
      }));
    }
  }

  await goToPage(1);

  let searchDebounce;
  document.getElementById('srch').addEventListener('input', e=>{
    searchF = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(refreshView, 400);
  });
  document.querySelectorAll('[data-s]').forEach(b=>b.addEventListener('click',()=>{
    stageF=b.dataset.s;
    document.querySelectorAll('[data-s]').forEach(x=>x.classList.toggle('active',x===b));
    refreshView();
  }));
  document.getElementById('btn-add-lead').addEventListener('click',()=>showAddLeadModal(agents, byId));
  wireMsFilter('ms-tm', teamFs,  refreshView);
  wireMsFilter('ms-tl', tlFs,    refreshView);
  wireMsFilter('ms-ag', agentFs, refreshView);

  document.querySelectorAll('[data-approve-del]').forEach(b=>b.addEventListener('click',()=>{
    const l = pendingDeletes.find(x=>x.id===b.dataset.approveDel); if(!l) return;
    confirmModal(`Approve deletion for ${esc(l.company)}?`, 'This cannot be undone.', async () => {
      await dbDelete('leads', l.id);
      toast('Lead deleted.','info'); renderPipelineTab();
    });
  }));
  document.querySelectorAll('[data-reject-del]').forEach(b=>b.addEventListener('click', async () => {
    const l = pendingDeletes.find(x=>x.id===b.dataset.rejectDel); if(!l) return;
    await dbUpdate('leads', l.id, {
      deleteRequest:null,
      history:[...(l.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion request rejected' }]
    });
    toast('Deletion request rejected.','info'); renderPipelineTab();
  }));
}

// ─── LEAD MODAL ───
export async function showLeadModal(lead, byId, agents){
  const role      = CP.role;
  const isLocked  = lead.ownerLocked;
  const ownLead   = lead.createdBy === CU.uid;
  const canDeleteDirect = role==='manager'
    || (role==='team_lead' && !isLocked && lead.teamId===CP.teamId)
    || (role==='agent'     && !isLocked && ownLead);
  const canRequestDelete   = role==='team_lead' && isLocked && lead.teamId===CP.teamId;
  const hasPendingDeleteReq = !!lead.deleteRequest;
  const isMyDeleteRequest  = hasPendingDeleteReq && lead.deleteRequest.requestedBy===CU.uid;
  const showAssign = role==='manager' || role==='team_lead';

  // Backend handoff — only relevant once a lead is Closed and has a linked
  // company. Only fetched for Closed leads to avoid an extra read on every
  // lead open. Wrapped defensively: a rules/network hiccup on this lookup
  // must never block the rest of the (unrelated) lead modal from opening.
  //
  // v2 schema (ARCHITECTURE.md §5): one submission DOC per product line, so
  // a single Submit-to-Backend form now produces MULTIPLE docs sharing one
  // bundleId. existingSubmissions holds ALL of them for this lead — still
  // gates the Submit button on "any bundle already exists" (v1 tradeoff,
  // unchanged — repeat orders on the same lead are a future revisit), but
  // the display below now shows a proper summary instead of assuming one doc.
  let existingSubmissions = [];
  const canSubmit = lead.stage==='Closed' && lead.companyId && (role==='manager' || lead.assignedTo===CU.uid);
  const canViewTimeline = role==='manager' || lead.assignedTo===CU.uid || (role==='team_lead' && lead.teamId===CP.teamId);
  if(lead.stage==='Closed' && lead.companyId && canViewTimeline){
    try {
      // Firestore rejects a LIST query outright unless it can prove every
      // possible matched document satisfies the read rule — it does NOT
      // filter per-document the way a single get() effectively does. The
      // submissions read rule is an OR of role-scoped clauses
      // (manager | agentId==self | team_lead+teamId match | backend), so a
      // bare where('leadId','==',...) is only provable for manager (whose
      // clause doesn't depend on resource.data at all). Every other role
      // needs the SAME field the rule checks ALSO present as a query
      // constraint, matching that specific clause exactly.
      const subConstraints = [where('leadId','==',lead.id)];
      if(role==='team_lead') subConstraints.push(where('teamId','==',CP.teamId));
      else if(role!=='manager') subConstraints.push(where('agentId','==',CU.uid));
      const subSnap = await getDocs(query(collection(db,'submissions'), ...subConstraints));
      existingSubmissions = subSnap.docs.map(d=>({id:d.id,...d.data()}));
    } catch(e){ /* submissions rule may not be published yet — degrade gracefully */ }
  }
  const bundleCount = new Set(existingSubmissions.map(s=>s.bundleId)).size;

  modal(`${esc(lead.company||'Lead')}`, `
    <div class="info-grid mb-12">
      <div class="info-item"><div class="lbl">Contact</div><div class="val">${esc(lead.contact||'—')}</div></div>
      <div class="info-item"><div class="lbl">Company</div><div class="val"><strong>${esc(lead.company||'—')}</strong></div></div>
      <div class="info-item"><div class="lbl">Phone</div><div class="val">${lead.phone?`<a href="tel:${lead.phone}">${lead.phone}</a>`:'—'}</div></div>
      <div class="info-item"><div class="lbl">Email</div><div class="val">${lead.email?`<a href="mailto:${lead.email}">${lead.email}</a>`:'—'}</div></div>
      <div class="info-item"><div class="lbl">Industry</div><div class="val">${esc(lead.industry||'—')}</div></div>
      <div class="info-item"><div class="lbl">City</div><div class="val">${esc(lead.city||'—')}</div></div>
    </div>
    ${showAssign ? `<div class="field mb-12"><label>Assigned To</label><select id="ls-assign">${!lead.assignedTo?`<option value="" selected>— Unassigned —</option>`:''}${agents.map(a=>`<option value="${a.id}"${a.id===lead.assignedTo?' selected':''}>${esc(a.name)}</option>`).join('')}${lead.assignedTo&&!agents.find(a=>a.id===lead.assignedTo)&&byId[lead.assignedTo]?`<option value="${lead.assignedTo}" selected>${esc(byId[lead.assignedTo].name)} (current)</option>`:''}</select></div>` : `<div class="info-item mb-12"><div class="lbl">Assigned To</div><div class="val">${esc(byId[lead.assignedTo]?.name||'— Unassigned —')}</div></div>`}
    <div class="divider"></div>
    <div class="row2">
      <div class="field"><label>Stage</label>
        <select id="ls-stage">${STAGES.map(s=>`<option value="${s}"${s===lead.stage?' selected':''}>${s}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Follow-up Date</label><input type="date" id="ls-fu" value="${lead.followup||''}"></div>
    </div>
    <div id="ls-dv-wrap" style="${lead.stage==='Closed'?'':'display:none'}">
      <div class="field"><label>Deal Value (AED)</label><input type="number" id="ls-dv" value="${lead.dealValue||0}" placeholder="0"></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="ls-notes" rows="3">${esc(lead.notes||'')}</textarea></div>
    ${isLocked && role!=='manager' ? `<div class="locked-note">⚠ Manager-created lead. Stage, notes and follow-up are editable. Reassignment is manager-only; deletion requires manager approval.</div>` : ''}
    ${hasPendingDeleteReq ? `<div class="locked-note" style="background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:var(--red)">🗑 Deletion requested by <strong>${esc(lead.deleteRequest.requestedByName||'—')}</strong> on ${fmtDate(lead.deleteRequest.requestedAt)} — pending manager approval.</div>` : ''}
    ${existingSubmissions.length ? `<div class="locked-note" style="background:rgba(124,58,237,.1);border-color:rgba(124,58,237,.3);color:var(--purple2)">📤 Submitted to backend — ${bundleCount} bundle${bundleCount!==1?'s':''}, ${existingSubmissions.length} line item${existingSubmissions.length!==1?'s':''}.${canViewTimeline?' <button type=\"button\" class=\"btn btn-ghost btn-xs\" id=\"lm-view-timeline\" style=\"margin-left:8px\">View Timeline</button>':''}</div>` : ''}
    ${canSubmit && !existingSubmissions.length ? `<button class="btn btn-primary btn-full mt-12" id="lm-submit">📤 Submit to Backend</button>` : ''}
    <p class="text-dim text-xs mt-8">Last edited by <strong>${esc(lead.lastEditedBy||'—')}</strong> · ${lead.lastEditedAt?fmtDate(lead.lastEditedAt):'—'}</p>
    <p id="lm-err" class="err"></p>
    <div class="flex gap-8 mt-12" style="flex-wrap:wrap">
      <button class="btn btn-primary" id="lm-save">Save Changes</button>
      ${canDeleteDirect ? `<button class="btn btn-danger btn-sm" id="lm-del">Delete Lead</button>` : ''}
      ${canRequestDelete && !hasPendingDeleteReq ? `<button class="btn btn-ghost btn-sm" id="lm-reqdel" style="border-color:var(--amber);color:var(--amber)">🔒 Request Deletion</button>` : ''}
      ${canRequestDelete && hasPendingDeleteReq && isMyDeleteRequest ? `<button class="btn btn-ghost btn-sm" id="lm-withdraw-del">Withdraw Delete Request</button>` : ''}
      ${role==='manager' && hasPendingDeleteReq ? `<button class="btn btn-danger btn-sm" id="lm-approve-del">✅ Approve Deletion</button><button class="btn btn-ghost btn-sm" id="lm-reject-del">✖ Reject Request</button>` : ''}
    </div>`,true);

  document.getElementById('lm-submit')?.addEventListener('click', () => showSubmitModal(lead, byId));
  document.getElementById('lm-view-timeline')?.addEventListener('click', () => showSubmissionTimelineModal(lead, existingSubmissions));

  fixSelectScrollClip('ls-stage');

  // Show deal value when Won
  document.getElementById('ls-stage').addEventListener('change', function(){
    document.getElementById('ls-dv-wrap').style.display = this.value==='Closed' ? '' : 'none';
  });

  document.getElementById('lm-save').onclick = async () => {
    const stage = v('ls-stage'), fu = v('ls-fu'), notes = v('ls-notes');
    const dv    = v('ls-dv') || lead.dealValue || 0;
    const newAssignTo = showAssign ? (v('ls-assign')||lead.assignedTo) : lead.assignedTo;
    disable('lm-save','Saving…');
    try {
      // Build change summary against lead snapshot
      const changes = [];
      if(stage !== lead.stage)                     changes.push(`Stage: ${lead.stage} → ${stage}`);
      if(newAssignTo !== lead.assignedTo)          changes.push(`Assigned: ${byId[lead.assignedTo]?.name||'—'} → ${byId[newAssignTo]?.name||newAssignTo}`);
      if(notes !== (lead.notes||''))               changes.push('Notes updated');
      if(fu !== (lead.followup||''))               changes.push(`Follow-up: ${fu||'cleared'}`);
      if(Number(dv) !== Number(lead.dealValue||0)) changes.push(`Deal value: AED ${Number(dv).toLocaleString()}`);
      const changeSummary = changes.length ? changes.join('; ') : 'No changes';

      // Build update payload
      const update = {
        stage, followup:fu, notes, dealValue:Number(dv),
        assignedTo:newAssignTo,
        history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:changeSummary }]
      };

      // Re-resolve teamId only if assignee changed
      if(newAssignTo !== lead.assignedTo){
        const aSnap = await getDoc(doc(db,'users',newAssignTo));
        update.teamId = aSnap.exists() ? (aSnap.data().teamId||'') : '';
        update.tlId   = aSnap.exists() ? (aSnap.data().tlId  ||'') : '';
      }

      await dbUpdate('leads', lead.id, update);
      renderPipelineTab();

      // Close-to-submit: saving into Closed (with a company already linked,
      // and nothing submitted for this lead yet) transitions straight into
      // the Submit to Backend view instead of just closing — the whole point
      // of closing a lead is to hand it to backend, so make that the next
      // natural step rather than a separate thing to remember to do.
      // canSubmit (computed at modal-open time) checked the ORIGINAL
      // lead.stage — useless here since this save may be the very save that
      // sets stage to 'Closed'. Re-check permission against the just-saved
      // values instead.
      const updatedLead = {...lead, ...update};
      const canSubmitNow = updatedLead.companyId && (role==='manager' || updatedLead.assignedTo===CU.uid);
      if(stage === 'Closed' && canSubmitNow && !existingSubmissions.length){
        toast('Lead saved.');
        await showSubmitModal(updatedLead, byId);
      } else {
        closeModal(); toast('Lead saved.');
      }
    } catch(e){ document.getElementById('lm-err').textContent=e.message; enable('lm-save','Save Changes'); }
  };

  document.getElementById('lm-del')?.addEventListener('click',()=>{
    // Runtime guards — enforce delete rules at point of action
    if(role==='team_lead' && (lead.ownerLocked || lead.teamId!==CP.teamId)){
      toast('You can only delete unowned leads within your own team.','err'); return;
    }
    if(role==='agent' && (lead.ownerLocked || lead.createdBy!==CU.uid)){
      toast('You can only delete leads you created.','err'); return;
    }
    confirmModal(`Delete lead for ${esc(lead.company)}?`,
      'This cannot be undone.',
      async () => {
        await dbDelete('leads', lead.id);
        closeModal(); toast('Lead deleted.','info'); renderPipelineTab();
      });
  });

  document.getElementById('lm-reqdel')?.addEventListener('click',()=>{
    confirmModal(`Request deletion for ${esc(lead.company)}?`,
      'This lead was created by your manager. A deletion request will be sent for approval — the lead stays active until approved.',
      async () => {
        await dbUpdate('leads', lead.id, {
          deleteRequest: { requestedBy:CU.uid, requestedByName:CP.name, requestedAt:now() },
          history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion requested — pending manager approval' }]
        });
        closeModal(); toast('Deletion request sent to manager.','info'); renderPipelineTab();
      });
  });

  document.getElementById('lm-withdraw-del')?.addEventListener('click', async () => {
    await dbUpdate('leads', lead.id, {
      deleteRequest:null,
      history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion request withdrawn' }]
    });
    closeModal(); toast('Deletion request withdrawn.','info'); renderPipelineTab();
  });

  document.getElementById('lm-approve-del')?.addEventListener('click',()=>{
    confirmModal(`Approve deletion for ${esc(lead.company)}?`,
      'This cannot be undone.',
      async () => {
        await dbDelete('leads', lead.id);
        closeModal(); toast('Lead deleted.','info'); renderPipelineTab();
      });
  });

  document.getElementById('lm-reject-del')?.addEventListener('click', async () => {
    await dbUpdate('leads', lead.id, {
      deleteRequest:null,
      history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion request rejected' }]
    });
    closeModal(); toast('Deletion request rejected.','info'); renderPipelineTab();
  });
}

// ─── ADD LEAD MODAL ───
function showAddLeadModal(agents, byId){
  const role = CP.role;
  let selectedCompanyId = '';
  let fuzzyAcknowledged = false;
  let lastSearchResults = []; // ≤10 docs from the last searchCompanies() call — the ONLY set findFuzzyMatch operates on (ARCHITECTURE.md §9, no full-list scans)

  modal('Add New Lead', `
    <div class="row2">
      <div class="field">
        <label>Company Name *</label>
        <div class="ms-wrap" style="width:100%">
          <input type="text" id="nl-co" placeholder="Start typing to search or add new…" autocomplete="off" style="width:100%">
          <div class="ms-dd" id="nl-co-dd" style="width:100%"></div>
        </div>
      </div>
      <div class="field"><label>Contact Name</label><input type="text" id="nl-ct" placeholder="John Doe"></div>
    </div>
    <div id="nl-co-fuzzy" style="display:none" class="locked-note mb-12">
      ⚠ Did you mean <strong id="nl-co-fuzzy-name"></strong>?
      <div class="flex gap-8 mt-8">
        <button type="button" class="btn btn-ghost btn-xs" id="nl-co-use-existing">Use this company</button>
        <button type="button" class="btn btn-ghost btn-xs" id="nl-co-create-new">No, create new</button>
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>Account Code (optional)</label><input type="text" id="nl-acct" placeholder="e.g. ACC-10293"></div>
      <div></div>
    </div>
    <div id="nl-acct-match" style="display:none" class="locked-note mb-12">
      ✓ Account code already exists: <strong id="nl-acct-match-name"></strong>
      <div class="flex gap-8 mt-8">
        <button type="button" class="btn btn-ghost btn-xs" id="nl-acct-use-existing">Use this company</button>
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>Phone</label><input type="text" id="nl-ph" placeholder="+971 50 000 0000"></div>
      <div class="field"><label>Email</label><input type="email" id="nl-em" placeholder="contact@company.com"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Industry</label><input type="text" id="nl-ind" placeholder="e.g. Construction"></div>
      <div class="field"><label>City</label><input type="text" id="nl-cy" placeholder="Dubai"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Stage</label>
        <select id="nl-st">${STAGES.map(s=>`<option>${s}</option>`).join('')}</select>
      </div>
      ${role!=='agent' ? `<div class="field"><label>Assign To</label>
        <select id="nl-ag">
          ${role==='manager' ? `<option value="${CU.uid}">— Me (Manager) —</option>` : ''}
          ${agents.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}
          ${role==='team_lead'&&!agents.length ? `<option value="">No agents in your sub-group</option>` : ''}
        </select>
      </div>` : ''}
    </div>
    <p id="nl-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="nl-btn">Add Lead</button>`);

  fixSelectScrollClip('nl-st');

  // Company search dropdown — same visual/behavior pattern as the existing
  // multi-select filters (.ms-wrap/.ms-dd), so the global click-outside-closes
  // handler in helpers.js already applies with no extra wiring. Type-ahead
  // (ARCHITECTURE.md §9): debounced, min 2 chars, server-side searchCompanies()
  // — never a full-collection fetch, regardless of how many companies exist.
  const coInput = document.getElementById('nl-co');
  const coDd    = document.getElementById('nl-co-dd');
  const fuzzyBox = document.getElementById('nl-co-fuzzy');
  const acctInput = document.getElementById('nl-acct');
  const acctMatchBox = document.getElementById('nl-acct-match');
  let coSearchDebounce;
  coInput.addEventListener('input', () => {
    selectedCompanyId = ''; fuzzyAcknowledged = false;
    fuzzyBox.style.display = 'none';
    clearTimeout(coSearchDebounce);
    const q = coInput.value.trim();
    if(q.length < 2){ coDd.classList.remove('open'); coDd.innerHTML=''; lastSearchResults=[]; return; }
    coSearchDebounce = setTimeout(async () => {
      const matches = await searchCompanies(q);
      lastSearchResults = matches;
      if(!matches.length){ coDd.classList.remove('open'); coDd.innerHTML=''; return; }
      coDd.innerHTML = matches.map(c=>`<div class="ms-item" data-cid="${c.id}">${esc(c.name)}${c.industry?` <span class="text-dim text-xs">· ${esc(c.industry)}</span>`:''}</div>`).join('');
      coDd.classList.add('open');
    }, 300);
  });
  coDd.addEventListener('click', e => {
    const item = e.target.closest('[data-cid]'); if(!item) return;
    const c = lastSearchResults.find(x=>x.id===item.dataset.cid); if(!c) return;
    coInput.value = c.name; selectedCompanyId = c.id;
    acctInput.value = c.accountCode || '';
    coDd.classList.remove('open'); coDd.innerHTML='';
    fuzzyBox.style.display = 'none';
    acctMatchBox.style.display = 'none';
  });

  // accountCode exact-match nudge — a stronger dedup signal than name, so this
  // surfaces independently of the name-based fuzzy-match box above. Debounced
  // targeted lookup, not a client-side scan.
  let acctSearchDebounce;
  acctInput.addEventListener('input', () => {
    clearTimeout(acctSearchDebounce);
    const code = acctInput.value.trim();
    if(!code){ acctMatchBox.style.display = 'none'; return; }
    acctSearchDebounce = setTimeout(async () => {
      const match = await findCompanyByAccountCode(code);
      if(match){
        document.getElementById('nl-acct-match-name').textContent = match.name;
        acctMatchBox.style.display = '';
        document.getElementById('nl-acct-use-existing').onclick = () => {
          coInput.value = match.name; selectedCompanyId = match.id;
          acctMatchBox.style.display = 'none';
          fuzzyBox.style.display = 'none';
        };
      } else {
        acctMatchBox.style.display = 'none';
      }
    }, 300);
  });

  document.getElementById('nl-btn').onclick = async () => {
    const co = v('nl-co');
    const err = document.getElementById('nl-err');
    if(!co){ err.textContent='Company name is required.'; return; }
    const assignTo = role==='agent' ? CU.uid : (v('nl-ag')||'');
    if(role==='team_lead' && !assignTo){ err.textContent='No agents in your sub-group yet. Ask your manager to assign agents first.'; return; }

    // Resolve companyId: explicit picker selection wins; then an exact match
    // WITHIN the already-fetched ≤10 type-ahead results (no extra query);
    // otherwise nudge with a fuzzy "did you mean" from that same small set
    // before creating genuinely new. findOrCreateCompany() below does its own
    // targeted accountCode-then-normalizedName server lookup as the final
    // safety net (e.g. if the user typed faster than the debounce, or under
    // 2 chars), so nothing here needs to re-check the server itself.
    const acctCode = v('nl-acct');
    let companyId = selectedCompanyId;
    if(!companyId){
      const norm = normalizeCompanyName(co);
      const exact = lastSearchResults.find(c => c.normalizedName === norm);
      if(exact){ companyId = exact.id; }
      else if(!fuzzyAcknowledged){
        const fuzzy = findFuzzyMatch(co, lastSearchResults);
        if(fuzzy){
          document.getElementById('nl-co-fuzzy-name').textContent = fuzzy.name;
          fuzzyBox.style.display = '';
          document.getElementById('nl-co-use-existing').onclick = () => {
            coInput.value = fuzzy.name; selectedCompanyId = fuzzy.id;
            fuzzyBox.style.display = 'none';
          };
          document.getElementById('nl-co-create-new').onclick = () => {
            fuzzyAcknowledged = true;
            fuzzyBox.style.display = 'none';
          };
          return;
        }
      }
    }

    disable('nl-btn','Adding…');
    try {
      if(!companyId){
        companyId = await findOrCreateCompany(co, {industry:v('nl-ind'), city:v('nl-cy'), accountCode:acctCode});
      }
      // Resolve teamId/tlId from the assignee's OWN profile (step 0e-c root
      // cause fix). The old check here was `assignTo !== CU.uid`, meaning
      // "skip resolution when self-assigning" — intended for a MANAGER
      // self-assigning (managers aren't on a team), but it fired for ANY
      // self-assignment, including the single most common lead-creation
      // path there is: an agent creating and self-assigning their own lead.
      // That silently left every self-created agent lead with a permanently
      // blank teamId/tlId even though the agent's own profile (already
      // loaded as CP) had one all along — no extra read needed for that case.
      let leadTeamId = '', leadTlId = '';
      if(assignTo === CU.uid && role !== 'manager'){
        leadTeamId = CP.teamId || ''; leadTlId = CP.tlId || '';
      } else if(assignTo && assignTo !== CU.uid){
        const aSnap = await getDoc(doc(db,'users',assignTo));
        if(aSnap.exists()){ leadTeamId = aSnap.data().teamId||''; leadTlId = aSnap.data().tlId||''; }
      }
      await dbAdd('leads', {
        company:co, companyId, contact:v('nl-ct'), phone:v('nl-ph'), email:v('nl-em'),
        industry:v('nl-ind'), city:v('nl-cy'), stage:v('nl-st')||'New',
        assignedTo:assignTo, assignedBy:CU.uid,
        teamId:leadTeamId, tlId:leadTlId,
        createdByRole:CP.role,
        ownerLocked: CP.role==='manager',
        dealValue:0, notes:'', followup:'',
        history:[{ ts:now(), actorId:CU.uid, actorName:CP.name, change:'Lead created' }]
      });
      closeModal(); toast('Lead added.'); renderPipelineTab();
    } catch(e){ err.textContent=e.message; enable('nl-btn','Add Lead'); }
  };
}

// ─── SUBMIT TO BACKEND MODAL ───
// Agent-side handoff from a Closed lead (ARCHITECTURE.md §3/§5). Composes
// one or more product lines into ONE bundle — each line becomes its own
// submission doc (js/submissions.js createSubmissions), sharing a bundleId.
// No file upload this session (StorageAdapter is next session) — the
// documents section here is a checklist + expiry-date attestation only.
const CATEGORY_FIELD_LABELS = { gaid:'GAID', msisdn:'MSISDN', simSerial:'SIM Serial', passcode:'Passcode', commitmentPlan:'Commitment Plan', handset:'Handset' };

async function showSubmitModal(lead, byId){
  const [prodSnap, teamSnap, companySnap] = await Promise.all([
    getDocs(query(collection(db,'products'), where('active','==',true))),
    getDocs(collection(db,'teams')),
    getDoc(doc(db,'companies', lead.companyId))
  ]);
  const products     = prodSnap.docs.map(d=>({id:d.id,...d.data()}));
  const productsById = {}; products.forEach(p=>productsById[p.id]=p);
  const teams        = teamSnap.docs.map(d=>({id:d.id,...d.data()}));
  const company      = companySnap.exists() ? {id:companySnap.id,...companySnap.data()} : null;
  const users        = Object.values(byId);
  const expiryWarnings = docExpiryWarnings(company);

  let items = [];
  let docExpiryDates = {}; // { [docType]: 'YYYY-MM-DD' }
  // { [docType]: {fileName, pages, truncated, totalPages, thumbUrl} | {error} }
  // — a doc WITH an attached file (pages.length truthy) gets requiredDocs
  // status 'uploaded' at submit; without one it stays 'attested' (files are
  // encouraged, not blocking — ARCHITECTURE.md §6 — backend rejects at
  // verification time if one's genuinely missing).
  let docFiles = {};
  let accTransferFlag = false;
  let accTransferFromPartner = ''; // same re-render survival issue as selectedProductId below — persisted here, not read from the DOM after the fact
  // Persisted across render() calls — render() fully replaces the modal's
  // innerHTML (including <select id="sm-prod">), so reading the DOM's
  // .value AFTER a re-render would see a freshly-created, unselected
  // element, not whatever the user actually picked.
  let selectedProductId = '';

  function requiredDocs(){ return computeRequiredDocs(items, productsById); }
  function missingDocs(){ return requiredDocs().filter(rd => !docExpiryDates[rd]); }
  function catFieldsHtml(fields){
    return fields.length ? `<div class="row2 mt-8">
      ${fields.map(f=>`<input type="text" id="sm-cf-${f}" placeholder="${CATEGORY_FIELD_LABELS[f]||f} (optional)">`).join('')}
    </div>` : '';
  }
  // Doc type names ("Emirates ID (Front)") contain spaces/parens — not safe
  // to use directly as an HTML id — so DOM element ids use this slug, while
  // the readable docType string itself lives in a data- attribute.
  function slug(s){ return s.replace(/[^a-zA-Z0-9]/g,'_'); }
  function docFilePreviewHtml(entry){
    if(!entry) return '<span class="text-dim text-xs">No file attached (optional)</span>';
    if(entry.error) return `<span class="err text-xs">${esc(entry.error)}</span>`;
    const thumb = entry.thumbUrl ? `<img src="${entry.thumbUrl}" style="height:36px;border-radius:4px;vertical-align:middle;margin-right:8px">` : '';
    return `${thumb}<span class="text-xs">${esc(entry.fileName)} — ${entry.pages.length} page${entry.pages.length!==1?'s':''}${entry.truncated?` (capped at ${PDF_PAGE_CAP} — PDF has ${entry.totalPages})`:''}</span>`;
  }
  // Shared between render() (so a re-render triggered by something OTHER
  // than the product picker, e.g. removing an item, doesn't silently lose
  // the term dropdown's populated options for a still-selected product) and
  // the sm-prod onchange handler itself.
  function populateTermSelect(p){
    const termSel = document.getElementById('sm-term');
    if(!p){ termSel.innerHTML = '<option value="">— Select product first —</option>'; termSel.disabled = true; return; }
    termSel.disabled = false;
    termSel.innerHTML = (p.pricingOptions||[]).map((po,i)=>`<option value="${i}">${esc(po.label)} (AED ${po.price})</option>`).join('');
    termSel.onchange = () => {
      const po = p.pricingOptions[Number(termSel.value)];
      document.getElementById('sm-mrc').value = po ? po.price : '';
    };
    termSel.dispatchEvent(new Event('change'));
  }

  function render(){
    const req      = requiredDocs();
    const missing  = missingDocs();
    const canGo    = items.length>0 && missing.length===0;
    const selectedProduct = productsById[selectedProductId] || null;
    const catFields = selectedProduct ? (ORG_DEFAULTS.itemFieldsByCategory[selectedProduct.category]||[]) : [];

    modal(`Submit to Backend — ${esc(lead.company)}`, `
      <div class="flex mb-12" style="justify-content:flex-end">
        <button type="button" class="btn btn-ghost btn-xs" id="sm-submit-later">Submit later</button>
      </div>
      ${expiryWarnings.length ? `<div class="locked-note" style="background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3);color:var(--amber)">
        ⚠ ${expiryWarnings.map(w=>`${w.isEstablishmentCard?'<strong>Establishment Card</strong> (SIM-suspension risk)':esc(w.label)} expires ${fmtDate(w.date)}`).join('; ')}
      </div>` : ''}
      <div class="field">
        <label>Add Product</label>
        <div class="row2">
          <select id="sm-prod"><option value="">— Select product —</option>
            ${products.map(p=>`<option value="${p.id}"${p.id===selectedProductId?' selected':''}>${esc(p.category)} — ${esc(p.name)}</option>`).join('')}
          </select>
          <select id="sm-term" ${selectedProduct?'':'disabled'}><option value="">${selectedProduct?'— Select term —':'— Select product first —'}</option></select>
        </div>
        <div class="row2 mt-8">
          <input type="number" id="sm-mrc" placeholder="MRC (AED/mo)">
          <input type="number" id="sm-qty" placeholder="Qty" value="1" min="1">
        </div>
        <div class="row2 mt-8">
          <select id="sm-tor">${ORG_DEFAULTS.typeOfRequestList.map(t=>`<option value="${t}">${t}</option>`).join('')}</select>
          <div></div>
        </div>
        <div id="sm-catfields">${catFieldsHtml(catFields)}</div>
        <div class="mt-8" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="sm-spr" style="width:auto;margin:0;cursor:pointer">
          <label for="sm-spr" style="margin:0;cursor:pointer">Special Pricing Request (SPR)</label>
        </div>
        <input type="text" id="sm-spr-note" placeholder="SPR note" class="mt-8" style="display:none">
        <button type="button" class="btn btn-ghost mt-8" id="sm-add-item">+ Add Item</button>
      </div>
      <div id="sm-items" class="mt-12">
        ${items.length ? items.map(it=>`<div class="pr-sub-row flex" style="justify-content:space-between;align-items:center">
          <div><strong>${esc(it.productName)}</strong> <span class="text-dim text-xs">${esc(it.category)} · Qty ${it.qty} · ${esc(it.typeOfRequest)}${it.sprFlag?' · SPR':''}</span></div>
          <div class="flex gap-8">
            <span class="text-dim text-xs">AED ${Number(it.mrc).toLocaleString()}/mo</span>
            <button type="button" class="btn btn-danger btn-xs" data-rm-item="${it.itemId}">Remove</button>
          </div>
        </div>`).join('') : '<p class="text-dim text-xs">No products added yet.</p>'}
      </div>
      <div class="divider"></div>
      <div class="mt-8" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="sm-acctxfer" ${accTransferFlag?'checked':''} style="width:auto;margin:0;cursor:pointer">
        <label for="sm-acctxfer" style="margin:0;cursor:pointer">Account transfer from another partner</label>
      </div>
      <input type="text" id="sm-acctxfer-from" placeholder="Transferring from (partner name)" value="${esc(accTransferFromPartner)}" class="mt-8" style="display:${accTransferFlag?'':'none'}">
      <div class="divider"></div>
      <div class="field">
        <label>Documents ${req.length?`<span class="text-dim text-xs">(attest each with its expiry date; attaching a file is encouraged but not required)</span>`:''}</label>
        ${req.map(rd=>`<div class="row2 mt-8" style="align-items:center">
          <span class="text-xs">${esc(rd)}</span>
          <input type="date" data-doc-expiry="${esc(rd)}" value="${docExpiryDates[rd]||''}">
        </div>
        <div class="row2 mt-8" style="align-items:center">
          <input type="file" accept="image/*,application/pdf" data-doc-file="${esc(rd)}">
          <div id="sm-docfile-preview-${slug(rd)}">${docFilePreviewHtml(docFiles[rd])}</div>
        </div>`).join('')}
      </div>
      ${missing.length ? `<p class="err mt-8">Missing expiry date for: ${missing.join(', ')}</p>` : ''}
      ${!items.length ? `<p class="err mt-8">Add at least one product.</p>` : ''}
      <p id="sm-err" class="err"></p>
      <button class="btn btn-primary btn-full mt-12" id="sm-submit-btn" ${canGo?'':'disabled'}>Submit</button>`, true);

    // Populate sm-term for a product selected before this render (e.g. a
    // re-render triggered by removing an item, not by changing the product
    // picker itself) — the template only renders sm-term as an empty
    // placeholder; actual options are always JS-populated.
    if(selectedProduct) populateTermSelect(selectedProduct);

    document.getElementById('sm-submit-later').onclick = () => {
      closeModal(); toast('Lead saved. You can submit to backend anytime from this lead.');
    };

    document.getElementById('sm-prod').onchange = function(){
      selectedProductId = this.value;
      const p = productsById[selectedProductId];
      // Targeted DOM patch, NOT a full render() — render() would recreate
      // sm-term as a fresh element with no options, wiping out what
      // populateTermSelect() is about to set.
      document.getElementById('sm-catfields').innerHTML = catFieldsHtml(p ? (ORG_DEFAULTS.itemFieldsByCategory[p.category]||[]) : []);
      populateTermSelect(p);
    };

    document.getElementById('sm-spr').onchange = function(){
      document.getElementById('sm-spr-note').style.display = this.checked ? '' : 'none';
    };
    document.getElementById('sm-acctxfer').onchange = function(){
      accTransferFlag = this.checked;
      document.getElementById('sm-acctxfer-from').style.display = this.checked ? '' : 'none';
    };
    document.getElementById('sm-acctxfer-from').oninput = function(){
      accTransferFromPartner = this.value;
    };

    document.getElementById('sm-add-item').onclick = () => {
      const p   = productsById[selectedProductId];
      const err = document.getElementById('sm-err');
      if(!p){ err.textContent='Select a product first.'; return; }
      const po = p.pricingOptions[Number(document.getElementById('sm-term').value)];
      const mrc = v('sm-mrc');
      if(!mrc){ err.textContent='MRC is required.'; return; }
      const categoryFields = {};
      (ORG_DEFAULTS.itemFieldsByCategory[p.category]||[]).forEach(f => {
        const val = v(`sm-cf-${f}`);
        if(val) categoryFields[f] = val;
      });
      items.push({
        itemId: `it_${Date.now()}_${items.length}`,
        productId: p.id, productName: p.name, category: p.category,
        contractTerm: po ? po.term : null, mrc: Number(mrc), qty: Number(v('sm-qty'))||1,
        typeOfRequest: v('sm-tor')||'NEW', categoryFields,
        sprFlag: document.getElementById('sm-spr').checked, sprNote: v('sm-spr-note')||''
      });
      selectedProductId = ''; // clear the mini-form for the next line
      render();
    };

    document.querySelectorAll('[data-rm-item]').forEach(b => b.onclick = () => {
      items = items.filter(it => it.itemId !== b.dataset.rmItem);
      render();
    });

    document.querySelectorAll('[data-doc-expiry]').forEach(inp => inp.onchange = function(){
      docExpiryDates[this.dataset.docExpiry] = this.value;
      render();
    });

    // Targeted preview-area update, NOT a full render() — processing runs
    // async (canvas/pdf.js work) and touches nothing else the rest of the
    // form depends on.
    document.querySelectorAll('[data-doc-file]').forEach(input => input.onchange = async function(){
      const docType = this.dataset.docFile;
      const file = this.files[0];
      if(!file) return;
      const previewEl = document.getElementById(`sm-docfile-preview-${slug(docType)}`);
      previewEl.innerHTML = '<span class="text-dim text-xs">Processing…</span>';
      try {
        const result = await captureFile(file);
        const thumbUrl = URL.createObjectURL(result.pages[0].blob);
        docFiles[docType] = { fileName: file.name, pages: result.pages, truncated: result.truncated, totalPages: result.totalPages, thumbUrl };
      } catch(e){
        docFiles[docType] = { error: e.message };
      }
      previewEl.innerHTML = docFilePreviewHtml(docFiles[docType]);
    });

    document.getElementById('sm-submit-btn').onclick = async () => {
      if(!canGo) return;
      disable('sm-submit-btn','Submitting…');
      const bundleId = generateBundleId();
      const docTypesWithFiles = req.filter(type => docFiles[type]?.pages?.length);
      // "Safely fits" heuristic (ARCHITECTURE.md §6's own framing, "3-4 docs
      // x <=400KB"): combine pages + submissions into ONE atomic writeBatch.
      // Otherwise, pages are written first (their own committed batches),
      // submissions after — if THAT second phase fails, the already-written
      // pages are cleaned up rather than left orphaned.
      const totalBytes = docTypesWithFiles.reduce((s,t)=>s+docFiles[t].pages.reduce((s2,p)=>s2+p.bytes,0),0);
      const totalPageCount = docTypesWithFiles.reduce((s,t)=>s+docFiles[t].pages.length,0);
      const safelyFits = docTypesWithFiles.length<=4 && totalBytes<=4*400*1024 && totalPageCount<=20;
      const combinedBat = (safelyFits && docTypesWithFiles.length) ? newBatch() : null;

      try {
        const storageRefsByType = {};
        for(const type of docTypesWithFiles){
          const refs = await storage.put({
            bundleId, docType: type, pages: docFiles[type].pages,
            agentId: CU.uid, teamId: lead.teamId||'', externalBat: combinedBat||undefined
          });
          storageRefsByType[type] = { bundleId, docType: type, pageCount: refs.length };
        }

        const requiredDocsPayload = req.map(type => ({
          type, expiryDate: docExpiryDates[type]||null,
          status: storageRefsByType[type] ? 'uploaded' : 'attested',
          storageRef: storageRefsByType[type] || null
        }));
        const accTransfer = accTransferFlag ? { flag:true, fromPartner: accTransferFromPartner.trim() } : null;

        try {
          await createSubmissions({ lead, company, items, requiredDocs: requiredDocsPayload, accTransfer, teams, users, bundleId, externalBat: combinedBat||undefined });
          if(combinedBat) await combinedBat.commit();
        } catch(subErr){
          if(!combinedBat && docTypesWithFiles.length){
            await storage.deleteByBundle(bundleId).catch(()=>{});
          }
          throw subErr;
        }

        closeModal(); toast('Submitted to backend.'); renderPipelineTab();
      } catch(e){
        document.getElementById('sm-err').textContent = e.message;
        enable('sm-submit-btn','Submit');
      }
    };
  }

  render();
}

// ─── SUBMISSION TIMELINE (read-only) ───
// Visible to the submitting agent, their TL, and manager (showLeadModal's
// canViewTimeline gate) — backend's own queue/action UI is a later session.
// Groups the lead's submissions by bundleId; each line shows its own status
// and full events[] timeline underneath.
// Doc-viewing is entirely on-demand, single-page get()s — NOT a list query
// against submissionDocs, so the f0c34bd LIST-query rule-provability issue
// doesn't apply here (Firestore evaluates a single getDoc()'s read rule
// against that exact document correctly, for every role, unlike a
// collection query). Access is still fully governed by the submissionDocs
// read rule (mirrors the submissions read rule) — a role that couldn't
// already see this timeline can't fetch these pages either, since the rule
// is checked independently on every single get().
function showSubmissionTimelineModal(lead, submissions){
  const bundles = {};
  submissions.forEach(s => { (bundles[s.bundleId] ||= []).push(s); });

  const html = Object.entries(bundles).map(([bundleId, lines]) => {
    const submittedAt = lines.reduce((earliest,l) => !earliest || l.createdAt < earliest ? l.createdAt : earliest, null);
    return `<div class="pr-sub-row mb-12">
      <div style="font-weight:600;font-size:13px">📦 Bundle — ${fmtDate(submittedAt)} · ${lines.length} item${lines.length!==1?'s':''}</div>
      ${lines.map(l => `
        <div class="mt-8" style="padding-left:12px;border-left:2px solid var(--border2)">
          <div class="flex gap-8" style="justify-content:space-between;align-items:center">
            <strong style="font-size:13px">${esc(l.productName)}</strong>
            <span class="text-xs" style="color:${SUBMISSION_STATUS_COLORS[l.status]||'var(--t2)'}">${SUBMISSION_STATUS_LABELS[l.status]||l.status}</span>
          </div>
          <div class="text-dim text-xs mt-4">${esc(l.category)} · Qty ${l.qty} · AED ${Number(l.mrc).toLocaleString()}/mo</div>
          ${(l.requiredDocs||[]).length ? `<div class="mt-8">
            ${l.requiredDocs.map(rd => `<div class="text-xs mt-4" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span>${esc(rd.type)}</span>
              <span class="text-dim">${rd.status==='uploaded'?'📎 uploaded':'attested'}${rd.expiryDate?` · expires ${fmtDate(rd.expiryDate)}`:''}</span>
              ${rd.storageRef ? `<button type="button" class="btn btn-ghost btn-xs" data-view-doc="${l.id}|${esc(rd.type)}">View (${rd.storageRef.pageCount} page${rd.storageRef.pageCount!==1?'s':''})</button>` : ''}
            </div>
            <div id="tl-docpages-${l.id}-${slugForTimeline(rd.type)}" class="mt-4"></div>`).join('')}
          </div>` : ''}
          <div class="mt-8">
            ${(l.events||[]).map(e => `<div class="text-xs text-dim">• ${fmtDate(e.ts)} — <strong>${esc(e.actorName)}</strong>: ${esc(EVENT_LABELS[e.type]||e.type)}${e.payload?.note?` — ${esc(e.payload.note)}`:''}${e.payload?.reason?` (${esc(e.payload.reason)})`:''}${e.payload?.value?` — ${esc(e.payload.value)}`:''}</div>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>`;
  }).join('') || '<p class="text-dim text-sm">No submissions yet.</p>';

  modal(`Submission Timeline — ${esc(lead.company)}`, html, true);

  // Fetch pages ON DEMAND (not eagerly for every doc when the modal opens) —
  // one storage.get() per page, exactly as many reads as pages actually
  // viewed.
  document.querySelectorAll('[data-view-doc]').forEach(btn => btn.onclick = async () => {
    const [subId, docType] = btn.dataset.viewDoc.split('|');
    const line = submissions.find(s => s.id === subId);
    const rd = line?.requiredDocs.find(r => r.type === docType);
    if(!rd?.storageRef) return;
    const target = document.getElementById(`tl-docpages-${subId}-${slugForTimeline(docType)}`);
    target.innerHTML = '<span class="text-dim text-xs">Loading…</span>';
    try {
      const pages = await Promise.all(
        Array.from({length: rd.storageRef.pageCount}, (_,i) =>
          storage.get({ bundleId: rd.storageRef.bundleId, docType: rd.storageRef.docType, pageIndex: i }))
      );
      target.innerHTML = pages.map((p,i) => p ? `<img src="${p.dataURL}" style="max-width:200px;border-radius:6px;margin:4px" alt="${esc(docType)} page ${i+1}">` : '').join('');
    } catch(e){
      target.innerHTML = `<span class="err text-xs">${esc(e.message)}</span>`;
    }
  });
}
function slugForTimeline(s){ return s.replace(/[^a-zA-Z0-9]/g,'_'); }
