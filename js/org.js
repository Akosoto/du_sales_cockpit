import {
  db, CU, CP, auth, auth2, ORG_DEFAULTS,
  collection, query, where, getDocs, doc, getDoc,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from './state.js';
import { dbAdd, dbSet, dbUpdate, newBatch, batchSet, batchUpdate, batchDelete, logBulkAudit } from './db.js';
import { v, esc, now, fmtDate, disable, enable, toast, modal, closeModal, confirmModal, calculateTLTarget } from './helpers.js';
import { permissionChecklistHtml, wirePermissionSearch, getSelectedPermissions, hasPermission } from './permissions.js';
import { fetchCompanies, backfillCompanies } from './companies.js';
import { currentCategories, categoryLabel, findCategoryIdByLabel, loadOrgConfig, DEFAULT_CATEGORIES } from './orgConfig.js';
import { buildRollupsFromSubmissions, diffRollups, blankMonth, currentFamilyResolver } from './rollups.js';
import * as storage from './storage/index.js';
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

// Shared chunked-bulk-commit helper for this file's cascades (team delete,
// member removal, hard-delete, department change) — none of these were
// chunked at all before (a single unbounded batch per cascade), which was
// already a latent bug for a large team/agent's lead count, and became a
// much easier bug to trigger once auditLog started doubling writes-per-op.
// skipAudit:true per-op + one summary entry, same pattern as db.js's
// logBulkAudit doc comment explains.
const BULK_CHUNK = 200;
async function commitBulkOps(ops, description){
  for(let i=0;i<ops.length;i+=BULK_CHUNK){
    const bat = newBatch();
    ops.slice(i,i+BULK_CHUNK).forEach(op => {
      if(op.kind==='delete') batchDelete(bat, op.collectionName, op.id, {skipAudit:true});
      else batchUpdate(bat, op.collectionName, op.id, op.data, {skipAudit:true});
    });
    await bat.commit();
  }
  if(ops.length) await logBulkAudit(description, ops.length);
}
export async function renderOrgTab(){
  const ct = document.getElementById('content');
  const [tSnap, uSnap, lSnap, companies, pSnap] = await Promise.all([
    getDocs(collection(db,'teams')),
    getDocs(collection(db,'users')),
    getDocs(collection(db,'leads')),
    fetchCompanies(),
    getDocs(collection(db,'products'))
  ]);
  const teams = tSnap.docs.map(d=>({id:d.id,...d.data()}));
  const users = uSnap.docs.map(d=>({id:d.id,...d.data()}));
  const products = pSnap.docs.map(d=>({id:d.id,...d.data()}));
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
  // Category identity migration (Session B4 Step 2) — products.category and
  // users.specialties[] used to store the display NAME directly ('Starter',
  // 'Mobile', ...); they now store the permanent id ('starter','mobile',...)
  // resolved via categoryLabel() at render time. Detected from data already
  // fetched here (no extra reads) by checking for any value that isn't one
  // of the known ids — cheap and catches both legacy labels and any
  // unexpected custom value the migration will need to flag.
  const CATEGORY_IDS = new Set(DEFAULT_CATEGORIES.map(c=>c.id));
  const needsCategoryMigration = products.some(p => p.category && !CATEGORY_IDS.has(p.category))
    || users.some(u => (u.specialties||[]).some(s => !CATEGORY_IDS.has(s)));

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
        <button class="btn btn-ghost btn-sm" id="btn-backup-export">⬇️ Backup / Export All Data</button>
        <button class="btn btn-ghost btn-sm" id="btn-recompute-rollups">🧮 Recompute Rollups</button>
        <button class="btn btn-ghost btn-sm" id="btn-doc-retention-sweep">🗑️ Clean up old documents</button>
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

    ${needsCategoryMigration ? `<div class="seed-banner">
      <p>Some existing product and specialty records predate the category-id refactor and still store the category as a name (e.g. "Starter") instead of its permanent id. This converts <code>products.category</code> and <code>users.specialties[]</code> to ids and creates the <code>orgs</code> config document if it doesn't exist yet — safe to re-run. Shows a preview before writing anything.</p>
      <button class="btn btn-primary btn-sm" id="btn-category-migration">🏷️ Migrate Categories to IDs</button>
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
              <td><span class="role-pill ${esc(u.role)}" style="font-size:10px">${u.role==='team_lead'?'Team Lead':'Agent'}</span></td>
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
  ct.querySelector('#btn-category-migration')?.addEventListener('click', () => showCategoryMigrationPreview());
  ct.querySelector('#btn-backup-export')?.addEventListener('click', () => runBackupExport());
  ct.querySelector('#btn-doc-retention-sweep')?.addEventListener('click', () => runDocumentRetentionSweep());
  ct.querySelector('#btn-recompute-rollups')?.addEventListener('click', () => showRecomputeRollupsModal());
  ct.querySelectorAll('[data-edit-company]').forEach(b => b.addEventListener('click', () => showEditCompanyModal(b.dataset.editCompany, companies, users)));

  ct.querySelectorAll('[data-edit-team]').forEach(b => b.addEventListener('click', () => showEditTeamModal(b.dataset.editTeam, teams, tls, ags)));
  ct.querySelectorAll('[data-del-team]').forEach(b  => b.addEventListener('click', () => {
    const t = teamById[b.dataset.delTeam];
    confirmModal(`Delete "${t?.name}"?`,
      'Members will become unassigned. Leads are not deleted.',
      async () => {
        const ms = await getDocs(query(collection(db,'users'), where('teamId','==',b.dataset.delTeam)));
        const ops = ms.docs.map(d => {
          const fields = {teamId:null};
          if(d.data().role==='agent') fields.tlId = null;
          return { kind:'update', collectionName:'users', id:d.id, data:fields };
        });
        ops.push({ kind:'delete', collectionName:'teams', id:b.dataset.delTeam });
        await commitBulkOps(ops, `Deleted team "${t?.name}" — ${ms.docs.length} member(s) unassigned`);
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
        const orphOps = orphSnap.docs.map(ld => ({
          kind:'update', collectionName:'leads', id:ld.id, data:{
            assignedTo:'', tlId:'', lastEditedBy:CP.name, lastEditedAt:now(),
            history:[...(ld.data().history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:`Unassigned — ${u?.name||'member'} removed from team` }]
          }
        }));
        await commitBulkOps(orphOps, `Removed "${u?.name}" — ${orphOps.length} lead(s) unassigned`);
        closeModal(); toast('Member removed.','info'); renderOrgTab();
      });
  }));

  ct.querySelectorAll('[data-hard-del-user]').forEach(b => b.addEventListener('click', () => {
    const u = byId[b.dataset.hardDelUser]; if(!u) return;
    const isTL = u.role === 'team_lead';
    const warnMsg = isTL
      ? 'This cannot be undone. Their agents will become unassigned (no TL) but stay in the team. The login will stop working immediately.'
      : 'This cannot be undone. Their leads will become unassigned. The login will stop working immediately.';
    confirmModal(`Permanently delete "${u.name}"?`, warnMsg, async () => {
      const delId = u.id;
      const ops = [];

      if(isTL){
        const orphanedAgents = users.filter(x => x.role==='agent' && x.tlId===delId);
        orphanedAgents.forEach(a => ops.push({ kind:'update', collectionName:'users', id:a.id, data:{tlId:null} }));
        const tlLeadsSnap = await getDocs(query(collection(db,'leads'), where('tlId','==',delId)));
        tlLeadsSnap.docs.forEach(ld => ops.push({ kind:'update', collectionName:'leads', id:ld.id, data:{tlId:'', lastEditedBy:CP.name, lastEditedAt:now()} }));
      } else {
        if(u.tlId){
          const sibs = users.filter(x=>x.role==='agent'&&x.tlId===u.tlId&&x.active!==false&&x.id!==delId);
          const newAuto = sibs.reduce((s,x)=>s+(Number(x.monthlyTarget)||0),0);
          ops.push({ kind:'update', collectionName:'users', id:u.tlId, data:{autoTarget:newAuto} });
        }
        const orphSnap = await getDocs(query(collection(db,'leads'), where('assignedTo','==',delId)));
        orphSnap.docs.forEach(ld => ops.push({ kind:'update', collectionName:'leads', id:ld.id, data:{
          assignedTo:'', tlId:'', lastEditedBy:CP.name, lastEditedAt:now(),
          history:[...(ld.data().history||[]), { ts:now(), actorId:CU.uid, actorName:CP.name, change:`Unassigned — ${u.name} deleted` }]
        }}));
      }

      ops.push({ kind:'delete', collectionName:'users', id:delId });
      await commitBulkOps(ops, `Hard-deleted ${isTL?'team lead':'agent'} "${u.name}" — ${ops.length-1} related doc(s) updated`);
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
  modal(`Edit Team: ${t.name}`, `
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
      // The team edit itself gets a normal, single, fully-audited write. The
      // member-department cascade below is handled separately through the
      // shared bulk helper (chunked + skipAudit + one summary entry) since a
      // large team could in principle exceed the 500-write batch cap.
      await dbUpdate('teams', teamId, upd);
      // users.department is denormalized from their team's department (like
      // teamId/tlId elsewhere) — cascade so members don't go stale if a team's
      // department changes after they were assigned.
      if(newDept !== dept){
        const memberOps = [...tls, ...ags].filter(m => m.teamId===teamId)
          .map(m => ({ kind:'update', collectionName:'users', id:m.id, data:{department:newDept} }));
        await commitBulkOps(memberOps, `Team "${name}" department changed to ${newDept} — ${memberOps.length} member(s) cascaded`);
      }
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
        ${currentCategories().map(c=>`<label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer">
          <input type="checkbox" class="au-specialty" value="${c.id}" style="width:auto;margin:0;cursor:pointer">${esc(c.label)}
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

  modal(`Edit: ${u.name}`, `
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
    <div class="field"><label>Monthly Revenue Target (AED)</label><input type="number" id="eu-target" value="${esc(u.monthlyTarget||0)}"></div>
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
        ${currentCategories().map(c=>`<label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer">
          <input type="checkbox" class="eu-specialty" value="${c.id}" ${(u.specialties||[]).includes(c.id)?'checked':''} style="width:auto;margin:0;cursor:pointer">${esc(c.label)}
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
      <input type="number" id="eu-override-val" value="${esc(u.targetSource==='override'?(u.monthlyTarget||0):freshAuto)}" placeholder="e.g. 150000">
    </div>` : ''}
    ${permissionChecklistHtml('eu-perm', u.permissions||[])}
    <p class="text-dim text-xs" style="margin-bottom:14px">Granted here apply to this member only, in addition to anything granted to their whole team.</p>
    <p id="eu-err" class="err"></p>
    <div class="flex gap-8 mt-12">
      <button class="btn btn-primary" id="eu-save">Save Changes</button>
      <button class="btn btn-ghost btn-sm" id="eu-reset">Send Password Reset Email</button>
    </div>
    <p class="text-dim text-xs mt-8">Last edited by ${esc(u.lastEditedBy||'—')} · ${u.lastEditedAt ? fmtDate(u.lastEditedAt) : '—'}</p>`);

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
// Step 0e-b cascade: a lead whose teamId/tlId was blank/stale at the time it
// was SUBMITTED already has that same stale value frozen onto its
// submissions (createSubmissions used to just copy lead.teamId||'' verbatim
// — fixed at the source in js/submissions.js, but that fix doesn't
// retroactively touch documents already written before it). Repairing the
// LEAD alone leaves those already-created submissions permanently invisible
// to the TL, since the TL's rule-mirrored query matches teamId. This finds
// and backfills them too.
async function repairLeadTeamData(leadsToFix, byId){
  const btn = document.getElementById('btn-repair');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Repairing…'; }
  try {
    const CHUNK = 200;
    const ID_CHUNK = 30; // Firestore 'in' operator cap
    let fixedLeads = 0;
    const teamByLeadId = {}; // leadId -> the corrected {teamId, tlId} it now has

    for(let i = 0; i < leadsToFix.length; i += CHUNK){
      const chunk = leadsToFix.slice(i, i + CHUNK);
      const bat = newBatch();
      chunk.forEach(l => {
        const assignee = byId[l.assignedTo];
        if(!assignee) return;
        const teamId = assignee.teamId||'', tlId = assignee.tlId||'';
        batchUpdate(bat, 'leads', l.id, { teamId, tlId }, {skipAudit:true});
        fixedLeads++;
        teamByLeadId[l.id] = { teamId, tlId };
      });
      await bat.commit();
    }

    // Cascade to submissions already created from these leads.
    const fixedLeadIds = Object.keys(teamByLeadId);
    let fixedSubs = 0;
    const staleSubDocs = [];
    if(fixedLeadIds.length){
      for(let i=0; i<fixedLeadIds.length; i+=ID_CHUNK){
        const snap = await getDocs(query(collection(db,'submissions'), where('leadId','in',fixedLeadIds.slice(i,i+ID_CHUNK))));
        staleSubDocs.push(...snap.docs);
      }
      for(let i=0; i<staleSubDocs.length; i+=CHUNK){
        const bat = newBatch();
        let touchedInChunk = false;
        staleSubDocs.slice(i,i+CHUNK).forEach(d => {
          const s = d.data();
          const correct = teamByLeadId[s.leadId];
          if(!correct || (s.teamId===correct.teamId && s.tlId===correct.tlId)) return;
          batchUpdate(bat, 'submissions', d.id, { teamId: correct.teamId, tlId: correct.tlId }, {skipAudit:true});
          fixedSubs++; touchedInChunk = true;
        });
        if(touchedInChunk) await bat.commit();
      }
    }

    // submissionDocs pages are DELIBERATELY immutable (step 4 — no update
    // rule exists at all, replacing a doc means delete + re-upload), so a
    // stale teamId on an already-stored page cannot be backfilled in place.
    // Count them for visibility instead of attempting a write that the
    // rules would reject outright — a TL-invisible page here self-corrects
    // the next time that document type is replaced (Fix & Resubmit).
    let staleDocPages = 0;
    const affectedBundleIds = [...new Set(staleSubDocs.map(d=>d.data().bundleId))];
    if(affectedBundleIds.length){
      for(let i=0; i<affectedBundleIds.length; i+=ID_CHUNK){
        const snap = await getDocs(query(collection(db,'submissionDocs'), where('bundleId','in',affectedBundleIds.slice(i,i+ID_CHUNK))));
        snap.docs.forEach(d => {
          const sub = staleSubDocs.find(s => s.data().bundleId === d.data().bundleId);
          const correct = sub && teamByLeadId[sub.data().leadId];
          if(correct && d.data().teamId !== correct.teamId) staleDocPages++;
        });
      }
    }

    const total = fixedLeads + fixedSubs;
    if(total) await logBulkAudit(`Repaired team data: ${fixedLeads} lead(s), ${fixedSubs} submission(s)${staleDocPages?`; ${staleDocPages} submissionDocs page(s) left as-is (immutable)`:''}`, total);
    toast(`✅ Repaired ${fixedLeads} lead${fixedLeads!==1?'s':''}, ${fixedSubs} submission${fixedSubs!==1?'s':''}.${staleDocPages?` ${staleDocPages} document page(s) still carry the old team tag — immutable, will self-correct if replaced.`:''}`);
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
      const CHUNK = 200;
      for(let i=0;i<missing.length;i+=CHUNK){
        const bat = newBatch();
        missing.slice(i,i+CHUNK).forEach(d => {
          batchUpdate(bat, collectionName, d.id, {orgId}, {skipAudit:true});
          stamped++;
        });
        await bat.commit();
      }
    }
    if(stamped) await logBulkAudit(`orgId migration: stamped ${stamped} document(s)`, stamped);
    toast(`✅ Stamped orgId on ${stamped} document${stamped!==1?'s':''}.`);
    renderOrgTab();
  } catch(e){
    toast('Error: '+e.message,'err');
    if(btn){ btn.disabled=false; btn.textContent='🏷️ Stamp orgId on Existing Data'; }
  }
}

// Category identity migration (Session B4 Step 2, ARCHITECTURE.md §12) —
// one-time conversion of products.category and users.specialties[] from
// display-name strings to the new permanent category ids (js/orgConfig.js).
// findCategoryIdByLabel() does the name->id lookup; any value that matches
// neither a known id nor a known label is left untouched and surfaced as a
// warning in the preview rather than silently dropped or guessed at.
async function computeCategoryMigrationPlan(){
  const CATEGORY_IDS = new Set(DEFAULT_CATEGORIES.map(c=>c.id));
  const [pSnap, uSnap] = await Promise.all([
    getDocs(collection(db,'products')),
    getDocs(collection(db,'users'))
  ]);
  const products = pSnap.docs.map(d=>({id:d.id,...d.data()}));
  const users    = uSnap.docs.map(d=>({id:d.id,...d.data()}));

  const productOps = [], unmappedProducts = [];
  products.forEach(p => {
    if(!p.category || CATEGORY_IDS.has(p.category)) return;
    const id = findCategoryIdByLabel(p.category);
    if(id) productOps.push({ id:p.id, name:p.name, from:p.category, to:id });
    else unmappedProducts.push({ id:p.id, name:p.name, value:p.category });
  });

  const userOps = [], unmappedSpecialties = [];
  users.forEach(u => {
    const specs = u.specialties || [];
    if(!specs.length) return;
    let changed = false;
    const to = specs.map(s => {
      if(CATEGORY_IDS.has(s)) return s;
      const id = findCategoryIdByLabel(s);
      if(id){ changed = true; return id; }
      unmappedSpecialties.push({ id:u.id, name:u.name, value:s });
      return s;
    });
    if(changed) userOps.push({ id:u.id, name:u.name, from:specs, to });
  });

  // orgs/{orgId} has no published rule yet as of Step 2 — it ships in Step
  // 8 (PAUSE POINT). A denied read here just means "doesn't exist / not
  // reachable yet", same fallback loadOrgConfig() already uses — this must
  // not block the product/user conversion below, which doesn't depend on it.
  let orgDocExists = false;
  try { orgDocExists = (await getDoc(doc(db,'orgs',orgId))).exists(); } catch(e){ /* rule not published yet — treat as not-existing */ }
  return { productOps, userOps, unmappedProducts, unmappedSpecialties, orgDocExists };
}

function showCategoryMigrationPreview(){
  const box = document.getElementById('content');
  const btn = document.getElementById('btn-category-migration');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Computing preview…'; }
  computeCategoryMigrationPlan().then(plan => {
    if(btn){ btn.disabled = false; btn.textContent = '🏷️ Migrate Categories to IDs'; }
    const { productOps, userOps, unmappedProducts, unmappedSpecialties, orgDocExists } = plan;
    const rows = (list, cols) => list.length
      ? `<div class="tbl-wrap"><table><tbody>${list.map(cols).join('')}</tbody></table></div>`
      : '<p class="text-dim" style="font-size:.85rem">None.</p>';
    modal('Migrate Categories to IDs — Preview', `
      <p class="text-dim" style="margin-bottom:12px">Dry run only — nothing has been written yet.</p>
      ${orgDocExists ? '' : '<p><strong>orgs</strong> config document does not exist yet — will attempt to create it with the default category list (no-op until its Firestore rule ships in Step 8; the app already works off defaults either way).</p>'}
      <p style="margin-top:12px"><strong>Products to convert (${productOps.length})</strong></p>
      ${rows(productOps, o=>`<tr><td>${esc(o.name)}</td><td class="td-dim">${esc(o.from)} → ${esc(o.to)}</td></tr>`)}
      <p style="margin-top:12px"><strong>Users with specialties to convert (${userOps.length})</strong></p>
      ${rows(userOps, o=>`<tr><td>${esc(o.name)}</td><td class="td-dim">${esc(o.from.join(', '))} → ${esc(o.to.join(', '))}</td></tr>`)}
      ${unmappedProducts.length ? `<p style="margin-top:12px;color:var(--amber)"><strong>⚠ Unrecognized product categories (left as-is, ${unmappedProducts.length})</strong></p>
        ${rows(unmappedProducts, o=>`<tr><td>${esc(o.name)}</td><td class="td-dim">${esc(o.value)}</td></tr>`)}` : ''}
      ${unmappedSpecialties.length ? `<p style="margin-top:12px;color:var(--amber)"><strong>⚠ Unrecognized specialty values (left as-is, ${unmappedSpecialties.length})</strong></p>
        ${rows(unmappedSpecialties, o=>`<tr><td>${esc(o.name)}</td><td class="td-dim">${esc(o.value)}</td></tr>`)}` : ''}
      <div class="flex gap-8 mt-12">
        <button class="btn btn-primary" id="btn-category-migration-run" ${(productOps.length||userOps.length||!orgDocExists)?'':'disabled'}>Run Migration</button>
        <button class="btn btn-ghost" onclick="document.getElementById('modal').style.display='none'">Cancel</button>
      </div>`, true);
    document.getElementById('btn-category-migration-run').onclick = () => runCategoryMigration(plan);
  }).catch(e => {
    if(btn){ btn.disabled = false; btn.textContent = '🏷️ Migrate Categories to IDs'; }
    toast('Error: '+e.message,'err');
  });
}

async function runCategoryMigration(plan){
  const runBtn = document.getElementById('btn-category-migration-run');
  if(runBtn){ runBtn.disabled = true; runBtn.textContent = '⏳ Migrating…'; }
  try {
    const { productOps, userOps, orgDocExists } = plan;
    // skipAudit: pure schema backfill (same reasoning as runOrgIdMigration
    // above), summarized in one logBulkAudit entry instead of per-doc.
    // Best-effort: orgs/{orgId} rules ship in Step 8, not this step — if the
    // write is denied because that rule doesn't exist yet, the app already
    // falls back to DEFAULT_CATEGORIES (js/orgConfig.js), so this must not
    // block the product/user conversion below. Re-running this migration
    // after Step 8 publishes the rule will create the doc then.
    let orgDocWritten = orgDocExists;
    if(!orgDocExists){
      try { await dbSet('orgs', orgId, { categories: DEFAULT_CATEGORIES }, {skipAudit:true}); orgDocWritten = true; }
      catch(e){ /* orgs rules not published yet (Step 8) — defaults still apply */ }
    }

    let converted = 0;
    const CHUNK = 200;
    const allOps = [
      ...productOps.map(o => ({ collectionName:'products', id:o.id, data:{ category:o.to } })),
      ...userOps.map(o => ({ collectionName:'users', id:o.id, data:{ specialties:o.to } }))
    ];
    for(let i=0;i<allOps.length;i+=CHUNK){
      const bat = newBatch();
      allOps.slice(i,i+CHUNK).forEach(op => {
        batchUpdate(bat, op.collectionName, op.id, op.data, {skipAudit:true});
        converted++;
      });
      await bat.commit();
    }
    const orgDocPending = !orgDocExists && !orgDocWritten;
    const auditNote = orgDocExists ? '' : (orgDocWritten ? '; created orgs config' : '; orgs config not created — rules pending (Step 8)');
    if(converted || orgDocWritten) await logBulkAudit(`Category migration: converted ${converted} document(s)${auditNote}`, converted);
    closeModal();
    toast(`✅ Migrated ${converted} document${converted!==1?'s':''} to category ids.${orgDocPending?' orgs config not yet created (Step 8).':''}`);
    await loadOrgConfig();
    renderOrgTab();
  } catch(e){
    toast('Error: '+e.message,'err');
    if(runBtn){ runBtn.disabled = false; runBtn.textContent = 'Run Migration'; }
  }
}

// Every org-scoped collection, backed up into one timestamped JSON file
// (ARCHITECTURE.md §0/§10 — prerequisite for every future migration/import,
// originally scoped to precede the orgId migration; built after the fact
// since that migration already ran and is verified safe).
const BACKUP_COLLECTIONS = ['users','teams','leads','companies','channels','scripts','products','submissions','auditLog'];

async function runBackupExport(){
  const btn = document.getElementById('btn-backup-export');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
  try {
    const data = {};
    for(const collectionName of BACKUP_COLLECTIONS){
      const snap = await getDocs(query(collection(db, collectionName), where('orgId','==',orgId)));
      data[collectionName] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const payload = { exportedAt: now(), exportedBy: CP.name, orgId, data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${orgId}-backup-${now().replace(/[:.]/g,'-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Backup downloaded.');
  } catch(e){
    toast('Error: '+e.message,'err');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = '⬇️ Backup / Export All Data'; }
  }
}

// Retention sweep (ARCHITECTURE.md §6) — a bundle's stored document pages are
// only safe to delete once EVERY sibling submission (every product line under
// that bundleId) is terminal (activated/rejected), and only after the
// SLOWEST sibling to go terminal has sat there for docRetentionDays. Leaves
// requiredDocs' attestation flags and expiry dates untouched — this only
// clears the stored page bytes in submissionDocs, not the submission record
// itself. Manager-only, matching the button's Org-tab-only reachability.
async function runDocumentRetentionSweep(){
  const btn = document.getElementById('btn-doc-retention-sweep');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
  try {
    const snap = await getDocs(query(collection(db,'submissions'), where('orgId','==',orgId)));
    const byBundle = {};
    snap.docs.forEach(d => { const s = d.data(); (byBundle[s.bundleId] ||= []).push(s); });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (ORG_DEFAULTS.docRetentionDays || 90));

    const qualifying = [];
    Object.entries(byBundle).forEach(([bundleId, lines]) => {
      if(!bundleId) return;
      const allTerminal = lines.every(l => l.status==='activated' || l.status==='rejected');
      if(!allTerminal) return;
      const terminalDates = lines.map(l => l.activatedAt || l.rejectedAt).filter(Boolean);
      if(terminalDates.length !== lines.length) return; // a terminal line missing its stamp — don't guess, skip until it's stamped
      const latestTerminal = terminalDates.reduce((a,b) => a>b?a:b);
      if(new Date(latestTerminal) <= cutoff) qualifying.push(bundleId);
    });

    if(!qualifying.length){
      toast('No bundles are eligible for cleanup yet.');
      return;
    }

    const pageCount = await storage.countPagesForBundles(qualifying);
    if(!pageCount){
      toast('Eligible bundles have no stored document pages left to clean up.');
      return;
    }

    confirmModal(
      `Clean up documents for ${qualifying.length} bundle${qualifying.length!==1?'s':''}?`,
      `${pageCount} document page${pageCount!==1?'s':''} across ${qualifying.length} bundle${qualifying.length!==1?'s':''} (all submissions terminal for over ${ORG_DEFAULTS.docRetentionDays||90} days) will be permanently deleted. Attestation and expiry-date fields are kept — only the stored files go. This cannot be undone.`,
      async () => {
        closeModal();
        if(btn){ btn.disabled = true; btn.textContent = '⏳ Cleaning up…'; }
        try {
          const deleted = await storage.deleteByBundles(qualifying);
          toast(`✅ Deleted ${deleted} document page${deleted!==1?'s':''} across ${qualifying.length} bundle${qualifying.length!==1?'s':''}.`);
        } catch(e){
          toast('Error: '+e.message,'err');
        } finally {
          if(btn){ btn.disabled = false; btn.textContent = '🗑️ Clean up old documents'; }
        }
      }
    );
  } catch(e){
    toast('Error: '+e.message,'err');
  } finally {
    if(btn && !btn.textContent.includes('Cleaning')){ btn.disabled = false; btn.textContent = '🗑️ Clean up old documents'; }
  }
}

// ─── RECOMPUTE ROLLUPS (reconciliation tool, ARCHITECTURE.md §15.4) ───
// The safety net for the write-time counters: rebuilds a month's (or every
// month's) rollups/{YYYY-MM} doc from raw submissions by REPLAYING each
// submission's events[] through the exact same transition logic the live
// increment sites use (js/rollups.js buildRollupsFromSubmissions), so a
// recompute is the ground truth the live counters must match. Always
// dry-runs first — reports per-bucket drift (stored vs recomputed) and writes
// nothing — before an explicit Apply overwrites the targeted month docs.
// Backfill = leave the month blank (every month that has data). Idempotent by
// construction (a full absolute overwrite, not an increment). Manager-only
// (Org-tab reachability + the rollups delete/write rules).
async function recomputeRollups(monthFilter, { write }){
  // Existing B4 query path — every submission for this org (a deliberate admin
  // full-scan, same category as backfillCompanies/the retention sweep).
  const snap = await getDocs(query(collection(db,'submissions'), where('orgId','==',orgId)));
  const subs = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  const familyOf = currentFamilyResolver();
  const computed = buildRollupsFromSubmissions(subs, familyOf); // { 'YYYY-MM': absoluteRollup }

  // A specific month (even one that recomputes to EMPTY — so a now-emptied
  // month can be zeroed) or, blank, every month that carries data.
  const targetMonths = monthFilter ? [monthFilter] : Object.keys(computed).sort();

  const report = [];
  for(const m of targetMonths){
    const newObj = computed[m] || blankMonth();
    let existing = null;
    try {
      const s = await getDoc(doc(db,'rollups',m));
      if(s.exists()) existing = s.data();
    } catch(e){ /* rollups read rule ships Step 5 — treat a denial as absent, same as loadOrgConfig() */ }
    report.push({ month:m, existed: !!existing, drift: diffRollups(existing, newObj), newObj });
  }

  // Session P0 (ARCHITECTURE.md §18). rollups create/update is open to any
  // same-org authed user — the §15.5 client-trust tradeoff, which exists
  // because increments have to ride BOTH an agent's create batch and a
  // backend user's activation transaction, and there is no server to move
  // them to. That tradeoff was always documented as "correctable via the
  // recompute tool," but correction alone is not a mitigation: it silently
  // erases the evidence. A tampered counter was overwritten and left no
  // trace that it had ever been wrong.
  //
  // Drift is therefore recorded before it is corrected. Deliberately logged
  // on DETECTION, not on write — a manager who dry-runs, sees drift and
  // walks away leaves the same trail as one who applies, and an attacker
  // cannot suppress the record by hoping nobody clicks Apply. Repeated
  // dry-runs producing repeated entries is the correct behaviour for an
  // append-only log, not a duplicate-suppression problem.
  //
  // Non-zero drift is NOT proof of tampering — §15.4's documented gap
  // (post-activation mrc edits) and any out-of-band delete both produce it
  // honestly. The entry is worded as an observation, and it is the pattern
  // over time, not any single entry, that is the signal.
  await logRollupDrift(report, write);

  if(write){
    // Full overwrite (dbSet = set, not merge) → absolute truth replaces any
    // drifted live-incremented values. skipAudit: a derived aggregate, not a
    // user-authored record (the underlying mutations were already audited);
    // orgId is still stamped by dbSet for the sameOrg() rule.
    for(const r of report){
      await dbSet('rollups', r.month, { ...r.newObj, lastRecomputedAt: now(), lastRecomputedBy: CP.name }, { skipAudit:true });
    }
  }
  return { report, subCount: subs.length };
}

// One auditLog entry per RUN that found drift, not one per month — a backfill
// across many months stays a single record, and the per-month breakdown rides
// along inside it. Bounded so a pathological run can't approach Firestore's
// 1MiB document limit.
const DRIFT_DETAIL_CAP = 50;
async function logRollupDrift(report, wrote){
  const drifted = report.filter(r => r.drift.length);
  if(!drifted.length) return;

  const details = [];
  for(const r of drifted){
    for(const d of r.drift){
      if(details.length >= DRIFT_DETAIL_CAP) break;
      details.push({ month: r.month, path: d.path, stored: d.old, recomputed: d.new });
    }
  }
  const totalBuckets = drifted.reduce((n, r) => n + r.drift.length, 0);

  try {
    await dbAdd('auditLog', {
      who: CU.uid,
      whoName: CP.name,
      what: 'rollupDrift',
      action: 'rollupDrift',
      // false = drift was observed in a dry-run and left in place; true = the
      // same run went on to overwrite it.
      corrected: !!wrote,
      months: drifted.map(r => ({ month: r.month, buckets: r.drift.length })),
      bucketCount: totalBuckets,
      details,
      detailsTruncated: totalBuckets > DRIFT_DETAIL_CAP,
      description: `Rollup drift: ${totalBuckets} bucket${totalBuckets!==1?'s':''} across ${drifted.length} month${drifted.length!==1?'s':''} (${drifted.map(r=>r.month).join(', ')}) — ${wrote ? 'overwritten by recompute' : 'observed in dry-run, not corrected'}`,
      ts: now()
    }, { skipAudit: true });   // this IS the audit record; don't log the log
  } catch(e){
    // The drift report itself must still reach the manager even if the audit
    // write fails (a rules change, a quota ceiling). Surfaced, never swallowed
    // silently — a missing trail is itself worth seeing.
    console.error('Rollup drift audit entry could not be written:', e);
    toast('Drift detected, but the audit entry could not be written. Check the console.', 'err');
  }
}

function renderRecomputeReport(report, subCount, wrote){
  if(!report.length){
    return `<p class="text-dim">Scanned ${subCount} submission${subCount!==1?'s':''}. No months with data — nothing to ${wrote?'write':'backfill'}.</p>`;
  }
  const rows = report.map(r => {
    const head = `<div style="font-weight:700;margin-top:10px">${esc(r.month)} — ${r.existed?'existing doc':'NEW doc'}${r.drift.length?` · ${r.drift.length} bucket${r.drift.length!==1?'s':''} drift`:' · in sync'}</div>`;
    if(!r.drift.length) return head;
    // d.old comes from the LIVE rollup doc, and rollups create/update is open
    // to any same-org authed user (the documented §15.5 client-trust
    // tradeoff) — so a tampered counter's value reaches the manager's drift
    // report as raw HTML if it isn't escaped here. d.new is recomputed
    // locally, but is escaped alongside it for symmetry.
    const lines = r.drift.map(d => `<div style="font-family:monospace">${esc(d.path)}: <span style="color:var(--red)">${esc(d.old)}</span> → <span style="color:var(--green)">${esc(d.new)}</span></div>`).join('');
    return head + lines;
  }).join('');
  return `<p class="text-dim mb-8">Scanned ${subCount} submission${subCount!==1?'s':''}. ${wrote?'✅ Overwrote':'Preview —'} ${report.length} month${report.length!==1?'s':''}:</p>${rows}`;
}

function showRecomputeRollupsModal(){
  modal('Recompute Rollups', `
    <p class="text-dim text-xs mb-8">Rebuilds the rollup counters from raw submissions (§15.4). Dry-run first — it reports per-bucket drift (stored vs recomputed) and writes nothing; then Apply overwrites the targeted month docs with the recomputed truth. Leave the month blank to backfill every month that has data.</p>
    <div class="field"><label>Month (YYYY-MM) — blank = all months</label><input type="text" id="rr-month" placeholder="e.g. 2026-07"></div>
    <div class="flex gap-8" style="margin:10px 0">
      <button class="btn btn-primary btn-sm" id="rr-dry">🔍 Dry-run (preview drift)</button>
      <button class="btn btn-ghost btn-sm" id="rr-apply" disabled>💾 Apply overwrite</button>
    </div>
    <div id="rr-report" class="text-xs" style="max-height:340px;overflow:auto"></div>
  `, true);

  async function run(write){
    const monthInput = v('rr-month');
    if(monthInput && !/^\d{4}-\d{2}$/.test(monthInput)){ toast('Month must be YYYY-MM (or blank for all).','err'); return; }
    const monthFilter = monthInput || null;
    const rep = document.getElementById('rr-report');
    const dryBtn = document.getElementById('rr-dry'), applyBtn = document.getElementById('rr-apply');
    dryBtn.disabled = true; applyBtn.disabled = true;
    rep.innerHTML = '<div class="loading"><div class="spin"></div> Computing…</div>';
    try {
      const { report, subCount } = await recomputeRollups(monthFilter, { write });
      rep.innerHTML = renderRecomputeReport(report, subCount, write);
      if(write){ toast(`✅ Recomputed ${report.length} month${report.length!==1?'s':''}.`); applyBtn.disabled = true; }
      else { applyBtn.disabled = report.length === 0; }
    } catch(e){
      const denied = e.code === 'permission-denied' || /insufficient permissions/i.test(e.message||'');
      rep.innerHTML = `<p style="color:var(--red)">${denied ? "Can't write rollups yet — the rollups/ Firestore rules ship in Step 5 of this build. Dry-run still works." : 'Error: '+esc(e.message)}</p>`;
    } finally {
      dryBtn.disabled = false;
    }
  }

  document.getElementById('rr-dry').onclick = () => run(false);
  document.getElementById('rr-apply').onclick = () => run(true);
}

// ─── EDIT COMPANY ───
// Company enrichment (ARCHITECTURE.md §3) — accountCode, segment, contacts,
// addressBlock, docExpiries, partnerHistory, accountOwner, billing skeleton.
// riskFlags is intentionally NOT exposed here — it's system-computed (doc
// expiry proximity, billing status, churn-list import), not hand-edited.
// Gated by the edit_companies permission grant, same as any future non-Org-tab
// entry point — today only managers ever reach this modal (Org tab routing),
// for whom hasPermission() already always returns true, so this is a no-op
// check until that grant is wired to a UI outside the Org tab.
function showEditCompanyModal(companyId, companies, users){
  const c = companies.find(x=>x.id===companyId); if(!c) return;
  if(!hasPermission('edit_companies', CP)){ toast("You don't have permission to edit companies.",'err'); return; }
  const contacts = c.contacts || {};
  const addr = c.addressBlock || {};
  const exp = c.docExpiries || {};
  const billing = c.billing || {};

  modal(`Edit Company: ${c.name}`, `
    <div class="row2">
      <div class="field"><label>Industry</label><input type="text" id="ec-ind" value="${esc(c.industry||'')}" placeholder="e.g. Construction"></div>
      <div class="field"><label>City</label><input type="text" id="ec-cy" value="${esc(c.city||'')}" placeholder="Dubai"></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
      <input type="checkbox" id="ec-du" ${c.hasDuAccount?'checked':''} style="width:auto;margin:0;cursor:pointer">
      <label for="ec-du" style="margin:0;cursor:pointer">Has an existing du account</label>
    </div>

    <div class="divider"></div>
    <div class="row2">
      <div class="field"><label>Account Code</label><input type="text" id="ec-acct" value="${esc(c.accountCode||'')}" placeholder="e.g. ACC-10293"></div>
      <div class="field"><label>Segment</label>
        <select id="ec-seg">
          <option value="">— None —</option>
          <option value="SOHO" ${c.segment==='SOHO'?'selected':''}>SOHO</option>
          <option value="SME" ${c.segment==='SME'?'selected':''}>SME</option>
        </select>
      </div>
    </div>

    <div class="divider"></div>
    <p class="text-dim text-xs mb-8">CONTACTS</p>
    <div class="row2">
      <div class="field"><label>Authorized Person</label><input type="text" id="ec-ct-auth" value="${esc(contacts.authorizedPerson||'')}"></div>
      <div class="field"><label>Technical Contact</label><input type="text" id="ec-ct-tech" value="${esc(contacts.technicalName||'')}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Phone</label><input type="text" id="ec-ct-ph" value="${esc(contacts.phone||'')}"></div>
      <div class="field"><label>Alt Phone</label><input type="text" id="ec-ct-altph" value="${esc(contacts.altPhone||'')}"></div>
    </div>
    <div class="field"><label>Email</label><input type="email" id="ec-ct-em" value="${esc(contacts.email||'')}"></div>

    <div class="divider"></div>
    <p class="text-dim text-xs mb-8">ADDRESS</p>
    <div class="row2">
      <div class="field"><label>Building</label><input type="text" id="ec-ad-bldg" value="${esc(addr.building||'')}"></div>
      <div class="field"><label>Street</label><input type="text" id="ec-ad-st" value="${esc(addr.street||'')}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Address City</label><input type="text" id="ec-ad-cy" value="${esc(addr.city||'')}"></div>
      <div class="field"><label>Emirate</label><input type="text" id="ec-ad-emirate" value="${esc(addr.emirate||'')}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>PO Box</label><input type="text" id="ec-ad-pobox" value="${esc(addr.poBox||'')}"></div>
      <div class="field"><label>Full Address</label><input type="text" id="ec-ad-full" value="${esc(addr.full||'')}"></div>
    </div>

    <div class="divider"></div>
    <p class="text-dim text-xs mb-8">DOCUMENT EXPIRIES</p>
    <div class="row2">
      <div class="field"><label>Trade License</label><input type="date" id="ec-exp-tl" value="${esc(exp.tradeLicense||'')}"></div>
      <div class="field"><label>Establishment Card</label><input type="date" id="ec-exp-ec" value="${esc(exp.establishmentCard||'')}"></div>
    </div>
    <div class="field"><label>Emirates ID</label><input type="date" id="ec-exp-eid" value="${esc(exp.eid||'')}"></div>

    <div class="divider"></div>
    <p class="text-dim text-xs mb-8">ACCOUNT OWNER (KAM)</p>
    <div class="field">
      <select id="ec-owner">
        <option value="">— None —</option>
        ${users.map(u=>`<option value="${u.id}" ${c.accountOwner===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}
      </select>
    </div>

    <div class="divider"></div>
    <p class="text-dim text-xs mb-8">BILLING</p>
    <div class="row2">
      <div class="field"><label>Last Confirmed Paid Month</label><input type="month" id="ec-bill-month" value="${esc(billing.lastConfirmedPaidMonth||'')}"></div>
      <div class="field"><label>Status</label>
        <select id="ec-bill-status">
          <option value="ok" ${!billing.status||billing.status==='ok'?'selected':''}>OK</option>
          <option value="pending" ${billing.status==='pending'?'selected':''}>Pending</option>
          <option value="overdue" ${billing.status==='overdue'?'selected':''}>Overdue</option>
        </select>
      </div>
    </div>

    <div class="divider"></div>
    <p class="text-dim text-xs mb-8">PARTNER HISTORY</p>
    <div id="ec-ph-list">
      ${(c.partnerHistory||[]).length ? c.partnerHistory.map(p=>`<div class="text-sm mb-4">${p.type==='gained'?'📥':'📤'} <strong>${esc(p.partner)}</strong>${p.date?` — ${fmtDate(p.date)}`:''}${p.note?` (${esc(p.note)})`:''}</div>`).join('') : '<p class="text-dim text-xs">No history yet.</p>'}
    </div>
    <p class="text-dim text-xs mt-8">Add a new entry (optional — leave Partner blank to skip):</p>
    <div class="row2">
      <div class="field"><label>Type</label>
        <select id="ec-ph-type"><option value="gained">Gained</option><option value="lost">Lost</option></select>
      </div>
      <div class="field"><label>Partner</label><input type="text" id="ec-ph-partner" placeholder="Other partner name"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Date</label><input type="date" id="ec-ph-date"></div>
      <div class="field"><label>Note</label><input type="text" id="ec-ph-note"></div>
    </div>

    <p id="ec-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="ec-btn">Save Changes</button>`, true);

  document.getElementById('ec-btn').onclick = async () => {
    const err = document.getElementById('ec-err');
    disable('ec-btn','Saving…');
    try {
      const partnerHistory = [...(c.partnerHistory||[])];
      const newPartner = v('ec-ph-partner');
      if(newPartner){
        partnerHistory.push({
          type: v('ec-ph-type')||'gained', partner: newPartner,
          date: v('ec-ph-date')||null, note: v('ec-ph-note')||''
        });
      }
      await dbUpdate('companies', companyId, {
        industry: v('ec-ind'), city: v('ec-cy'),
        hasDuAccount: document.getElementById('ec-du').checked,
        accountCode: v('ec-acct')||null,
        segment: v('ec-seg')||null,
        contacts: {
          authorizedPerson: v('ec-ct-auth'), technicalName: v('ec-ct-tech'),
          phone: v('ec-ct-ph'), altPhone: v('ec-ct-altph'), email: v('ec-ct-em')
        },
        addressBlock: {
          building: v('ec-ad-bldg'), street: v('ec-ad-st'), city: v('ec-ad-cy'),
          emirate: v('ec-ad-emirate'), poBox: v('ec-ad-pobox'), full: v('ec-ad-full')
        },
        docExpiries: {
          tradeLicense: v('ec-exp-tl')||null, establishmentCard: v('ec-exp-ec')||null, eid: v('ec-exp-eid')||null
        },
        accountOwner: v('ec-owner')||null,
        billing: {
          ...billing,
          lastConfirmedPaidMonth: v('ec-bill-month')||null,
          status: v('ec-bill-status')||'ok'
        },
        partnerHistory
      });
      closeModal(); toast('Company updated.'); renderOrgTab();
    } catch(e){ err.textContent=e.message; enable('ec-btn','Save Changes'); }
  };
}
