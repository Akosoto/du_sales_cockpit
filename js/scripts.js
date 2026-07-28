import {
  db, CU, CP,
  collection, query, where, getDocs
} from './state.js';
import { dbAdd, dbUpdate, dbDelete, newBatch, batchAdd } from './db.js';
import { v, esc, now, fmtDate, disable, enable, toast, modal, closeModal, confirmModal } from './helpers.js';

// ════════════════════════════════════════════════════
// SCRIPTS — PHASE 3
// ════════════════════════════════════════════════════

async function seedChannels(){
  const snap = await getDocs(collection(db,'channels'));
  if(snap.size > 0) return;
  const defaults = ['WhatsApp','LinkedIn','Email','Cold Call'];
  const bat = newBatch();
  defaults.forEach(name => {
    batchAdd(bat, 'channels', {name, active:true});
  });
  await bat.commit();
}

function chClass(name){
  const n=(name||'').toLowerCase();
  if(n==='whatsapp') return 'sc-ch-wa';
  if(n==='linkedin') return 'sc-ch-li';
  if(n==='email')    return 'sc-ch-em';
  if(n.includes('cold')) return 'sc-ch-cc';
  return 'sc-ch-def';
}

export async function renderScriptsSection(){
  const ct   = document.getElementById('content');
  const role = CP.role;
  ct.innerHTML = '<div class="loading"><div class="spin"></div> Loading…</div>';

  if(role==='manager') await seedChannels();

  const [chSnap, scSnap] = await Promise.all([
    getDocs(query(collection(db,'channels'),where('active','==',true))),
    getDocs(collection(db,'scripts'))
  ]);
  const channels   = chSnap.docs.map(d=>({id:d.id,...d.data()}));
  const allScripts = scSnap.docs.map(d=>({id:d.id,...d.data()}));

  // Visibility rules:
  // Manager  → all scripts
  // TL       → global (manager-created) + own team scripts
  // Agent    → approved global + approved scripts whose createdBy === agent's tlId
  let scripts;
  if(role==='manager'){
    scripts = allScripts;
  } else if(role==='team_lead'){
    scripts = allScripts.filter(s =>
      s.scope==='global' || (s.scope==='team' && s.createdBy===CU.uid)
    );
  } else {
    scripts = allScripts.filter(s =>
      (s.scope==='global' && s.approved) ||
      (s.scope==='team'   && s.approved && s.createdBy===CP.tlId)
    );
  }

  let chFilter = '';

  // ── inner: filter ───────────────────────────────
  function filteredScripts(){ return chFilter ? scripts.filter(s=>s.channel===chFilter) : scripts; }

  // ── inner: re-render approval queue (manager only) ──
  function renderQueueBlock(){
    const qEl = document.getElementById('sc-queue');
    if(!qEl) return;
    const pending = scripts.filter(s=>s.pendingApproval);
    if(!pending.length){ qEl.innerHTML=''; return; }
    qEl.innerHTML=`<div class="approval-queue">
      <div class="approval-queue-hdr">
        <span style="font-weight:600;color:#93c5fd">🔔 Pending Approvals (${pending.length})</span>
      </div>
      ${pending.map(s=>`<div class="approval-item">
        <div style="flex:1">
          <div style="font-weight:600;font-size:13px">${esc(s.title)}</div>
          <div class="sc-meta" style="margin-top:2px">Submitted by <strong>${esc(s.pendingApproval.submittedByName||'—')}</strong> · ${s.pendingApproval.submittedAt?fmtDate(s.pendingApproval.submittedAt):'—'}</div>
        </div>
        <button class="btn btn-primary btn-xs" data-sc-qreview="${s.id}">Review →</button>
      </div>`).join('')}
    </div>`;
    qEl.querySelectorAll('[data-sc-qreview]').forEach(b=>{
      const s=scripts.find(x=>x.id===b.dataset.scQreview);
      if(s) b.addEventListener('click',()=>showApprovalModal(s,onScriptUpdate));
    });
  }

  // ── inner: mutation callback ─────────────────────
  function onScriptUpdate(updated){
    if(updated){
      const idx=scripts.findIndex(x=>x.id===updated.id);
      if(idx>=0) scripts[idx]=updated; else scripts.push(updated);
    }
    renderQueueBlock();
    renderCards();
  }

  // ── inner: render script cards ───────────────────
  function renderCards(){
    const list = document.getElementById('sc-list');
    if(!list) return;
    const cntEl = document.getElementById('sc-count');
    if(cntEl) cntEl.textContent = `${scripts.length} script${scripts.length!==1?'s':''}`;
    const f = filteredScripts();
    if(!f.length){
      list.innerHTML=`<div class="empty"><div class="empty-icon">📞</div>
        <div class="empty-title">No scripts yet</div>
        <div class="empty-sub">${role==='agent'?'Your team has no scripts yet.':'Add your first script to get started.'}</div></div>`;
      return;
    }

    list.innerHTML=`<div class="sc-grid">${f.map(s=>{
      const isPendingMine = role==='team_lead' && !!s.pendingApproval && s.pendingApproval.submittedBy===CU.uid;
      const hasPending    = role==='manager'   && !!s.pendingApproval;
      const cls = isPendingMine?'sc-card pending-mine':hasPending?'sc-card has-pending':'sc-card';
      const displayBody   = isPendingMine ? (s.pendingApproval.proposedBody||'') : (s.body||'');
      const bId = `scb-${s.id}`;
      return `<div class="${cls}">
        <div class="flex gap-8" style="flex-wrap:wrap">
          <span class="sc-badge ${chClass(s.channel)}">${esc(s.channel||'—')}</span>
          <span class="sc-badge ${s.scope==='global'?'sc-scope-global':'sc-scope-team'}">${s.scope==='global'?'🌐 Global':'👥 Team'}</span>
          ${isPendingMine?'<span class="sc-pending-badge">⏳ Awaiting Approval</span>':''}
          ${hasPending?'<span class="sc-pending-badge" style="color:#93c5fd;background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.3)">🔔 Edit Pending</span>':''}
        </div>
        <div style="font-weight:600;font-size:.95rem">${esc(s.title)}</div>
        ${isPendingMine?'<div class="sc-meta" style="color:#f59e0b">📝 Showing your proposed edit — pending manager approval</div>':''}
        <div class="sc-body" id="${bId}">${esc(displayBody)}</div>
        <button class="btn btn-ghost btn-xs sc-expand" style="align-self:flex-start;padding:2px 6px;font-size:11px;margin-top:-4px" data-bid="${bId}">Show more ▼</button>
        <div class="sc-meta">
          Created by <strong>${esc(s.createdByName||'—')}</strong> · ${s.createdAt?fmtDate(s.createdAt):'—'}
          ${s.lastEditedBy&&s.lastEditedAt&&s.lastEditedBy!==s.createdByName
            ?`<br>Edited by <strong>${esc(s.lastEditedBy)}</strong> · ${fmtDate(s.lastEditedAt)}`:''}
        </div>
        <div class="sc-actions">
          ${role==='manager'?`
            <button class="btn btn-ghost btn-xs" data-sc-edit="${s.id}">✏ Edit</button>
            ${hasPending?`<button class="btn btn-primary btn-xs" data-sc-review="${s.id}">🔔 Review</button>`:''}
            <button class="btn btn-danger btn-xs" data-sc-del="${s.id}">Delete</button>
          `:''}
          ${role==='team_lead'&&s.createdBy===CU.uid?`
            <button class="btn btn-ghost btn-xs" data-sc-edit="${s.id}">✏ Edit</button>
            <button class="btn btn-danger btn-xs" data-sc-del="${s.id}">Delete</button>
          `:''}
          ${role==='team_lead'&&s.createdBy!==CU.uid&&!s.pendingApproval?`
            <button class="btn btn-ghost btn-xs" data-sc-suggest="${s.id}">✏ Suggest Edit</button>
          `:''}
          ${isPendingMine?`
            <button class="btn btn-ghost btn-xs" data-sc-withdraw="${s.id}">↩ Withdraw Edit</button>
          `:''}
          ${role==='agent'?`<button class="btn btn-ghost btn-xs" data-sc-view="${s.id}">View →</button>`:''}
        </div>
      </div>`;
    }).join('')}</div>`;

    // Expand toggles — check after paint
    list.querySelectorAll('.sc-expand').forEach(b=>{
      const bodyEl = document.getElementById(b.dataset.bid);
      if(!bodyEl){ b.style.display='none'; return; }
      requestAnimationFrame(()=>{
        if(bodyEl.scrollHeight<=95){ b.style.display='none'; return; }
        b.addEventListener('click',()=>{
          const exp = bodyEl.classList.toggle('expanded');
          b.textContent = exp?'Show less ▲':'Show more ▼';
        });
      });
    });

    // Edit (direct — manager always, TL on own)
    list.querySelectorAll('[data-sc-edit]').forEach(b=>{
      const s=scripts.find(x=>x.id===b.dataset.scEdit);
      if(s) b.addEventListener('click',()=>showEditScriptModal(s,channels,onScriptUpdate));
    });

    // Delete
    list.querySelectorAll('[data-sc-del]').forEach(b=>{
      const sid=b.dataset.scDel;
      const s=scripts.find(x=>x.id===sid);
      if(!s) return;
      b.addEventListener('click',()=>confirmModal(`Delete "${s.title}"?`,'Cannot be undone.',async()=>{
        await dbDelete('scripts', sid);
        scripts.splice(scripts.findIndex(x=>x.id===sid),1);
        closeModal(); toast('Script deleted.','info');
        renderQueueBlock(); renderCards();
      }));
    });

    // Suggest edit (TL on manager scripts)
    list.querySelectorAll('[data-sc-suggest]').forEach(b=>{
      const s=scripts.find(x=>x.id===b.dataset.scSuggest);
      if(s) b.addEventListener('click',()=>showSuggestEditModal(s,onScriptUpdate));
    });

    // Withdraw proposed edit
    list.querySelectorAll('[data-sc-withdraw]').forEach(b=>{
      const sid=b.dataset.scWithdraw;
      const s=scripts.find(x=>x.id===sid);
      if(!s) return;
      b.addEventListener('click',()=>confirmModal(
        'Withdraw proposed edit?',
        'Your suggested changes will be discarded. The original script is unchanged.',
        async()=>{
          // skipAudit: this update is bound by the Firestore rule's
          // affectedKeys().hasOnly(['pendingApproval']) restriction — adding
          // lastEditedBy/lastEditedAt would widen the write and get rejected.
          await dbUpdate('scripts', sid, {pendingApproval:null}, {skipAudit:true});
          s.pendingApproval=null;
          closeModal(); toast('Edit withdrawn.'); renderCards();
        }
      ));
    });

    // View (agent)
    list.querySelectorAll('[data-sc-view]').forEach(b=>{
      const s=scripts.find(x=>x.id===b.dataset.scView);
      if(s) b.addEventListener('click',()=>showScriptViewModal(s));
    });

    // In-card review (manager)
    list.querySelectorAll('[data-sc-review]').forEach(b=>{
      const s=scripts.find(x=>x.id===b.dataset.scReview);
      if(s) b.addEventListener('click',()=>showApprovalModal(s,onScriptUpdate));
    });
  }

  // ── Build page shell ─────────────────────────────
  ct.innerHTML=`
    <div class="pg-hdr">
      <div><h2>📞 Scripts</h2><p class="pg-hdr-sub" id="sc-count">${scripts.length} script${scripts.length!==1?'s':''}</p></div>
      <div class="pg-actions">
        ${role!=='agent'?`<button class="btn btn-primary btn-sm" id="btn-add-sc">+ New Script</button>`:''}
        ${role==='manager'?`<button class="btn btn-ghost btn-sm" id="btn-ch-mgr">⚙ Channels</button>`:''}
      </div>
    </div>
    ${role==='manager'?'<div id="sc-queue"></div>':''}
    <div class="filters" id="sc-ch-filters">
      <button class="ch-tag active" data-ch="">All</button>
      ${channels.map(ch=>`<button class="ch-tag" data-ch="${esc(ch.name)}">${esc(ch.name)}</button>`).join('')}
    </div>
    <div id="sc-list"></div>`;

  if(role==='manager') renderQueueBlock();
  renderCards();

  ct.querySelector('#btn-add-sc')?.addEventListener('click',()=>showAddScriptModal(channels,scripts,onScriptUpdate));
  ct.querySelector('#btn-ch-mgr')?.addEventListener('click',()=>showManageChannelsModal(channels,renderScriptsSection));
  ct.querySelectorAll('[data-ch]').forEach(b=>b.addEventListener('click',()=>{
    chFilter=b.dataset.ch;
    ct.querySelectorAll('[data-ch]').forEach(x=>x.classList.toggle('active',x===b));
    renderCards();
  }));
}

