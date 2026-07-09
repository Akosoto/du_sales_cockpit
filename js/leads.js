import {
  db, CU, CP, STAGES, MANDATORY_DOC_TYPES,
  doc, getDoc,
  collection, query, where, getDocs,
  orderBy, limit, startAfter, getCountFromServer
} from './state.js';
import { dbAdd, dbUpdate, dbDelete, newBatch, batchUpdate } from './db.js';
import { v, esc, now, fmtDate, disable, enable, toast, modal, closeModal, confirmModal, stagePill, buildMsFilter, wireMsFilter } from './helpers.js';
import { fetchCompanies, findOrCreateCompany, findFuzzyMatch, normalizeCompanyName } from './companies.js';
import { computeRequiredDocs, createSubmission } from './submissions.js';

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

  // Load companies once for the Add Lead picker — fetched here (not inside
  // the modal) so opening Add Lead is instant, matching the existing
  // agents/byId pattern already used for this tab.
  const companies = await fetchCompanies();

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
        const CHUNK = 400;
        for(let i=0;i<ids.length;i+=CHUNK){
          const bat = newBatch();
          ids.slice(i,i+CHUNK).forEach(id=>{
            const lead = visibleLeads.find(l=>l.id===id); if(!lead) return;
            batchUpdate(bat, 'leads', id, {
              assignedTo: targetId,
              teamId: target.teamId||'', tlId: target.tlId||'',
              history: [...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:`Assigned: ${byId[lead.assignedTo]?.name||'—'} → ${target.name} (bulk)` }]
            });
          });
          await bat.commit();
        }
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
          <td>${stagePill(l.stage)}</td>
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
  document.getElementById('btn-add-lead').addEventListener('click',()=>showAddLeadModal(agents, byId, companies));
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
  // company (companyId is required for submissions.hasDuAccount lookup).
  // Only fetched for Closed leads to avoid an extra read on every lead open.
  // Wrapped defensively: a rules/network hiccup on this lookup must never
  // block the rest of the (unrelated) lead modal from opening.
  let existingSubmission = null;
  const canSubmit = lead.stage==='Closed' && lead.companyId && (role==='manager' || lead.assignedTo===CU.uid);
  if(lead.stage==='Closed' && lead.companyId){
    try {
      const subSnap = await getDocs(query(collection(db,'submissions'), where('leadId','==',lead.id)));
      if(!subSnap.empty) existingSubmission = {id:subSnap.docs[0].id, ...subSnap.docs[0].data()};
    } catch(e){ /* submissions rule may not be published yet — degrade gracefully */ }
  }

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
    ${existingSubmission ? `<div class="locked-note" style="background:rgba(124,58,237,.1);border-color:rgba(124,58,237,.3);color:var(--purple2)">📤 Submitted to backend on ${fmtDate(existingSubmission.submittedAt)} — ${existingSubmission.items.length} item${existingSubmission.items.length!==1?'s':''}.</div>` : ''}
    ${canSubmit && !existingSubmission ? `<button class="btn btn-primary btn-full mt-12" id="lm-submit">📤 Submit to Backend</button>` : ''}
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
      closeModal(); toast('Lead saved.'); renderPipelineTab();
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
function showAddLeadModal(agents, byId, companies){
  const role = CP.role;
  let selectedCompanyId = '';
  let fuzzyAcknowledged = false;

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
      <div class="field"><label>Phone</label><input type="text" id="nl-ph" placeholder="+971 50 000 0000"></div>
      <div class="field"><label>Email</label><input type="email" id="nl-em" placeholder="contact@company.com"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Industry</label><input type="text" id="nl-ind" placeholder="e.g. Construction"></div>
      <div class="field"><label>City</label><input type="text" id="nl-cy" placeholder="Dubai"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Stage</label>
        <select id="nl-st">${STAGES.filter(s=>s!=='Closed'&&s!=='Lost').map(s=>`<option>${s}</option>`).join('')}</select>
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

  // Company search dropdown — same visual/behavior pattern as the existing
  // multi-select filters (.ms-wrap/.ms-dd), so the global click-outside-closes
  // handler in helpers.js already applies with no extra wiring.
  const coInput = document.getElementById('nl-co');
  const coDd    = document.getElementById('nl-co-dd');
  const fuzzyBox = document.getElementById('nl-co-fuzzy');
  coInput.addEventListener('input', () => {
    selectedCompanyId = ''; fuzzyAcknowledged = false;
    fuzzyBox.style.display = 'none';
    const q = coInput.value.trim().toLowerCase();
    if(!q){ coDd.classList.remove('open'); coDd.innerHTML=''; return; }
    const matches = companies.filter(c => c.name.toLowerCase().includes(q)).slice(0,8);
    if(!matches.length){ coDd.classList.remove('open'); coDd.innerHTML=''; return; }
    coDd.innerHTML = matches.map(c=>`<div class="ms-item" data-cid="${c.id}">${esc(c.name)}${c.industry?` <span class="text-dim text-xs">· ${esc(c.industry)}</span>`:''}</div>`).join('');
    coDd.classList.add('open');
  });
  coDd.addEventListener('click', e => {
    const item = e.target.closest('[data-cid]'); if(!item) return;
    const c = companies.find(x=>x.id===item.dataset.cid); if(!c) return;
    coInput.value = c.name; selectedCompanyId = c.id;
    coDd.classList.remove('open'); coDd.innerHTML='';
    fuzzyBox.style.display = 'none';
  });

  document.getElementById('nl-btn').onclick = async () => {
    const co = v('nl-co');
    const err = document.getElementById('nl-err');
    if(!co){ err.textContent='Company name is required.'; return; }
    const assignTo = role==='agent' ? CU.uid : (v('nl-ag')||'');
    if(role==='team_lead' && !assignTo){ err.textContent='No agents in your sub-group yet. Ask your manager to assign agents first.'; return; }

    // Resolve companyId: explicit picker selection wins; otherwise check for an
    // exact normalizedName match (typed the existing name without clicking it);
    // otherwise nudge with a fuzzy "did you mean" before creating genuinely new.
    let companyId = selectedCompanyId;
    if(!companyId){
      const norm = normalizeCompanyName(co);
      const exact = companies.find(c => c.normalizedName === norm);
      if(exact){ companyId = exact.id; }
      else if(!fuzzyAcknowledged){
        const fuzzy = findFuzzyMatch(co, companies);
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
        companyId = await findOrCreateCompany(co, {industry:v('nl-ind'), city:v('nl-cy')}, companies);
      }
      // Resolve teamId from assignee's user doc (skip for manager self-assign)
      let leadTeamId = '', leadTlId = '';
      if(assignTo && assignTo !== CU.uid){
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
// Agent-side handoff from a Closed lead (Phase 7). Bundles one or more
// products into line items and gates submission on the mandatory documents
// (js/state.js MANDATORY_DOC_TYPES + any per-product extras) being uploaded.
async function showSubmitModal(lead, byId){
  const [prodSnap, teamSnap, companySnap] = await Promise.all([
    getDocs(query(collection(db,'products'), where('active','==',true))),
    getDocs(collection(db,'teams')),
    getDoc(doc(db,'companies', lead.companyId))
  ]);
  const products     = prodSnap.docs.map(d=>({id:d.id,...d.data()}));
  const productsById = {}; products.forEach(p=>productsById[p.id]=p);
  const teams        = teamSnap.docs.map(d=>({id:d.id,...d.data()}));
  const company       = companySnap.exists() ? {id:companySnap.id,...companySnap.data()} : null;
  const users        = Object.values(byId);

  let items = [];
  let pendingFiles = []; // { file, docType }

  function requiredDocs(){ return computeRequiredDocs(items, productsById); }
  function missingDocs(){ const req = requiredDocs(); return req.filter(rd => !pendingFiles.some(f=>f.docType===rd)); }

  function render(){
    const req      = requiredDocs();
    const missing  = missingDocs();
    const canGo    = items.length>0 && missing.length===0;

    modal(`Submit to Backend — ${esc(lead.company)}`, `
      <div class="field">
        <label>Add Product</label>
        <div class="row2">
          <select id="sm-prod"><option value="">— Select product —</option>
            ${products.map(p=>`<option value="${p.id}">${esc(p.category)} — ${esc(p.name)}</option>`).join('')}
          </select>
          <select id="sm-term" disabled><option value="">— Select product first —</option></select>
        </div>
        <div class="row2 mt-8">
          <input type="number" id="sm-dv" placeholder="Deal value (AED)">
          <button type="button" class="btn btn-ghost" id="sm-add-item">+ Add Item</button>
        </div>
      </div>
      <div id="sm-items" class="mt-12">
        ${items.length ? items.map(it=>`<div class="pr-sub-row flex" style="justify-content:space-between;align-items:center">
          <div><strong>${esc(it.productName)}</strong> <span class="text-dim text-xs">${esc(it.category)} · ${esc(it.subType)}</span></div>
          <div class="flex gap-8">
            <span class="text-dim text-xs">AED ${Number(it.dealValue).toLocaleString()}</span>
            <button type="button" class="btn btn-danger btn-xs" data-rm-item="${it.itemId}">Remove</button>
          </div>
        </div>`).join('') : '<p class="text-dim text-xs">No products added yet.</p>'}
      </div>
      <div class="divider"></div>
      <div class="field">
        <label>Documents ${req.length?`<span class="text-dim text-xs">(required: ${req.join(', ')})</span>`:''}</label>
        <input type="file" id="sm-file-input" multiple accept="application/pdf,image/*">
      </div>
      <div id="sm-files" class="mt-8">
        ${pendingFiles.map((f,i)=>`<div class="flex gap-8 mt-8" style="align-items:center">
          <span class="text-xs" style="flex:1">${esc(f.file.name)}</span>
          <select data-file-doctype="${i}">
            ${req.map(rd=>`<option value="${esc(rd)}"${f.docType===rd?' selected':''}>${esc(rd)}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-danger btn-xs" data-rm-file="${i}">Remove</button>
        </div>`).join('')}
      </div>
      ${missing.length ? `<p class="err mt-8">Missing required document${missing.length!==1?'s':''}: ${missing.join(', ')}</p>` : ''}
      ${!items.length ? `<p class="err mt-8">Add at least one product.</p>` : ''}
      <p id="sm-err" class="err"></p>
      <button class="btn btn-primary btn-full mt-12" id="sm-submit-btn" ${canGo?'':'disabled'}>Submit</button>`, true);

    document.getElementById('sm-prod').onchange = function(){
      const p       = productsById[this.value];
      const termSel = document.getElementById('sm-term');
      if(!p){ termSel.innerHTML = '<option value="">— Select product first —</option>'; termSel.disabled = true; return; }
      termSel.disabled = false;
      termSel.innerHTML = (p.pricingOptions||[]).map((po,i)=>`<option value="${i}">${esc(po.label)} (AED ${po.price})</option>`).join('');
      termSel.onchange = () => {
        const po = p.pricingOptions[Number(termSel.value)];
        document.getElementById('sm-dv').value = po ? po.price : '';
      };
      termSel.dispatchEvent(new Event('change'));
    };

    document.getElementById('sm-add-item').onclick = () => {
      const p   = productsById[v('sm-prod')];
      const err = document.getElementById('sm-err');
      if(!p){ err.textContent='Select a product first.'; return; }
      const po = p.pricingOptions[Number(document.getElementById('sm-term').value)];
      const dv = v('sm-dv');
      if(!dv){ err.textContent='Deal value is required.'; return; }
      items.push({
        itemId: `it_${Date.now()}_${items.length}`,
        productId: p.id, productName: p.name, category: p.category,
        subType: po ? po.label : '', dealValue: Number(dv)
      });
      render();
    };

    document.querySelectorAll('[data-rm-item]').forEach(b => b.onclick = () => {
      items = items.filter(it => it.itemId !== b.dataset.rmItem);
      render();
    });

    document.getElementById('sm-file-input').onchange = function(){
      [...this.files].forEach(file => pendingFiles.push({ file, docType: req[0]||'' }));
      render();
    };

    document.querySelectorAll('[data-file-doctype]').forEach(sel => sel.onchange = function(){
      pendingFiles[Number(this.dataset.fileDoctype)].docType = this.value;
      render();
    });

    document.querySelectorAll('[data-rm-file]').forEach(b => b.onclick = () => {
      pendingFiles.splice(Number(b.dataset.rmFile), 1);
      render();
    });

    document.getElementById('sm-submit-btn').onclick = async () => {
      if(!canGo) return;
      disable('sm-submit-btn','Submitting…');
      try {
        await createSubmission({ lead, company, items, files: pendingFiles, requiredDocs: req, teams, users });
        closeModal(); toast('Submitted to backend.'); renderPipelineTab();
      } catch(e){
        document.getElementById('sm-err').textContent = e.message;
        enable('sm-submit-btn','Submit');
      }
    };
  }

  render();
}
