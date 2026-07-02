import {
  db, CU, CP, STAGES,
  doc, getDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, writeBatch
} from './state.js';
import { v, esc, now, fmtDate, disable, enable, toast, modal, closeModal, confirmModal, stagePill, buildMsFilter, wireMsFilter } from './helpers.js';

// ════════════════════════════════════════════════════
// PIPELINE TAB
// ════════════════════════════════════════════════════
export async function renderPipelineTab(){
  const ct   = document.getElementById('content');
  const role = CP.role;

  // Load users
  const uSnap  = await getDocs(collection(db,'users'));
  const byId   = {}; uSnap.docs.forEach(d=>byId[d.id]={id:d.id,...d.data()});

  // Load leads scoped by role
  let leads = [];
  if(role==='manager'){
    leads = (await getDocs(collection(db,'leads'))).docs.map(d=>({id:d.id,...d.data()}));
  } else if(role==='team_lead'){
    if(!CP.teamId){ ct.innerHTML=`<div class="empty mt-16"><div class="empty-icon">👥</div><div class="empty-title">Not assigned to a team</div><div class="empty-sub">Contact your manager.</div></div>`; return; }
    const agSnap = await getDocs(query(collection(db,'users'),where('teamId','==',CP.teamId),where('role','==','agent')));
    const agIds  = agSnap.docs.map(d=>d.id);
    if(agIds.length>0){
      leads = (await getDocs(query(collection(db,'leads'),where('assignedTo','in',agIds)))).docs.map(d=>({id:d.id,...d.data()}));
    }
  } else {
    leads = (await getDocs(query(collection(db,'leads'),where('assignedTo','==',CU.uid)))).docs.map(d=>({id:d.id,...d.data()}));
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

  let stageF='', searchF='';
  let teamFs=[], tlFs=[], agentFs=[];
  const selected = new Set();

  function filtered(){
    let r = leads;
    if(stageF)       r = r.filter(l=>l.stage===stageF);
    if(searchF){ const q=searchF.toLowerCase(); r=r.filter(l=>(l.company||'').toLowerCase().includes(q)||(l.contact||'').toLowerCase().includes(q)||(l.email||'').toLowerCase().includes(q)||(l.phone||'').includes(q)); }
    if(teamFs.length)  r = r.filter(l=>teamFs.includes(l.teamId));
    if(tlFs.length)    r = r.filter(l=>tlFs.includes(l.tlId));
    if(agentFs.length) r = r.filter(l=>agentFs.includes(l.assignedTo));
    return r;
  }

  const sCounts = {}; STAGES.forEach(s=>sCounts[s]=leads.filter(l=>l.stage===s).length);
  const pendingDeletes = role==='manager' ? leads.filter(l=>l.deleteRequest) : [];

  ct.innerHTML = `
    <div class="pg-hdr">
      <div>
        <h2>${role==='manager'?'All Leads':role==='team_lead'?'Team Pipeline':'My Leads'}</h2>
        <p class="pg-hdr-sub" id="lead-cnt">${leads.length} leads</p>
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
      <button class="filter-btn active" data-s="">All <span class="filter-count">${leads.length}</span></button>
      ${STAGES.map(s=>`<button class="filter-btn" data-s="${s}">${s} <span class="filter-count">${sCounts[s]}</span></button>`).join('')}
    </div>
    <div id="bulk-bar-wrap"></div>
    <div id="lead-list"></div>`;

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
          const bat = writeBatch(db);
          ids.slice(i,i+CHUNK).forEach(id=>{
            const lead = leads.find(l=>l.id===id); if(!lead) return;
            bat.update(doc(db,'leads',id), {
              assignedTo: targetId,
              teamId: target.teamId||'', tlId: target.tlId||'',
              lastEditedBy: CP.name, lastEditedAt: now(),
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

  function renderList(){
    const f = filtered();
    document.getElementById('lead-cnt').textContent = `${f.length} lead${f.length!==1?'s':''}`;
    const el = document.getElementById('lead-list');
    renderBulkBar();
    if(!f.length){ el.innerHTML=`<div class="empty"><div class="empty-icon">📋</div><div class="empty-title">No leads found</div><div class="empty-sub">Try adjusting your search or filter.</div></div>`; return; }
    const canBulk = role !== 'agent' && agents.length > 0;
    const eligible = canBulk ? f.filter(bulkEligible) : [];
    el.innerHTML = `<div class="tbl-wrap"><table>
      <thead><tr>${canBulk?`<th><input type="checkbox" id="chk-all" class="lead-chk"></th>`:''}<th>Company</th><th>Contact</th><th>Phone</th>${role!=='agent'?'<th>Agent</th>':''}
        <th>Stage</th><th>City</th><th>Follow-up</th><th>Updated</th><th></th></tr></thead>
      <tbody>
        ${f.map(l=>`<tr>
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
      const lead = leads.find(x=>x.id===b.dataset.lid);
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

  renderList();

  document.getElementById('srch').addEventListener('input', e=>{ searchF=e.target.value; selected.clear(); renderList(); });
  document.querySelectorAll('[data-s]').forEach(b=>b.addEventListener('click',()=>{
    stageF=b.dataset.s;
    document.querySelectorAll('[data-s]').forEach(x=>x.classList.toggle('active',x===b));
    selected.clear();
    renderList();
  }));
  document.getElementById('btn-add-lead').addEventListener('click',()=>showAddLeadModal(agents, byId));
  const clearSelAndRender = () => { selected.clear(); renderList(); };
  wireMsFilter('ms-tm', teamFs,  clearSelAndRender);
  wireMsFilter('ms-tl', tlFs,    clearSelAndRender);
  wireMsFilter('ms-ag', agentFs, clearSelAndRender);

  document.querySelectorAll('[data-approve-del]').forEach(b=>b.addEventListener('click',()=>{
    const l = leads.find(x=>x.id===b.dataset.approveDel); if(!l) return;
    confirmModal(`Approve deletion for ${esc(l.company)}?`, 'This cannot be undone.', async () => {
      await deleteDoc(doc(db,'leads',l.id));
      toast('Lead deleted.','info'); renderPipelineTab();
    });
  }));
  document.querySelectorAll('[data-reject-del]').forEach(b=>b.addEventListener('click', async () => {
    const l = leads.find(x=>x.id===b.dataset.rejectDel); if(!l) return;
    await updateDoc(doc(db,'leads',l.id), {
      deleteRequest:null,
      history:[...(l.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion request rejected' }]
    });
    toast('Deletion request rejected.','info'); renderPipelineTab();
  }));
}

// ─── LEAD MODAL ───
export function showLeadModal(lead, byId, agents){
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
    <p class="text-dim text-xs mt-8">Last edited by <strong>${esc(lead.lastEditedBy||'—')}</strong> · ${lead.lastEditedAt?fmtDate(lead.lastEditedAt):'—'}</p>
    <p id="lm-err" class="err"></p>
    <div class="flex gap-8 mt-12" style="flex-wrap:wrap">
      <button class="btn btn-primary" id="lm-save">Save Changes</button>
      ${canDeleteDirect ? `<button class="btn btn-danger btn-sm" id="lm-del">Delete Lead</button>` : ''}
      ${canRequestDelete && !hasPendingDeleteReq ? `<button class="btn btn-ghost btn-sm" id="lm-reqdel" style="border-color:var(--amber);color:var(--amber)">🔒 Request Deletion</button>` : ''}
      ${canRequestDelete && hasPendingDeleteReq && isMyDeleteRequest ? `<button class="btn btn-ghost btn-sm" id="lm-withdraw-del">Withdraw Delete Request</button>` : ''}
      ${role==='manager' && hasPendingDeleteReq ? `<button class="btn btn-danger btn-sm" id="lm-approve-del">✅ Approve Deletion</button><button class="btn btn-ghost btn-sm" id="lm-reject-del">✖ Reject Request</button>` : ''}
    </div>`,true);

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
        lastEditedBy:CP.name, lastEditedAt:now(),
        history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:changeSummary }]
      };

      // Re-resolve teamId only if assignee changed
      if(newAssignTo !== lead.assignedTo){
        const aSnap = await getDoc(doc(db,'users',newAssignTo));
        update.teamId = aSnap.exists() ? (aSnap.data().teamId||'') : '';
        update.tlId   = aSnap.exists() ? (aSnap.data().tlId  ||'') : '';
      }

      await updateDoc(doc(db,'leads',lead.id), update);
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
        await deleteDoc(doc(db,'leads',lead.id));
        closeModal(); toast('Lead deleted.','info'); renderPipelineTab();
      });
  });

  document.getElementById('lm-reqdel')?.addEventListener('click',()=>{
    confirmModal(`Request deletion for ${esc(lead.company)}?`,
      'This lead was created by your manager. A deletion request will be sent for approval — the lead stays active until approved.',
      async () => {
        await updateDoc(doc(db,'leads',lead.id), {
          deleteRequest: { requestedBy:CU.uid, requestedByName:CP.name, requestedAt:now() },
          history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion requested — pending manager approval' }]
        });
        closeModal(); toast('Deletion request sent to manager.','info'); renderPipelineTab();
      });
  });

  document.getElementById('lm-withdraw-del')?.addEventListener('click', async () => {
    await updateDoc(doc(db,'leads',lead.id), {
      deleteRequest:null,
      history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion request withdrawn' }]
    });
    closeModal(); toast('Deletion request withdrawn.','info'); renderPipelineTab();
  });

  document.getElementById('lm-approve-del')?.addEventListener('click',()=>{
    confirmModal(`Approve deletion for ${esc(lead.company)}?`,
      'This cannot be undone.',
      async () => {
        await deleteDoc(doc(db,'leads',lead.id));
        closeModal(); toast('Lead deleted.','info'); renderPipelineTab();
      });
  });

  document.getElementById('lm-reject-del')?.addEventListener('click', async () => {
    await updateDoc(doc(db,'leads',lead.id), {
      deleteRequest:null,
      history:[...(lead.history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:'Deletion request rejected' }]
    });
    closeModal(); toast('Deletion request rejected.','info'); renderPipelineTab();
  });
}

// ─── ADD LEAD MODAL ───
function showAddLeadModal(agents, byId){
  const role = CP.role;
  modal('Add New Lead', `
    <div class="row2">
      <div class="field"><label>Company Name *</label><input type="text" id="nl-co" placeholder="Company Ltd"></div>
      <div class="field"><label>Contact Name</label><input type="text" id="nl-ct" placeholder="John Doe"></div>
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

  document.getElementById('nl-btn').onclick = async () => {
    const co = v('nl-co');
    const err = document.getElementById('nl-err');
    if(!co){ err.textContent='Company name is required.'; return; }
    const assignTo = role==='agent' ? CU.uid : (v('nl-ag')||'');
    if(role==='team_lead' && !assignTo){ err.textContent='No agents in your sub-group yet. Ask your manager to assign agents first.'; return; }
    disable('nl-btn','Adding…');
    try {
      // Resolve teamId from assignee's user doc (skip for manager self-assign)
      let leadTeamId = '', leadTlId = '';
      if(assignTo && assignTo !== CU.uid){
        const aSnap = await getDoc(doc(db,'users',assignTo));
        if(aSnap.exists()){ leadTeamId = aSnap.data().teamId||''; leadTlId = aSnap.data().tlId||''; }
      }
      await addDoc(collection(db,'leads'),{
        company:co, contact:v('nl-ct'), phone:v('nl-ph'), email:v('nl-em'),
        industry:v('nl-ind'), city:v('nl-cy'), stage:v('nl-st')||'New',
        assignedTo:assignTo, assignedBy:CU.uid,
        teamId:leadTeamId, tlId:leadTlId,
        createdBy:CU.uid, createdByRole:CP.role,
        ownerLocked: CP.role==='manager',
        dealValue:0, notes:'', followup:'',
        lastEditedBy:CP.name, lastEditedAt:now(),
        history:[{ ts:now(), actorId:CU.uid, actorName:CP.name, change:'Lead created' }]
      });
      closeModal(); toast('Lead added.'); renderPipelineTab();
    } catch(e){ err.textContent=e.message; enable('nl-btn','Add Lead'); }
  };
}