// ── ADD SCRIPT ──────────────────────────────────────
function showAddScriptModal(channels, scripts, onUpdate){
  const isManager = CP.role==='manager';
  modal('New Script',`
    <div class="field"><label>Title *</label><input type="text" id="ns-title" placeholder="e.g. Opening WhatsApp message"></div>
    <div class="field"><label>Channel *</label>
      <select id="ns-ch">
        <option value="">— Select channel —</option>
        ${channels.map(ch=>`<option value="${esc(ch.name)}">${esc(ch.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Script Body *</label>
      <textarea id="ns-body" rows="9" placeholder="Write the full script here…&#10;&#10;Hi [Name], I'm reaching out from Shaun Technologies…"></textarea>
    </div>
    <p id="ns-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="ns-btn">Create Script</button>
    <p class="text-dim text-xs mt-8">${isManager?'Manager scripts are visible to all teams (Global).':'Your script will be visible to your assigned agents and the manager.'}</p>`);

  document.getElementById('ns-btn').onclick=async()=>{
    const title=v('ns-title'), body=v('ns-body'), channel=v('ns-ch');
    const err=document.getElementById('ns-err');
    if(!title){err.textContent='Title is required.'; return;}
    if(!body) {err.textContent='Script body is required.'; return;}
    if(!channel){err.textContent='Please select a channel.'; return;}
    disable('ns-btn','Creating…');
    try{
      const payload={
        title, body, channel,
        scope:    isManager?'global':'team',
        teamId:   isManager?null:CP.teamId,
        createdByName:CP.name, createdByRole:CP.role,
        pendingApproval:null, approved:true
      };
      const ref=await dbAdd('scripts', payload);
      closeModal(); toast('Script created.');
      onUpdate({id:ref.id,...payload,createdBy:CU.uid,createdAt:now(),lastEditedBy:CP.name,lastEditedAt:now()});
    }catch(e){err.textContent=e.message; enable('ns-btn','Create Script');}
  };
}

// ── EDIT SCRIPT (direct — manager always, TL on own) ──
function showEditScriptModal(s, channels, onUpdate){
  modal(`Edit: ${s.title}`,`
    <div class="field"><label>Title *</label><input type="text" id="es-title" value="${esc(s.title)}"></div>
    <div class="field"><label>Channel</label>
      <select id="es-ch">
        ${channels.map(ch=>`<option value="${esc(ch.name)}"${ch.name===s.channel?' selected':''}>${esc(ch.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Script Body *</label><textarea id="es-body" rows="10">${esc(s.body||'')}</textarea></div>
    <p class="text-dim text-xs mb-12">Created by <strong>${esc(s.createdByName||'—')}</strong> · ${s.createdAt?fmtDate(s.createdAt):'—'}</p>
    <p id="es-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="es-btn">Save Changes</button>`);

  document.getElementById('es-btn').onclick=async()=>{
    const title=v('es-title'), body=v('es-body'), channel=v('es-ch');
    const err=document.getElementById('es-err');
    if(!title){err.textContent='Title is required.'; return;}
    if(!body) {err.textContent='Script body is required.'; return;}
    disable('es-btn','Saving…');
    try{
      const upd={title,body,channel};
      await dbUpdate('scripts', s.id, upd);
      closeModal(); toast('Script updated.'); onUpdate({...s,...upd,lastEditedBy:CP.name,lastEditedAt:now()});
    }catch(e){err.textContent=e.message; enable('es-btn','Save Changes');}
  };
}

// ── SUGGEST EDIT (TL on manager scripts) ────────────
function showSuggestEditModal(s, onUpdate){
  modal(`Suggest Edit: ${s.title}`,`
    <div class="field" style="margin-bottom:6px">
      <label>Current Script (read-only)</label>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;font-size:12.5px;white-space:pre-wrap;line-height:1.55;max-height:130px;overflow-y:auto;color:var(--t2)">${esc(s.body||'')}</div>
    </div>
    <div class="field">
      <label>Your Proposed Edit *</label>
      <textarea id="se-body" rows="9">${esc(s.body||'')}</textarea>
    </div>
    <p class="text-dim text-xs" style="margin-bottom:10px">⚠ The original script stays active for agents until the manager approves. You will see your proposed version while it is pending.</p>
    <p id="se-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="se-btn">Submit for Approval</button>`);

  document.getElementById('se-btn').onclick=async()=>{
    const proposed=v('se-body');
    const err=document.getElementById('se-err');
    if(!proposed){err.textContent='Proposed body is required.'; return;}
    if(proposed===s.body){err.textContent='No changes detected — edit the body before submitting.'; return;}
    disable('se-btn','Submitting…');
    try{
      const pa={
        submittedBy:CU.uid, submittedByName:CP.name,
        submittedAt:now(), originalBody:s.body, proposedBody:proposed
      };
      // skipAudit: bound by affectedKeys().hasOnly(['pendingApproval']) — see
      // the withdraw-edit handler above for the same constraint.
      await dbUpdate('scripts', s.id, {pendingApproval:pa}, {skipAudit:true});
      closeModal(); toast('Edit submitted for manager review.');
      onUpdate({...s,pendingApproval:pa});
    }catch(e){err.textContent=e.message; enable('se-btn','Submit for Approval');}
  };
}

// ── APPROVAL MODAL (manager reviews TL edit) ────────
function showApprovalModal(s, onUpdate){
  if(!s.pendingApproval) return;
  const pa=s.pendingApproval;
  modal(`Review Edit: ${s.title}`,`
    <div class="row2" style="margin-bottom:14px">
      <div>
        <p class="text-dim text-xs mb-12" style="text-transform:uppercase;letter-spacing:.06em">Current (Live)</p>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;font-size:12.5px;white-space:pre-wrap;line-height:1.55;min-height:100px;max-height:240px;overflow-y:auto;color:var(--t2)">${esc(pa.originalBody||s.body||'')}</div>
      </div>
      <div>
        <p class="text-dim text-xs mb-12" style="text-transform:uppercase;letter-spacing:.06em;color:#f59e0b">Proposed Edit</p>
        <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.25);border-radius:var(--r);padding:10px 12px;font-size:12.5px;white-space:pre-wrap;line-height:1.55;min-height:100px;max-height:240px;overflow-y:auto;color:var(--t1)">${esc(pa.proposedBody||'')}</div>
      </div>
    </div>
    <p class="text-dim text-xs">Submitted by <strong>${esc(pa.submittedByName||'—')}</strong> · ${pa.submittedAt?fmtDate(pa.submittedAt):'—'}</p>
    <p id="ap-err" class="err"></p>
    <div class="flex gap-8 mt-12">
      <button class="btn btn-success" id="ap-approve">✓ Approve & Publish</button>
      <button class="btn btn-danger"  id="ap-reject">✕ Reject</button>
    </div>`,true);

  document.getElementById('ap-approve').onclick=async()=>{
    disable('ap-approve','Approving…');
    try{
      // lastEditedBy credits the TL who wrote the change, not the manager
      // approving it — explicit here, overriding db.js's default stamp
      // (caller-provided fields always win over the gateway's defaults).
      const upd={body:pa.proposedBody,pendingApproval:null,lastEditedBy:pa.submittedByName,lastEditedAt:now()};
      await dbUpdate('scripts', s.id, upd);
      closeModal(); toast('Edit approved and published.');
      onUpdate({...s,...upd});
    }catch(e){document.getElementById('ap-err').textContent=e.message; enable('ap-approve','✓ Approve & Publish');}
  };

  document.getElementById('ap-reject').onclick=async()=>{
    disable('ap-reject','Rejecting…');
    try{
      // skipAudit: same affectedKeys().hasOnly(['pendingApproval']) constraint.
      await dbUpdate('scripts', s.id, {pendingApproval:null}, {skipAudit:true});
      closeModal(); toast('Edit rejected — original retained.','info');
      onUpdate({...s,pendingApproval:null});
    }catch(e){document.getElementById('ap-err').textContent=e.message; enable('ap-reject','✕ Reject');}
  };
}

// ── VIEW SCRIPT (agent full view) ───────────────────
function showScriptViewModal(s){
  modal(esc(s.title),`
    <div class="flex gap-8 mb-12" style="flex-wrap:wrap">
      <span class="sc-badge ${chClass(s.channel)}">${esc(s.channel||'—')}</span>
      <span class="sc-badge ${s.scope==='global'?'sc-scope-global':'sc-scope-team'}">${s.scope==='global'?'🌐 Global':'👥 Team'}</span>
    </div>
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;font-size:13px;white-space:pre-wrap;line-height:1.6;max-height:380px;overflow-y:auto">${esc(s.body||'')}</div>
    <div class="sc-meta mt-12">
      Created by <strong>${esc(s.createdByName||'—')}</strong> · ${s.createdAt?fmtDate(s.createdAt):'—'}
      ${s.lastEditedBy&&s.lastEditedAt&&s.lastEditedBy!==s.createdByName
        ?`<br>Last edit by <strong>${esc(s.lastEditedBy)}</strong> · ${fmtDate(s.lastEditedAt)}`:''}
    </div>`,true);
}

// ── MANAGE CHANNELS (manager) ────────────────────────
function showManageChannelsModal(channels, refreshFn){
  function renderChList(){
    const el = document.getElementById('ch-list');
    if(!el) return;
    el.innerHTML = channels.length
      ? channels.map(ch=>`<div class="flex gap-8 mb-12" style="align-items:center">
          <span style="flex:1;font-size:13px">${esc(ch.name)}</span>
          <button class="btn btn-danger btn-xs" data-del-ch="${ch.id}">Remove</button>
        </div>`).join('')
      : '<p class="text-dim text-xs">No channels.</p>';
    el.querySelectorAll('[data-del-ch]').forEach(b=>{
      const chId=b.dataset.delCh;
      b.addEventListener('click',async()=>{
        if(!confirm('Remove this channel? Existing scripts keep their channel label.')) return;
        await dbUpdate('channels', chId, {active:false});
        channels.splice(channels.findIndex(x=>x.id===chId),1);
        renderChList();
      });
    });
  }

  modal('Manage Channels',`
    <div id="ch-list"></div>
    <div class="divider"></div>
    <div class="field"><label>Add New Channel</label><input type="text" id="ch-new" placeholder="e.g. SMS, In-Person"></div>
    <p id="ch-err" class="err"></p>
    <button class="btn btn-primary btn-sm" id="ch-add-btn">+ Add Channel</button>
    <p class="text-dim text-xs mt-12">Changes apply next time the Scripts tab is opened.</p>`);

  renderChList();

  document.getElementById('ch-add-btn').onclick=async()=>{
    const name=v('ch-new');
    const err=document.getElementById('ch-err');
    if(!name){err.textContent='Channel name required.'; return;}
    if(channels.find(c=>c.name.toLowerCase()===name.toLowerCase())){err.textContent='Channel already exists.'; return;}
    disable('ch-add-btn','Adding…');
    try{
      const ref=await dbAdd('channels', {name, active:true});
      channels.push({id:ref.id,name,active:true});
      document.getElementById('ch-new').value='';
      err.textContent='';
      enable('ch-add-btn','+ Add Channel');
      renderChList();
      toast('Channel added.');
    }catch(e){err.textContent=e.message; enable('ch-add-btn','+ Add Channel');}
  };
}
