import {
  db, CU, CP, ORG_DEFAULTS,
  collection, getDocs, doc, getDoc, query, where
} from './state.js';
import { esc, fmtDate, toast, modal, closeModal, disable, enable, v } from './helpers.js';
import {
  SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_COLORS, EVENT_LABELS,
  claimSubmission, reassignSubmission, appendEvent,
  BACKEND_ATTACHMENT_TYPES, attachBackendDocument
} from './submissions.js';
import * as storage from './storage/index.js';
import { captureFile } from './documents.js';
import { downloadBundlePdf } from './pdfExport.js';

// Client-side workflow policy (step 2) — NOT a security boundary, the
// submissions rule already gives the whole backend department unrestricted
// update rights on every submission. This just decides which button each
// role sees: any active backend user can claim an unassigned submission;
// only a backend coordinator (team_lead + department:'backend') or manager
// gets the reassign picker.
function isBackendUser(){ return CP.department === 'backend' && CP.active !== false; }
function canReassign(){ return CP.role === 'manager' || (CP.role === 'team_lead' && isBackendUser()); }

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
            <td class="flex gap-8">
              <button class="btn btn-ghost btn-xs" data-open="${s.id}">Open →</button>
              ${!s.assignedBackendAgent && isBackendUser() ? `<button class="btn btn-primary btn-xs" data-claim="${s.id}">Claim</button>` : ''}
              ${canReassign() ? `<button class="btn btn-ghost btn-xs" data-reassign="${s.id}">Reassign</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty"><div class="empty-icon">📥</div><div class="empty-title">No submissions in this view</div><div class="empty-sub">Try a different queue view, status filter, or include activated/rejected.</div></div>`}
    `;

    ct.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; render(); }));
    document.getElementById('q-status-filter').addEventListener('change', function(){ statusF = this.value; render(); });
    document.getElementById('q-include-terminal').addEventListener('change', function(){ includeTerminal = this.checked; render(); });
    ct.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
      const sub = submissions.find(s=>s.id===b.dataset.open);
      if(sub) showActionPanel(sub, companyById[sub.companyId], () => render());
    }));

    ct.querySelectorAll('[data-claim]').forEach(b => b.addEventListener('click', async () => {
      const sub = submissions.find(s=>s.id===b.dataset.claim); if(!sub) return;
      b.disabled = true; b.textContent = 'Claiming…';
      try {
        await claimSubmission(sub.id);
        sub.assignedBackendAgent = CU.uid;
        toast('Claimed.');
        render();
      } catch(e){ toast('Error: '+e.message, 'err'); b.disabled = false; b.textContent = 'Claim'; }
    }));

    ct.querySelectorAll('[data-reassign]').forEach(b => b.addEventListener('click', () => {
      const sub = submissions.find(s=>s.id===b.dataset.reassign); if(!sub) return;
      showReassignModal(sub);
    }));
  }

  function showReassignModal(sub){
    const oldAgentName = sub.assignedBackendAgent ? agentName(sub.assignedBackendAgent) : null;
    modal('Reassign Submission', `
      <p class="text-dim text-sm mb-12">Currently: <strong>${oldAgentName ? esc(oldAgentName) : 'Unassigned'}</strong></p>
      <div class="field"><label>Assign To</label>
        <select id="rs-agent">
          <option value="">— Unassigned —</option>
          ${backendUsers.map(u=>`<option value="${u.id}" ${u.id===sub.assignedBackendAgent?' selected':''}>${esc(u.name)}</option>`).join('')}
        </select>
      </div>
      <p id="rs-err" class="err"></p>
      <button class="btn btn-primary btn-full mt-12" id="rs-btn">Reassign</button>
    `);
    document.getElementById('rs-btn').onclick = async () => {
      const newAgentId = document.getElementById('rs-agent').value;
      if(newAgentId === (sub.assignedBackendAgent||'')){ closeModal(); return; }
      disable('rs-btn','Reassigning…');
      try {
        const newAgentName = newAgentId ? (byId[newAgentId]?.name || '—') : 'Unassigned';
        await reassignSubmission(sub.id, newAgentId || null, oldAgentName, newAgentName);
        sub.assignedBackendAgent = newAgentId || null;
        closeModal(); toast('Reassigned.'); render();
      } catch(e){
        document.getElementById('rs-err').textContent = e.message;
        enable('rs-btn','Reassign');
      }
    };
  }

  render();
}

// ════════════════════════════════════════════════════
// SUBMISSION ACTION PANEL (step 3) — opens from a Queue row. Shows the full
// submission (company block, product line, doc checklist + on-demand page
// viewing via the existing storage adapter, full events timeline) and every
// appendEvent action. The UI only ever CALLS appendEvent — it never sets
// status directly; every status transition (including the
// proceededWithoutVerification auto-append) already lives there.
// ════════════════════════════════════════════════════
function slug(s){ return s.replace(/[^a-zA-Z0-9]/g,'_'); }

async function showActionPanel(sub, company, onChange){
  let current = sub;

  async function refresh(){
    const snap = await getDoc(doc(db,'submissions',current.id));
    if(snap.exists()) current = {id:snap.id, ...snap.data()};
    render();
    onChange?.();
  }

  function docRow(rd){
    return `<div class="text-xs mt-4" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${esc(rd.type)}</span>
        <span class="text-dim">${rd.status==='uploaded'?'📎 uploaded':'attested'}${rd.expiryDate?` · expires ${fmtDate(rd.expiryDate)}`:''}</span>
        ${rd.storageRef ? `<button type="button" class="btn btn-ghost btn-xs" data-view-doc="${esc(rd.type)}">View (${rd.storageRef.pageCount} page${rd.storageRef.pageCount!==1?'s':''})</button>` : ''}
        ${rd.storageRef?.version > 1 ? `<button type="button" class="btn btn-ghost btn-xs" data-view-older="${esc(rd.type)}">older versions (${rd.storageRef.version-1})</button>` : ''}
      </div>
      <div id="ap-docpages-${slug(rd.type)}" class="mt-4"></div>
      <div id="ap-olderversions-${slug(rd.type)}" class="mt-4"></div>`;
  }

  function render(){
    const s = current;
    modal(`Submission — ${esc(company?.name || 'Unknown Company')}`, `
      <div class="flex mb-12" style="justify-content:flex-end">
        <button type="button" class="btn btn-ghost btn-xs" id="ap-download-bundle">⬇️ Download bundle PDF</button>
      </div>
      <div class="info-grid mb-12">
        <div class="info-item"><div class="lbl">Company</div><div class="val">${esc(company?.name||'—')} ${company?.hasDuAccount?'<span class="text-ok text-xs">● has du account</span>':''}</div></div>
        <div class="info-item"><div class="lbl">Account Code</div><div class="val">${esc(company?.accountCode||'—')}</div></div>
        <div class="info-item"><div class="lbl">Agent</div><div class="val">${esc(s.agentName||'—')}</div></div>
        <div class="info-item"><div class="lbl">Status</div><div class="val" style="color:${SUBMISSION_STATUS_COLORS[s.status]||'var(--t2)'}">${esc(SUBMISSION_STATUS_LABELS[s.status]||s.status)}</div></div>
      </div>
      <div class="divider"></div>
      <div class="info-grid mb-12">
        <div class="info-item"><div class="lbl">Product</div><div class="val">${esc(s.productName)} <span class="text-dim text-xs">${esc(s.category)}</span></div></div>
        <div class="info-item"><div class="lbl">Qty / MRC</div><div class="val">Qty ${s.qty} · AED ${Number(s.mrc).toLocaleString()}/mo</div></div>
        <div class="info-item"><div class="lbl">Type of Request</div><div class="val">${esc(s.typeOfRequest)}</div></div>
        <div class="info-item"><div class="lbl">Contract Term</div><div class="val">${s.contractTerm?`${s.contractTerm} months`:'—'}</div></div>
      </div>
      ${Object.keys(s.categoryFields||{}).length ? `<div class="info-grid mb-12">
        ${Object.entries(s.categoryFields).map(([k,val])=>`<div class="info-item"><div class="lbl">${esc(k)}</div><div class="val">${esc(val)}</div></div>`).join('')}
      </div>` : ''}
      ${s.sprFlag ? `<div class="locked-note mb-12">⭐ Special Pricing Request${s.sprNote?`: ${esc(s.sprNote)}`:''}</div>` : ''}
      ${s.accTransfer?.flag ? `<div class="locked-note mb-12">🔄 Account transfer from ${esc(s.accTransfer.fromPartner||'another partner')}</div>` : ''}
      <div class="divider"></div>
      <div class="field"><label>Documents</label>
        ${(s.requiredDocs||[]).map(docRow).join('') || '<p class="text-dim text-xs">None required.</p>'}
      </div>
      <div class="field mt-8"><label>Attach Document</label>
        <div class="row2">
          <select id="ap-attach-type">${BACKEND_ATTACHMENT_TYPES.map(t=>`<option>${t}</option>`).join('')}</select>
          <input type="file" id="ap-attach-file" accept="image/*,application/pdf">
        </div>
        <div id="ap-attach-preview" class="mt-4"></div>
        <button class="btn btn-ghost btn-sm mt-8" id="ap-attach-btn">Attach</button>
      </div>
      <div class="divider"></div>
      <div class="field"><label>Timeline</label>
        <div class="mt-4">
          ${(s.events||[]).map(e => `<div class="text-xs text-dim">• ${fmtDate(e.ts)} — <strong>${esc(e.actorName)}</strong>: ${esc(EVENT_LABELS[e.type]||e.type)}${e.payload?.note?` — ${esc(e.payload.note)}`:''}${e.payload?.text?` — ${esc(e.payload.text)}`:''}${e.payload?.reason?` (${esc(e.payload.reason)})`:''}${e.payload?.value?` — ${esc(e.payload.value)}`:''}${e.payload?.date?` — ${esc(e.payload.date)} ${esc(e.payload.time||'')} with ${esc(e.payload.person||'')}`:''}</div>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <div class="field"><label>Quick Actions</label>
        <div class="flex gap-8" style="flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" data-act="docsVerified">✅ Docs Verified</button>
          <button class="btn btn-ghost btn-sm" data-act="verificationCall">📞 Verified by Call</button>
          <button class="btn btn-ghost btn-sm" data-act="verificationEmail">📧 Verified by Email</button>
          <button class="btn btn-ghost btn-sm" data-act="biometric">🖐 Biometric Done</button>
          <button class="btn btn-ghost btn-sm" data-act="submittedToDu">📤 Submitted to du</button>
          <button class="btn btn-primary btn-sm" data-act="activated">✅ Activate</button>
        </div>
      </div>
      <div class="row2 mt-12">
        <div class="field"><label>Activity Number</label><div class="flex gap-8"><input type="text" id="ap-activityNo" placeholder="Activity #"><button class="btn btn-ghost btn-sm" data-payload-act="activityNo">Log</button></div></div>
        <div class="field"><label>Work Order Number</label><div class="flex gap-8"><input type="text" id="ap-workOrderNo" placeholder="WO #"><button class="btn btn-ghost btn-sm" data-payload-act="workOrderNo">Log</button></div></div>
      </div>
      <div class="field mt-8"><label>Appointment</label>
        <div class="row2">
          <input type="date" id="ap-appt-date">
          <input type="time" id="ap-appt-time">
        </div>
        <div class="flex gap-8 mt-8">
          <input type="text" id="ap-appt-person" placeholder="Person">
          <button class="btn btn-ghost btn-sm" data-payload-act="appointment">Log</button>
        </div>
      </div>
      <div class="row2 mt-8">
        <div class="field"><label>SPR Obtained</label><div class="flex gap-8"><input type="text" id="ap-sprObtained" placeholder="Note (optional)"><button class="btn btn-ghost btn-sm" data-payload-act="sprObtained">Log</button></div></div>
        <div class="field"><label>Correction</label><div class="flex gap-8"><input type="text" id="ap-correction" placeholder="Note"><button class="btn btn-ghost btn-sm" data-payload-act="correction">Log</button></div></div>
      </div>
      <div class="field mt-8"><label>Note</label><div class="flex gap-8"><input type="text" id="ap-note" placeholder="Free-text note"><button class="btn btn-ghost btn-sm" data-payload-act="note">Log</button></div></div>
      <div class="divider"></div>
      <div class="field"><label style="color:var(--red)">Reject</label>
        <select id="ap-reject-reason"><option value="">— Select a reason —</option>${ORG_DEFAULTS.rejectionReasons.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
        <input type="text" id="ap-reject-note" placeholder="Note (optional)" class="mt-8">
        <button class="btn btn-danger btn-full mt-8" data-payload-act="rejected">Reject Submission</button>
      </div>
      <p id="ap-err" class="err"></p>
    `, true);

    // Doc page viewing — identical on-demand single-get pattern as the
    // agent's own read-only timeline (js/leads.js showSubmissionTimelineModal).
    document.querySelectorAll('[data-view-doc]').forEach(btn => btn.onclick = async () => {
      const docType = btn.dataset.viewDoc;
      const rd = (s.requiredDocs||[]).find(r => r.type === docType);
      if(!rd?.storageRef) return;
      const target = document.getElementById(`ap-docpages-${slug(docType)}`);
      target.innerHTML = '<span class="text-dim text-xs">Loading…</span>';
      try {
        const pages = await Promise.all(
          Array.from({length: rd.storageRef.pageCount}, (_,i) =>
            storage.get({ bundleId: rd.storageRef.bundleId, docType: rd.storageRef.docType, version: rd.storageRef.version, pageIndex: i }))
        );
        target.innerHTML = pages.map((p,i) => p ? `<img src="${p.dataURL}" style="max-width:200px;border-radius:6px;margin:4px" alt="${esc(docType)} page ${i+1}">` : '').join('');
      } catch(e){
        target.innerHTML = `<span class="err text-xs">${esc(e.message)}</span>`;
      }
    });

    // Older versions (step 4d) — pageCount for an OLDER version isn't stored
    // anywhere (only the CURRENT requiredDocs[].storageRef carries one), so
    // each version's pages are discovered by probing sequentially until a
    // pageIndex comes back empty, capped at 10 (matches the capture
    // pipeline's own PDF page cap).
    document.querySelectorAll('[data-view-older]').forEach(btn => btn.onclick = () => {
      const docType = btn.dataset.viewOlder;
      const rd = (s.requiredDocs||[]).find(r => r.type === docType);
      if(!rd?.storageRef) return;
      const latestVersion = rd.storageRef.version || 1;
      const container = document.getElementById(`ap-olderversions-${slug(docType)}`);
      if(container.dataset.open === '1'){ container.innerHTML = ''; container.dataset.open = ''; return; }
      container.dataset.open = '1';
      container.innerHTML = Array.from({length: latestVersion-1}, (_,i) => i+1).map(ver =>
        `<div class="mt-4"><button type="button" class="btn btn-ghost btn-xs" data-view-doc-version="${esc(docType)}|${ver}">View v${ver}</button><div id="ap-docpages-${slug(docType)}-v${ver}" class="mt-4"></div></div>`
      ).join('');
      container.querySelectorAll('[data-view-doc-version]').forEach(vbtn => vbtn.onclick = async () => {
        const [dType, verStr] = vbtn.dataset.viewDocVersion.split('|');
        const ver = Number(verStr);
        const target = document.getElementById(`ap-docpages-${slug(dType)}-v${ver}`);
        target.innerHTML = '<span class="text-dim text-xs">Loading…</span>';
        const pages = [];
        for(let i=0; i<10; i++){
          const p = await storage.get({ bundleId: rd.storageRef.bundleId, docType: dType, version: ver, pageIndex: i });
          if(!p) break;
          pages.push(p);
        }
        target.innerHTML = pages.map((p,i) => `<img src="${p.dataURL}" style="max-width:200px;border-radius:6px;margin:4px" alt="${esc(dType)} v${ver} page ${i+1}">`).join('') || '<span class="text-dim text-xs">No pages found.</span>';
      });
    });

    // Combined-PDF export (step 5a) — needs every SIBLING submission's
    // requiredDocs (not just this one), fetched lazily on click since most
    // opens of the panel never use it.
    document.getElementById('ap-download-bundle').onclick = async () => {
      const btn = document.getElementById('ap-download-bundle');
      btn.disabled = true; btn.textContent = 'Preparing…';
      try {
        const siblingsSnap = await getDocs(query(collection(db,'submissions'), where('bundleId','==',s.bundleId)));
        const lines = siblingsSnap.docs.map(d => d.data());
        await downloadBundlePdf(s.bundleId, lines, (company?.name||'bundle').replace(/[^a-zA-Z0-9]/g,'_'));
      } catch(e){
        document.getElementById('ap-err').textContent = e.message;
      } finally {
        btn.disabled = false; btn.textContent = '⬇️ Download bundle PDF';
      }
    };

    // Backend attachment (step 5b) — same capture pipeline as the agent's
    // own upload, just a different (backend-only) doc-type list and a
    // separate write path (attachBackendDocument) that fans the new
    // requiredDocs entry out to every sibling submission in the bundle.
    let attachEntry = null;
    document.getElementById('ap-attach-file').onchange = async function(){
      const file = this.files[0];
      if(!file) return;
      const preview = document.getElementById('ap-attach-preview');
      preview.innerHTML = '<span class="text-dim text-xs">Processing…</span>';
      try {
        const result = await captureFile(file);
        attachEntry = { fileName: file.name, pages: result.pages, truncated: result.truncated, totalPages: result.totalPages };
        preview.innerHTML = `<span class="text-xs">${esc(file.name)} — ${result.pages.length} page${result.pages.length!==1?'s':''}${result.truncated?` (capped — PDF has ${result.totalPages})`:''}</span>`;
      } catch(e){
        attachEntry = null;
        preview.innerHTML = `<span class="err text-xs">${esc(e.message)}</span>`;
      }
    };
    document.getElementById('ap-attach-btn').onclick = async () => {
      const err = document.getElementById('ap-err');
      if(!attachEntry?.pages?.length){ err.textContent = 'Choose a file to attach first.'; return; }
      const docType = v('ap-attach-type');
      const btn = document.getElementById('ap-attach-btn');
      btn.disabled = true; btn.textContent = 'Attaching…';
      try {
        await attachBackendDocument({ bundleId: s.bundleId, docType, pages: attachEntry.pages });
        toast('Attached.');
        await refresh();
      } catch(e){
        err.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Attach';
      }
    };

    // Quick (no-payload) actions
    document.querySelectorAll('[data-act]').forEach(btn => btn.onclick = async () => {
      const type = btn.dataset.act;
      btn.disabled = true;
      try {
        await appendEvent(s.id, { type, payload: {} });
        toast('Logged.');
        await refresh();
      } catch(e){
        document.getElementById('ap-err').textContent = e.message;
        btn.disabled = false;
      }
    });

    // Payload actions
    document.querySelectorAll('[data-payload-act]').forEach(btn => btn.onclick = async () => {
      const type = btn.dataset.payloadAct;
      const err = document.getElementById('ap-err');
      err.textContent = '';
      let payload = {};
      if(type==='activityNo' || type==='workOrderNo'){
        const val = v(`ap-${type}`);
        if(!val){ err.textContent = 'A value is required.'; return; }
        payload = { value: val };
      } else if(type==='appointment'){
        const date = v('ap-appt-date'), time = v('ap-appt-time'), person = v('ap-appt-person');
        if(!date || !person){ err.textContent = 'Date and person are required.'; return; }
        payload = { date, time, person };
      } else if(type==='sprObtained'){
        payload = { note: v('ap-sprObtained') };
      } else if(type==='correction'){
        const note = v('ap-correction');
        if(!note){ err.textContent = 'A note is required.'; return; }
        payload = { note };
      } else if(type==='note'){
        const text = v('ap-note');
        if(!text){ err.textContent = 'Note text is required.'; return; }
        payload = { text };
      } else if(type==='rejected'){
        const reason = v('ap-reject-reason');
        if(!reason){ err.textContent = 'A rejection reason is required.'; return; }
        payload = { reason, note: v('ap-reject-note') };
      }
      btn.disabled = true;
      try {
        await appendEvent(s.id, { type, payload });
        toast(type==='rejected' ? 'Submission rejected.' : 'Logged.');
        await refresh();
      } catch(e){
        err.textContent = e.message;
        btn.disabled = false;
      }
    });
  }

  render();
}
