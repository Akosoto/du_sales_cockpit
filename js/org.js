import {
  db, CU, CP, auth, auth2,
  collection, query, where, getDocs,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from './state.js';
import { dbAdd, dbUpdate, newBatch, batchSet, batchUpdate, batchDelete } from './db.js';
import { v, esc, now, fmtDate, disable, enable, toast, modal, closeModal, confirmModal, calculateTLTarget } from './helpers.js';
import { permissionChecklistHtml, wirePermissionSearch, getSelectedPermissions } from './permissions.js';
import { fetchCompanies, backfillCompanies } from './companies.js';
import { PRODUCT_CATEGORIES } from './products.js';
import { orgId } from '../config.js';

// NOTE: this file used to carry 115 hardcoded prospect leads (real names,
// business emails, phone numbers) plus a one-time seedLeads() import
// button, for demo seeding. Both deleted — PII does not belong in source
// (ARCHITECTURE.md audit item 8). Data already lives in Firestore; a
// productized app seeds via CSV import (Data Import Tool), not hardcoded
// arrays. Purged from git history too.

// ════════════════════════════════════════════════════
// ORG TAB — MANAGER ONLY
// ════════════════════════════════════════════════════
export async function renderOrgTab(){
  const ct = document.getElementById('content');
  const [tSnap, uSnap, lSnap, companies] = await Promise.all([
    getDocs(collection(db,'teams')),
    getDocs(collection(db,'users')),
    getDocs(collection(db,'leads')),
    fetchCompanies()
  ]);
  const teams = tSnap.docs.map(d=>({id:d.id,...d.data()}));
  const users = uSnap.docs.map(d=>({id:d.id,...d.data()}));
  const tls   = users.filter(u=>u.role==='team_lead');
  const ags   = users.filter(u=>u.role==='agent');
  const byId  = {}; users.forEach(u=>byId[u.id]=u);
  const teamById = {}; teams.forEach(t=>teamById[t.id]=t);
  const allLeads = lSnap.docs.map(d=>({id:d.id,...d.data()}));
  // Leads assigned to a real agent but missing teamId — these silently fail the
  // TL Firestore security rule (resource.data.teamId must match), locking TLs
  // out of editing/deleting them. Most commonly the original seeded leads.
  const needsRepair = allLeads.filter(l => l.assignedTo && byId[l.assignedTo] && !l.teamId);
  // Leads that predate the companies collection (have a company string but no
  // companyId link) — same backfill gap as needsRepair above, just for the
  // company entity instead of team data.
  const needsCompanyBackfill = allLeads.filter(l => l.company && !l.companyId);
  const companyById = {}; companies.forEach(c=>companyById[c.id]=c);
  const companyLeadCount = {};
  allLeads.forEach(l => { if(l.companyId) companyLeadCount[l.companyId] = (companyLeadCount[l.companyId]||0)+1; });
  // orgId migration (ARCHITECTURE.md Phase A step 3) — every new doc gets
  // orgId stamped automatically now (js/db.js), but existing docs predate
  // that. Checked from data already fetched here (no extra reads) as a
  // proxy signal — the actual migration below covers all 8 collections
  // regardless of which ones triggered this banner.
  const needsOrgIdMigration = teams.some(t=>!t.orgId) || users.some(u=>!u.orgId) || allLeads.some(l=>!l.orgId) || companies.some(c=>!c.orgId);

  function perfStats(uids){
    const l = allLeads.filter(x=>uids.includes(x.assignedTo));
    const won  = l.filter(x=>x.stage==='Closed').length;
    const lost = l.filter(x=>x.stage==='Lost').length;
    const open = l.filter(x=>!['Closed','Lost'].includes(x.stage)).length;
    const val  = l.filter(x=>x.stage==='Closed').reduce((s,x)=>s+(Number(x.dealValue)||0),0);
    const rate = l.length ? Math.round(won/l.length*100) : 0;
    return {total:l.length,won,lost,open,val,rate};
  }
  function perfHtml(st){
    return `<div class="perf-stat-row">
      <div class="perf-stat"><div class="pv">${st.total}</div><div class="pl">Total</div></div>
      <div class="perf-stat"><div class="pv">${st.open}</div><div class="pl">Open</div></div>
      <div class="perf-stat"><div class="pv" style="color:var(--green)">${st.won}</div><div class="pl">Closed</div></div>
      <div class="perf-stat"><div class="pv" style="color:var(--red)">${st.lost}</div><div class="pl">Lost</div></div>
      <div class="perf-stat"><div class="pv" style="color:var(--amber)">${st.rate}%</div><div class="pl">Win Rate</div></div>
      ${st.val?`<div class="perf-stat"><div class="pv" style="font-size:.88rem;color:var(--green)">AED ${Number(st.val).toLocaleString()}</div><div class="pl">Closed Value</div></div>`:''}
    </div>`;
  }

  ct.innerHTML = `
    <div class="pg-hdr">
      <div><h2>Org & Teams</h2><p class="pg-hdr-sub">${teams.length} team${teams.length!==1?'s':''} · ${tls.length} team lead${tls.length!==1?'s':''} · ${ags.length} agent${ags.length!==1?'s':''}</p></div>
      <div class="pg-actions">
        <button class="btn btn-ghost btn-sm" id="btn-add-team">+ New Team</button>
        <button class="btn btn-ghost btn-sm" id="btn-add-tl">+ New Team Lead</button>
        <button class="btn btn-primary btn-sm" id="btn-add-ag">+ New Agent</button>
      </div>
    </div>

    ${needsRepair.length ? `<div class="seed-banner">
      <p><strong>${needsRepair.length} lead${needsRepair.length!==1?'s':''}</strong> ${needsRepair.length!==1?'are':'is'} missing team data and currently invisible/uneditable to Team Leads (Firestore permission rule blocks them). This backfills teamId/tlId from each lead's assigned agent — safe, non-destructive.</p>
      <button class="btn btn-primary btn-sm" id="btn-repair">🔧 Repair Lead Data (${needsRepair.length})</button>
    </div>` : ''}

    ${needsCompanyBackfill.length ? `<div class="seed-banner">
      <p><strong>${needsCompanyBackfill.length} lead${needsCompanyBackfill.length!==1?'s':''}</strong> ${needsCompanyBackfill.length!==1?'predate':'predates'} the Companies collection and ${needsCompanyBackfill.length!==1?'have':'has'} no linked company record. This groups them by matching company name, creates one company per unique name, and links each lead — safe to re-run.</p>
      <button class="btn btn-primary btn-sm" id="btn-backfill-companies">🏢 Backfill Companies (${needsCompanyBackfill.length})</button>
    </div>` : ''}

    ${needsOrgIdMigration ? `<div class="seed-banner">
      <p>Some existing records predate multi-tenant support and are missing an <strong>orgId</strong> tag. This stamps <code>orgId: "${esc(orgId)}"</code> on every existing document across users, teams, leads, companies, channels, scripts, products, and submissions — safe to re-run, and required before the Firestore rules can enforce org isolation.</p>
      <button class="btn btn-primary btn-sm" id="btn-orgid-migration">🏷️ Stamp orgId on Existing Data</button>
    </div>` : ''}

    <div class="stats-row">
      <div class="stat"><div class="stat-val">${teams.length}</div><div class="stat-lbl">Teams</div></div>
      <div class="stat"><div class="stat-val">${tls.length}</div><div class="stat-lbl">Team Leads</div></div>
      <div class="stat"><div class="stat-val">${ags.length}</div><div class="stat-lbl">Agents</div></div>
      <div class="stat"><div class="stat-val">${lSnap.size}</div><div class="stat-lbl">Total Leads</div></div>
    </div>

    <div id="teams-section">
    ${teams.length===0
      ? `<div class="card"><div class="empty"><div class="empty-icon">🏢</div><div class="empty-title">No teams yet</div><div class="empty-sub">Create a team to get started.</div></div></div>`
      : teams.map(t => {
          const teamTLs       = tls.filter(tl => tl.teamId === t.id);
          const tas           = ags.filter(a  => a.teamId  === t.id);
          const unassignedAgs = tas.filter(a  => !a.tlId);
          return `<div class="card" id="tc-${t.id}">
            <div class="card-hdr">
              <div>
                <div class="card-title">🏢 ${esc(t.name)}</div>
                <div class="text-dim text-sm mt-8">${teamTLs.length} TL${teamTLs.length!==1?'s':''} &nbsp;·&nbsp; ${tas.length} agent${tas.length!==1?'s':''}</div>
              </div>
              <div class="flex gap-8">
                <button class="btn btn-ghost btn-sm" data-perf-team="${t.id}">📊 Stats</button>
                <button class="btn btn-ghost btn-sm" data-edit-team="${t.id}">Edit</button>
                <button class="btn btn-danger btn-sm" data-del-team="${t.id}">Delete</button>
              </div>
            </div>
            <div class="tbl-wrap"><table>
              <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Target (AED/mo)</th><th></th></tr></thead>
              <tbody>
                ${teamTLs.length===0 && tas.length===0 ? '<tr><td colspan="5" class="td-dim" style="text-align:center">No members assigned yet</td></tr>' : ''}
                ${teamTLs.map(tl => {
                  const tlAgents  = tas.filter(a => a.tlId === tl.id);
                  const liveAuto  = calculateTLTarget(tl.id, users);
                  const src       = tl.targetSource || 'auto';
                  const display   = src === 'override' ? (tl.monthlyTarget||0) : liveAuto;
                  const pillStyle = src === 'override'
                    ? 'background:rgba(245,158,11,0.15);color:#f59e0b'
                    : 'background:rgba(128,128,128,0.12);color:#888';
                  const tlSt = perfStats(tlAgents.map(a=>a.id));
                  return `<tr style="background:rgba(124,58,237,0.05)">
                    <td><strong>${esc(tl.name)}</strong></td>
                    <td><span class="role-pill team_lead" style="font-size:10px">Team Lead</span></td>
                    <td class="td-dim">${esc(tl.email)}</td>
                    <td class="td-dim">AED ${display.toLocaleString()} <span style="font-size:9px;padding:1px 6px;border-radius:10px;margin-left:4px;${pillStyle}">${src==='override'?'Override':'Auto'}</span></td>
                    <td class="flex gap-8">
                      <button class="btn btn-ghost btn-xs" data-perf-user="${tl.id}">📊</button>
                      <button class="btn btn-ghost btn-xs" data-edit-user="${tl.id}">Edit</button>
                      <button class="btn btn-danger btn-xs" data-hard-del-user="${tl.id}">Delete</button>
                    </td>
                  </tr>
                  <tr id="perf-user-${tl.id}" style="display:none"><td colspan="5" style="padding:0 0 4px"><div class="perf-inline">
                    <div class="text-dim text-xs" style="margin-bottom:8px">Sub-group: ${tlAgents.length} agent${tlAgents.length!==1?'s':''}</div>
                    ${perfHtml(tlSt)}
                  </div></td></tr>
                  ${tlAgents.map(a=>{
                    const aSt = perfStats([a.id]);
                    return `<tr>
                    <td style="padding-left:28px"><span style="color:var(--t2);margin-right:4px">↳</span>${esc(a.name)}</td>
                    <td><span class="role-pill agent" style="font-size:10px">Agent</span></td>
                    <td class="td-dim">${esc(a.email)}</td>
                    <td class="td-dim">${a.monthlyTarget?'AED '+Number(a.monthlyTarget).toLocaleString():'—'}</td>
                    <td class="flex gap-8">
                      <button class="btn btn-ghost btn-xs" data-perf-user="${a.id}">📊</button>
                      <button class="btn btn-ghost btn-xs" data-edit-user="${a.id}">Edit</button>
                      <button class="btn btn-danger btn-xs" data-del-user="${a.id}">Remove</button>
                      <button class="btn btn-danger btn-xs" data-hard-del-user="${a.id}">Delete</button>
                    </td>
                  </tr>
                  <tr id="perf-user-${a.id}" style="display:none"><td colspan="5" style="padding:0 0 4px 28px"><div class="perf-inline">
                    ${perfHtml(aSt)}
                  </div></td></tr>`;
                  }).join('')}`;
                }).join('')}
                ${unassignedAgs.length > 0 ? `
                  <tr style="background:rgba(245,158,11,0.05)">
                    <td colspan="5" class="td-dim text-xs" style="padding:5px 12px;font-style:italic">⚠ Unassigned Agents (no TL)</td>
                  </tr>
                  ${unassignedAgs.map(a=>{
                    const aSt = perfStats([a.id]);
                    return `<tr>
                    <td style="padding-left:28px">${esc(a.name)}</td>
                    <td><span class="role-pill agent" style="font-size:10px">Agent</span></td>
                    <td class="td-dim">${esc(a.email)}</td>
                    <td class="td-dim">${a.monthlyTarget?'AED '+Number(a.monthlyTarget).toLocaleString():'—'}</td>
                    <td class="flex gap-8">
                      <button class="btn btn-ghost btn-xs" data-perf-user="${a.id}">📊</button>
                      <button class="btn btn-ghost btn-xs" data-edit-user="${a.id}">Edit</button>
                      <button class="btn btn-danger btn-xs" data-del-user="${a.id}">Remove</button>
                      <button class="btn btn-danger btn-xs" data-hard-del-user="${a.id}">Delete</button>
                    </td>
                  </tr>
                  <tr id="perf-user-${a.id}" style="display:none"><td colspan="5" style="padding:0 0 4px 28px"><div class="perf-inline">
                    ${perfHtml(aSt)}
                  </div></td></tr>`;
                  }).join('')}` : ''}
              </tbody>
            </table></div>
            <div class="perf-section" id="perf-team-${t.id}" style="display:none">
              ${perfHtml(perfStats(tas.map(a=>a.id)))}
              ${tas.length > 0 ? `<div class="tbl-wrap mt-12"><table>
                <thead><tr><th>Agent</th><th>Total</th><th>Open</th><th>Closed</th><th>Lost</th><th>Win Rate</th><th>AED Closed</th></tr></thead>
                <tbody>${tas.map(a=>{const st=perfStats([a.id]);return `<tr>
                  <td>${esc(a.name)}</td><td>${st.total}</td><td>${st.open}</td>
                  <td class="text-ok">${st.won}</td><td class="text-err">${st.lost}</td>
                  <td>${st.rate}%</td>
                  <td class="td-dim">${st.val?'AED '+Number(st.val).toLocaleString():'—'}</td>
                </tr>`;}).join('')}</tbody>
              </table></div>` : '<p class="text-dim text-xs mt-8">No agents in this team yet.</p>'}
            </div>
          </div>`;
        }).join('')
    }
    </div>

    <div class="card">
      <div class="card-hdr">
        <div class="card-title">🏢 Companies <span class="text-dim text-sm">(${companies.length})</span></div>
      </div>
      ${companies.length===0
        ? `<div class="empty"><div class="empty-icon">🏢</div><div class="empty-title">No companies yet</div><div class="empty-sub">Companies are created automatically as leads are added, or via the backfill above.</div></div>`
        : `<div class="tbl-wrap"><table>
            <thead><tr><th>Name</th><th>Industry</th><th>City</th><th>du Account</th><th>Leads</th><th></th></tr></thead>
            <tbody>
              ${companies.filter(c=>!c.mergedInto).map(c => `<tr>
                <td><strong>${esc(c.name)}</strong></td>
                <td class="td-dim">${esc(c.industry||'—')}</td>
                <td class="td-dim">${esc(c.city||'—')}</td>
                <td>${c.hasDuAccount ? '<span class="text-ok">Yes</span>' : '<span class="text-dim">No</span>'}</td>
                <td class="td-dim">${companyLeadCount[c.id]||0}</td>
                <td><button class="btn btn-ghost btn-xs" data-edit-company="${c.id}">Edit</button></td>
              </tr>`).join('')}
            </tbody>
          </table></div>`}
    </div>

    ${(()=>{
      const unassigned = [...tls,...ags].filter(u=>!u.teamId);
      if(!unassigned.length) return '';
      return `<div class="card"><div class="card-hdr"><div class="card-title" style="color:var(--amber)">⚠ Unassigned Members</div></div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Name</th><th>Role</th><th>Email</th><th></th></tr></thead>
          <tbody>
            ${unassigned.map(u=>`<tr>
              <td>${esc(u.name)}</td>
              <td><span class="role-pill ${u.role}" style="font-size:10px">${u.role==='team_lead'?'Team Lead':'Agent'}</span></td>
              <td class="td-dim">${esc(u.email)}</td>
              <td class="flex gap-8">
                <button class="btn btn-ghost btn-xs" data-edit-user="${u.id}">Edit</button>
                <button class="btn btn-danger btn-xs" data-del-user="${u.id}">Remove</button>
                <button class="btn btn-danger btn-xs" data-hard-del-user="${u.id}">Delete</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
    })()}
  `;

  // Button events
  ct.querySelector('#btn-add-team')?.addEventListener('click', () => showAddTeamModal(teams, tls));
  ct.querySelector('#btn-add-tl')?.addEventListener('click',   () => showAddUserModal('team_lead', teams, users));
  ct.querySelector('#btn-add-ag')?.addEventListener('click',   () => showAddUserModal('agent', teams, users));
  ct.querySelector('#btn-repair')?.addEventListener('click',   () => repairLeadTeamData(needsRepair, byId));
  ct.querySelector('#btn-backfill-companies')?.addEventListener('click', () => runCompanyBackfill(needsCompanyBackfill));
  ct.querySelector('#btn-orgid-migration')?.addEventListener('click', () => runOrgIdMigration());
  ct.querySelectorAll('[data-edit-company]').forEach(b => b.addEventListener('click', () => showEditCompanyModal(b.dataset.editCompany, companies)));

  ct.querySelectorAll('[data-edit-team]').forEach(b => b.addEventListener('click', () => showEditTeamModal(b.dataset.editTeam, teams, tls, ags)));
  ct.querySelectorAll('[data-del-team]').forEach(b  => b.addEventListener('click', () => {
    const t = teamById[b.dataset.delTeam];
    confirmModal(`Delete "${t?.name}"?`,
      'Members will become unassigned. Leads are not deleted.',
      async () => {
        const ms = await getDocs(query(collection(db,'users'), where('teamId','==',b.dataset.delTeam)));
        const bat = newBatch();
        ms.docs.forEach(d => {
          const fields = {teamId:null};
          if(d.data().role==='agent') fields.tlId = null;
          batchUpdate(bat, 'users', d.id, fields);
        });
        batchDelete(bat, 'teams', b.dataset.delTeam);
        await bat.commit();
        closeModal(); toast('Team deleted.','info'); renderOrgTab();
      });
  }));
  ct.querySelectorAll('[data-perf-team]').forEach(b => b.addEventListener('click', () => {
    const el = document.getElementById(`perf-team-${b.dataset.perfTeam}`);
    if(!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : '';
    b.textContent = open ? '📊 Stats' : '▲ Hide Stats';
  }));
  ct.querySelectorAll('[data-perf-user]').forEach(b => b.addEventListener('click', () => {
    const el = document.getElementById(`perf-user-${b.dataset.perfUser}`);
    if(!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : '';
    b.textContent = open ? '📊' : '▲';
  }));
  ct.querySelectorAll('[data-edit-user]').forEach(b => b.addEventListener('click', () => showEditUserModal(b.dataset.editUser, users, teams)));
  ct.querySelectorAll('[data-del-user]').forEach(b  => b.addEventListener('click', () => {
    const u = byId[b.dataset.delUser];
    confirmModal(`Remove "${u?.name}"?`,
      'Their leads will remain but become unassigned from this member. Their login will be deactivated.',
      async () => {
        const delId = b.dataset.delUser;
        // department cleared alongside teamId/tlId (ARCHITECTURE.md audit item
        // 15) — otherwise a deactivated backend agent keeps isActiveBackend()
        // rule access via a stale department field even after soft-removal.
        await dbUpdate('users', delId, {active:false,teamId:null,tlId:null,department:null});
        if(u?.tlId){
          const sibs = users.filter(x=>x.role==='agent'&&x.tlId===u.tlId&&x.active!==false&&x.id!==delId);
          const newAuto = sibs.reduce((s,x)=>s+(Number(x.monthlyTarget)||0),0);
          await dbUpdate('users', u.tlId, {autoTarget:newAuto});
        }
        // Unassign their leads so they don't silently vanish from team pipeline views
        const orphSnap = await getDocs(query(collection(db,'leads'),where('assignedTo','==',delId)));
        if(!orphSnap.empty){
          const bat2 = newBatch();
          orphSnap.docs.forEach(ld => {
            batchUpdate(bat2, 'leads', ld.id, {
              assignedTo:'', tlId:'',
              history:[...(ld.data().history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:`Unassigned — ${u?.name||'member'} removed from team` }]
            });
          });
          await bat2.commit();
        }
        closeModal(); toast('Member removed.','info'); renderOrgTab();
      });
  }));

  ct.querySelectorAll('[data-hard-del-user]').forEach(b => b.addEventListener('click', () => {
    const u = byId[b.dataset.hardDelUser]; if(!u) return;
    const isTL = u.role === 'team_lead';
    const warnMsg = isTL
      ? 'This cannot be undone. Their agents will become unassigned (no TL) but stay in the team. The login will stop working immediately.'
      : 'This cannot be undone. Their leads will become unassigned. The login will stop working immediately.';
    confirmModal(`Permanently delete "${esc(u.name)}"?`, warnMsg, async () => {
      const delId = u.id;
      const bat = newBatch();

      if(isTL){
        const orphanedAgents = users.filter(x => x.role==='agent' && x.tlId===delId);
        orphanedAgents.forEach(a => batchUpdate(bat, 'users', a.id, {tlId:null}));
        const tlLeadsSnap = await getDocs(query(collection(db,'leads'), where('tlId','==',delId)));
        tlLeadsSnap.docs.forEach(ld => batchUpdate(bat, 'leads', ld.id, {tlId:''}));
      } else {
        if(u.tlId){
          const sibs = users.filter(x=>x.role==='agent'&&x.tlId===u.tlId&&x.active!==false&&x.id!==delId);
          const newAuto = sibs.reduce((s,x)=>s+(Number(x.monthlyTarget)||0),0);
          batchUpdate(bat, 'users', u.tlId, {autoTarget:newAuto});
        }
        const orphSnap = await getDocs(query(collection(db,'leads'), where('assignedTo','==',delId)));
        orphSnap.docs.forEach(ld => batchUpdate(bat, 'leads', ld.id, {
          assignedTo:'', tlId:'',
          history:[...(ld.data().history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:`Unassigned — ${u.name} deleted` }]
        }));
      }

      batchDelete(bat, 'users', delId);
      await bat.commit();
      closeModal(); toast(`${isTL?'Team Lead':'Agent'} deleted.`,'info'); renderOrgTab();
    }, true);
  }));
}

// ─── ADD TEAM ───
function showAddTeamModal(teams, tls){
  modal('Create New Team', `
    <div class="field"><label>Team Name</label><input type="text" id="at-name" placeholder="e.g. Dubai SME Team"></div>
    <div class="row2">
      <div class="field"><label>Department</label>
        <select id="at-dept"><option value="sales">Sales</option><option value="backend">Backend</option></select>
      </div>
      <div class="field" id="at-mode-wrap" style="display:none">
        <label>Assignment Mode</label>
        <select id="at-mode"><option value="manual">Manual</option><option value="auto">Auto</option></select>
      </div>
    </div>
    <p class="text-dim text-xs" style="margin-bottom:14px">To assign Team Leads, edit each TL's profile and set their Team field to this team.</p>
    <p id="at-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="at-btn">Create Team</button>`);
  document.getElementById('at-dept').onchange = function(){
    document.getElementById('at-mode-wrap').style.display = this.value==='backend' ? '' : 'none';
  };
  document.getElementById('at-btn').onclick = async () => {
    const name = v('at-name');
    const dept = v('at-dept')||'sales';
    const err  = document.getElementById('at-err');
    if(!name){ err.textContent='Team name is required.'; return; }
    disable('at-btn','Creating…');
    try {
      await dbAdd('teams', {
        name, teamLeadId:null, permissions:[], department:dept,
        ...(dept==='backend' ? {assignmentMode: v('at-mode')||'manual'} : {})
      });
      closeModal(); toast('Team created.'); renderOrgTab();
    } catch(e){ err.textContent=e.message; enable('at-btn','Create Team'); }
  };
}

// ─── EDIT TEAM ───
function showEditTeamModal(teamId, teams, tls, ags){
  const t = teams.find(x=>x.id===teamId); if(!t) return;
  const dept = t.department||'sales';
  modal(`Edit Team: ${esc(t.name)}`, `
    <div class="field"><label>Team Name</label><input type="text" id="et-name" value="${esc(t.name)}"></div>
    <div class="row2">
      <div class="field"><label>Department</label>
        <select id="et-dept">
          <option value="sales" ${dept==='sales'?'selected':''}>Sales</option>
          <option value="backend" ${dept==='backend'?'selected':''}>Backend</option>
        </select>
      </div>
      <div class="field" id="et-mode-wrap" style="${dept!=='backend'?'display:none':''}">
        <label>Assignment Mode</label>
        <select id="et-mode">
          <option value="manual" ${(t.assignmentMode||'manual')==='manual'?'selected':''}>Manual</option>
          <option value="auto" ${t.assignmentMode==='auto'?'selected':''}>Auto</option>
        </select>
      </div>
    </div>
    <p class="text-dim text-xs" style="margin-bottom:14px">To reassign Team Leads, edit the TL's profile and change their Team field.</p>
    ${permissionChecklistHtml('et-perm', t.permissions||[])}
    <p class="text-dim text-xs" style="margin-bottom:14px">Granted here apply to every member of this team. Individual members can also be granted permissions directly on their own profile.</p>
    <p id="et-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="et-btn">Save Changes</button>`);
  wirePermissionSearch('et-perm');
  document.getElementById('et-dept').onchange = function(){
    document.getElementById('et-mode-wrap').style.display = this.value==='backend' ? '' : 'none';
  };
  document.getElementById('et-btn').onclick = async () => {
    const name    = v('et-name');
    const newDept = v('et-dept')||'sales';
    const err     = document.getElementById('et-err');
    if(!name){ err.textContent='Name required.'; return; }
    disable('et-btn','Saving…');
    try {
      const upd = {
        name, permissions:getSelectedPermissions('et-perm'), department:newDept,
        ...(newDept==='backend' ? {assignmentMode: v('et-mode')||'manual'} : {})
      };
      const bat = newBatch();
      batchUpdate(bat, 'teams', teamId, upd);
      // users.department is denormalized from their team's department (like
      // teamId/tlId elsewhere) — cascade so members don't go stale if a team's
      // department changes after they were assigned.
      if(newDept !== dept){
        [...tls, ...ags].filter(m => m.teamId===teamId).forEach(m => {
          batchUpdate(bat, 'users', m.id, {department:newDept});
        });
      }
      await bat.commit();
      closeModal(); toast('Team updated.'); renderOrgTab();
    } catch(e){ err.textContent=e.message; enable('et-btn','Save Changes'); }
  };
}

// ─── ADD USER ───
function showAddUserModal(role, teams, users=[]){
  const label   = role==='team_lead' ? 'Team Lead' : 'Sales Agent';
  const isAgent = role === 'agent';
  modal(`Add ${label}`, `
    <div class="row2">
      <div class="field"><label>Full Name</label><input type="text" id="au-name" placeholder="Jane Smith"></div>
      <div class="field"><label>Email Address</label><input type="email" id="au-email" placeholder="jane@company.com"></div>
    </div>
    <div class="field"><label>Temporary Password <span class="text-dim">(min 8 chars)</span></label><input type="password" id="au-pw" placeholder="••••••••"></div>
    <div class="field"><label>Assign to Team <span class="text-dim">(optional)</span></label>
      <select id="au-team"><option value="">— Assign later —</option>
        ${teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    ${isAgent ? `
    <div class="field"><label>Monthly Revenue Target (AED)</label><input type="number" id="au-target" placeholder="e.g. 50000"></div>
    <div class="field" id="au-tl-wrap" style="display:none">
      <label>Assign to Team Lead <span class="text-dim">(optional)</span></label>
      <select id="au-tl"><option value="">— Unassigned —</option></select>
    </div>
    <div class="field" id="au-backend-wrap" style="display:none">
      <label>Specialties <span class="text-dim">(leave empty = generalist, handles anything)</span></label>
      <div class="flex gap-12" style="flex-wrap:wrap">
        ${PRODUCT_CATEGORIES.map(c=>`<label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer">
          <input type="checkbox" class="au-specialty" value="${c}" style="width:auto;margin:0;cursor:pointer">${c}
        </label>`).join('')}
      </div>
      <div class="flex gap-8 mt-8">
        <input type="checkbox" id="au-available" checked style="width:auto;margin:0;cursor:pointer">
        <label for="au-available" style="margin:0;cursor:pointer">Available for assignment</label>
      </div>
    </div>` : ''}
    <p id="au-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="au-btn">Create ${label}</button>
    <p class="text-dim text-xs mt-8">They log in with this email + temp password and can change their password from settings.</p>`);

  function teamDept(tid){ return teams.find(t=>t.id===tid)?.department || 'sales'; }

  // Agent only: repopulate TL dropdown + toggle backend specialization fields when team changes
  if(isAgent){
    document.getElementById('au-team').onchange = function(){
      const tid    = this.value;
      const tlSel  = document.getElementById('au-tl');
      const tlWrap = document.getElementById('au-tl-wrap');
      document.getElementById('au-backend-wrap').style.display = tid && teamDept(tid)==='backend' ? '' : 'none';
      if(!tid){ tlWrap.style.display='none'; tlSel.innerHTML='<option value="">— Unassigned —</option>'; return; }
      const teamTLs = users.filter(u=>u.role==='team_lead'&&u.teamId===tid&&u.active!==false);
      tlSel.innerHTML = '<option value="">— Unassigned —</option>' +
        teamTLs.map(tl=>`<option value="${tl.id}">${esc(tl.name)}</option>`).join('');
      tlWrap.style.display = teamTLs.length ? '' : 'none';
    };
  }

  document.getElementById('au-btn').onclick = async () => {
    const name   = v('au-name'), email = v('au-email'), pw = v('au-pw');
    const teamId = v('au-team'), target = v('au-target');
    const err    = document.getElementById('au-err');
    if(!name||!email||!pw){ err.textContent='Name, email and password are required.'; return; }
    if(pw.length<8){ err.textContent='Password must be at least 8 characters.'; return; }
    disable('au-btn',`Creating ${label}…`);
    try {
      const cred = await createUserWithEmailAndPassword(auth2, email, pw);
      const uid  = cred.user.uid;
      await signOut(auth2);

      const isTL  = role === 'team_lead';
      const dept  = teamId ? teamDept(teamId) : null;
      const isBackendAgent = isAgent && dept==='backend';
      // New TL has no agents assigned yet (tlId = new uid, never existed before)

      const bat = newBatch();
      batchSet(bat, 'users', uid, {
        name, email, role, teamId: teamId||null, department: dept, permissions:[],
        monthlyTarget: isTL ? 0 : (Number(target)||0),
        ...(isTL
          ? { autoTarget: 0, targetSource: 'auto' }
          : { targetSource: 'manager', tlId: v('au-tl')||null }),
        ...(isBackendAgent ? {
          specialties: [...document.querySelectorAll('.au-specialty:checked')].map(c=>c.value),
          available: document.getElementById('au-available').checked
        } : {}),
        active:true, createdByName:CP.name
      });
      await bat.commit();
      closeModal(); toast(`${label} created. They can now sign in.`); renderOrgTab();
    } catch(e){
      const m = e.code==='auth/email-already-in-use' ? 'An account with this email already exists.' : e.message;
      err.textContent = m; enable('au-btn',`Create ${label}`);
    }
  };
}

// ─── EDIT USER ───
function showEditUserModal(userId, users, teams){
  const u    = users.find(x=>x.id===userId); if(!u) return;
  const isAg = u.role==='agent';
  const isTL = u.role==='team_lead';

  // Model B: TL target is sum of agents where agent.tlId === tl.id
  const freshAuto  = isTL ? calculateTLTarget(u.id, users) : 0;
  const initTLs    = isAg ? users.filter(x=>x.role==='team_lead'&&x.teamId===u.teamId&&x.active!==false) : [];
  function teamDept(tid){ return teams.find(t=>t.id===tid)?.department || 'sales'; }
  const isBackendAg = isAg && !!u.teamId && teamDept(u.teamId)==='backend';

  modal(`Edit: ${esc(u.name)}`, `
    ${u.active===false ? `<div class="locked-note" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="eu-reactivate-chk" checked style="width:auto;margin:0;cursor:pointer">
        <label for="eu-reactivate-chk" style="margin:0;cursor:pointer">⚠ This member is deactivated (removed). <strong>Reactivate on save</strong> — otherwise they'll stay invisible in team lists and assignment dropdowns even after being reassigned a team.</label>
      </div>
    </div>` : ''}
    <div class="row2">
      <div class="field"><label>Full Name</label><input type="text" id="eu-name" value="${esc(u.name)}"></div>
      <div class="field"><label>Email</label><input type="email" id="eu-email" value="${esc(u.email)}" disabled><p class="hint">Email cannot be changed after creation.</p></div>
    </div>
    <div class="field"><label>Team</label>
      <select id="eu-team"><option value="">— Unassigned —</option>
        ${teams.map(t=>`<option value="${t.id}" ${t.id===u.teamId?'selected':''}>${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    ${isAg ? `
    <div class="field"><label>Monthly Revenue Target (AED)</label><input type="number" id="eu-target" value="${u.monthlyTarget||0}"></div>
    <div class="field" id="eu-tl-wrap" ${!u.teamId?'style="display:none"':''}>
      <label>Team Lead <span class="text-dim">(optional)</span></label>
      <select id="eu-tl">
        <option value="">— Unassigned —</option>
        ${initTLs.map(tl=>`<option value="${tl.id}" ${tl.id===u.tlId?'selected':''}>${esc(tl.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field" id="eu-backend-wrap" style="${!isBackendAg?'display:none':''}">
      <label>Specialties <span class="text-dim">(leave empty = generalist, handles anything)</span></label>
      <div class="flex gap-12" style="flex-wrap:wrap">
        ${PRODUCT_CATEGORIES.map(c=>`<label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer">
          <input type="checkbox" class="eu-specialty" value="${c}" ${(u.specialties||[]).includes(c)?'checked':''} style="width:auto;margin:0;cursor:pointer">${c}
        </label>`).join('')}
      </div>
      <div class="flex gap-8 mt-8">
        <input type="checkbox" id="eu-available" ${u.available!==false?'checked':''} style="width:auto;margin:0;cursor:pointer">
        <label for="eu-available" style="margin:0;cursor:pointer">Available for assignment</label>
      </div>
    </div>` : ''}
    ${isTL ? `
    <div class="field">
      <label>Auto Target <span class="text-dim">(sum of assigned agents)</span></label>
      <input type="number" id="eu-auto-target" value="${freshAuto}" disabled style="opacity:0.5;cursor:not-allowed">
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:12px;margin-bottom:4px">
      <input type="checkbox" id="eu-override-chk" ${u.targetSource==='override'?'checked':''} style="width:auto;margin:0;cursor:pointer">
      <label for="eu-override-chk" style="margin:0;cursor:pointer;font-size:13px">Override target manually</label>
    </div>
    <div class="field" id="eu-override-field" style="${u.targetSource!=='override'?'display:none':''}">
      <label>Override Amount (AED)</label>
      <input type="number" id="eu-override-val" value="${u.targetSource==='override'?(u.monthlyTarget||0):freshAuto}" placeholder="e.g. 150000">
    </div>` : ''}
    ${permissionChecklistHtml('eu-perm', u.permissions||[])}
    <p class="text-dim text-xs" style="margin-bottom:14px">Granted here apply to this member only, in addition to anything granted to their whole team.</p>
    <p id="eu-err" class="err"></p>
    <div class="flex gap-8 mt-12">
      <button class="btn btn-primary" id="eu-save">Save Changes</button>
      <button class="btn btn-ghost btn-sm" id="eu-reset">Send Password Reset Email</button>
    </div>
    <p class="text-dim text-xs mt-8">Last edited by ${u.lastEditedBy||'—'} · ${u.lastEditedAt ? fmtDate(u.lastEditedAt) : '—'}</p>`);

  wirePermissionSearch('eu-perm');

  // Wire override checkbox → show/hide override amount field
  if(isTL){
    document.getElementById('eu-override-chk').onchange = function(){
      document.getElementById('eu-override-field').style.display = this.checked ? '' : 'none';
    };
  }

  // Agent: repopulate TL dropdown + toggle backend specialization fields when team changes
  if(isAg){
    document.getElementById('eu-team').onchange = function(){
      const tid    = this.value;
      const tlSel  = document.getElementById('eu-tl');
      const tlWrap = document.getElementById('eu-tl-wrap');
      document.getElementById('eu-backend-wrap').style.display = tid && teamDept(tid)==='backend' ? '' : 'none';
      if(!tid){ tlWrap.style.display='none'; tlSel.innerHTML='<option value="">— Unassigned —</option>'; return; }
      const teamTLs = users.filter(x=>x.role==='team_lead'&&x.teamId===tid&&x.active!==false);
      tlSel.innerHTML = '<option value="">— Unassigned —</option>' +
        teamTLs.map(tl=>`<option value="${tl.id}">${esc(tl.name)}</option>`).join('');
      tlWrap.style.display = '';
    };
  }

  document.getElementById('eu-save').onclick = async () => {
    const name   = v('eu-name'), teamId = v('eu-team');
    const err    = document.getElementById('eu-err');
    if(!name){ err.textContent='Name is required.'; return; }

    if(isTL && document.getElementById('eu-override-chk').checked && v('eu-override-val')===''){
      err.textContent='Please enter an override amount.'; return;
    }

    disable('eu-save','Saving…');
    try {
      const newDept = teamId ? teamDept(teamId) : null;
      const upd = {name, teamId:teamId||null, department:newDept, permissions:getSelectedPermissions('eu-perm')};
      if(u.active===false){
        upd.active = !!document.getElementById('eu-reactivate-chk')?.checked;
      }

      if(isAg){
        const newTlId      = v('eu-tl')||null;
        upd.monthlyTarget  = Number(v('eu-target'))||0;
        upd.targetSource   = 'manager';
        upd.tlId           = newTlId;
        if(newDept==='backend'){
          upd.specialties = [...document.querySelectorAll('.eu-specialty:checked')].map(c=>c.value);
          upd.available   = document.getElementById('eu-available').checked;
        }
      }

      if(isTL){
        // Model B: TL's agents are those where agent.tlId === tl.id — team move doesn't change this
        const newAutoTarget = calculateTLTarget(u.id, users);
        const overrideChk   = document.getElementById('eu-override-chk').checked;
        const overrideVal   = Number(v('eu-override-val'))||0;
        upd.autoTarget    = newAutoTarget;
        upd.targetSource  = overrideChk ? 'override' : 'auto';
        upd.monthlyTarget = overrideChk ? overrideVal : newAutoTarget;
      }

      const bat = newBatch();
      batchUpdate(bat, 'users', userId, upd);

      // Agent saved → cascade autoTarget to old TL and new TL
      if(isAg){
        const oldTlId  = u.tlId||null;
        const newTlId  = upd.tlId;
        const affected = new Set([oldTlId, newTlId].filter(Boolean));
        for(const tlIdAffected of affected){
          const tl = users.find(x => x.id===tlIdAffected && x.active!==false);
          if(!tl) continue;
          // Recompute from snapshot: exclude this agent, add back with new target on new TL
          const tlAuto = users
            .filter(x => x.role==='agent' && x.tlId===tlIdAffected && x.id!==userId && x.active!==false)
            .reduce((s,x) => s + (Number(x.monthlyTarget)||0), 0)
            + (tlIdAffected===newTlId ? (Number(upd.monthlyTarget)||0) : 0);
          const tlUpd = {autoTarget:tlAuto};
          if(tl.targetSource !== 'override') tlUpd.monthlyTarget = tlAuto;
          batchUpdate(bat, 'users', tl.id, tlUpd);
        }
      }

      await bat.commit();
      closeModal(); toast('Profile updated.'); renderOrgTab();
    } catch(e){ err.textContent=e.message; enable('eu-save','Save Changes'); }
  };

  document.getElementById('eu-reset').onclick = async () => {
    try {
      await sendPasswordResetEmail(auth, u.email);
      document.getElementById('eu-err').style.color = 'var(--green)';
      document.getElementById('eu-err').textContent = `Reset email sent to ${u.email}. Only works if that email inbox is accessible.`;
    } catch(e){ document.getElementById('eu-err').textContent = e.message; }
  };
}

// Backfill teamId/tlId on leads that predate those fields (e.g. the original
// seeded leads) — without them the TL Firestore rule's teamId match always
// fails, silently blocking TL edits/deletes on those leads.
async function repairLeadTeamData(leadsToFix, byId){
  const btn = document.getElementById('btn-repair');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Repairing…'; }
  try {
    const CHUNK = 400;
    let fixed = 0;
    for(let i = 0; i < leadsToFix.length; i += CHUNK){
      const chunk = leadsToFix.slice(i, i + CHUNK);
      const bat = newBatch();
      chunk.forEach(l => {
        const assignee = byId[l.assignedTo];
        if(!assignee) return;
        batchUpdate(bat, 'leads', l.id, { teamId: assignee.teamId||'', tlId: assignee.tlId||'' });
        fixed++;
      });
      await bat.commit();
    }
    toast(`✅ Repaired ${fixed} lead${fixed!==1?'s':''}.`);
    renderOrgTab();
  } catch(e){
    toast('Error: '+e.message,'err');
    if(btn){ btn.disabled=false; btn.textContent='🔧 Repair Lead Data'; }
  }
}

// Thin UI wrapper around companies.js's backfillCompanies() — same
// disable/toast/re-render pattern as repairLeadTeamData above.
async function runCompanyBackfill(leadsToFix){
  const btn = document.getElementById('btn-backfill-companies');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Backfilling…'; }
  try {
    const { companiesCreated, leadsUpdated } = await backfillCompanies(leadsToFix);
    toast(`✅ Created ${companiesCreated} compan${companiesCreated!==1?'ies':'y'}, linked ${leadsUpdated} lead${leadsUpdated!==1?'s':''}.`);
    renderOrgTab();
  } catch(e){
    toast('Error: '+e.message,'err');
    if(btn){ btn.disabled=false; btn.textContent='🏢 Backfill Companies'; }
  }
}

// One-off orgId stamping migration (ARCHITECTURE.md Phase A step 3). Every
// new doc gets orgId automatically now (js/db.js), but existing docs
// predate that — this backfills them across every collection so the
// sameOrg() rule doesn't lock managers/agents out of their own pre-existing
// data. skipAudit:true throughout — this is a pure schema backfill, not a
// real edit, so it must not clobber lastEditedBy/lastEditedAt on documents
// nobody actually touched.
//
// 'users' MUST be migrated LAST, not first. sameOrg() compares the acting
// manager's own orgId (via userDoc()) to each target doc's orgId. Before
// this migration runs, NOTHING has orgId, so every comparison is
// null == null -> true. But if 'users' were migrated first, the manager's
// own doc would get orgId stamped immediately — and every subsequent
// collection's check would then become "shauntech" == null -> false,
// silently locking the migration out of everything after 'users'. Doing
// 'users' last keeps the acting manager's own orgId null (consistent with
// whatever's still unmigrated) until nothing else is left to stamp.
const ORGID_MIGRATION_COLLECTIONS = ['teams','leads','companies','channels','scripts','products','submissions','users'];

async function runOrgIdMigration(){
  const btn = document.getElementById('btn-orgid-migration');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Stamping…'; }
  try {
    let stamped = 0;
    for(const collectionName of ORGID_MIGRATION_COLLECTIONS){
      const snap = await getDocs(collection(db, collectionName));
      const missing = snap.docs.filter(d => d.data().orgId !== orgId);
      const CHUNK = 400;
      for(let i=0;i<missing.length;i+=CHUNK){
        const bat = newBatch();
        missing.slice(i,i+CHUNK).forEach(d => {
          batchUpdate(bat, collectionName, d.id, {orgId}, {skipAudit:true});
          stamped++;
        });
        await bat.commit();
      }
    }
    toast(`✅ Stamped orgId on ${stamped} document${stamped!==1?'s':''}.`);
    renderOrgTab();
  } catch(e){
    toast('Error: '+e.message,'err');
    if(btn){ btn.disabled=false; btn.textContent='🏷️ Stamp orgId on Existing Data'; }
  }
}

// ─── EDIT COMPANY ───
function showEditCompanyModal(companyId, companies){
  const c = companies.find(x=>x.id===companyId); if(!c) return;
  modal(`Edit Company: ${esc(c.name)}`, `
    <div class="row2">
      <div class="field"><label>Industry</label><input type="text" id="ec-ind" value="${esc(c.industry||'')}" placeholder="e.g. Construction"></div>
      <div class="field"><label>City</label><input type="text" id="ec-cy" value="${esc(c.city||'')}" placeholder="Dubai"></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
      <input type="checkbox" id="ec-du" ${c.hasDuAccount?'checked':''} style="width:auto;margin:0;cursor:pointer">
      <label for="ec-du" style="margin:0;cursor:pointer">Has an existing du account</label>
    </div>
    <p id="ec-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="ec-btn">Save Changes</button>`);
  document.getElementById('ec-btn').onclick = async () => {
    const err = document.getElementById('ec-err');
    disable('ec-btn','Saving…');
    try {
      await dbUpdate('companies', companyId, {
        industry: v('ec-ind'), city: v('ec-cy'),
        hasDuAccount: document.getElementById('ec-du').checked
      });
      closeModal(); toast('Company updated.'); renderOrgTab();
    } catch(e){ err.textContent=e.message; enable('ec-btn','Save Changes'); }
  };
}
