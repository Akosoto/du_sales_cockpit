import { db, CU, CP, OC, doc, getDoc, collection, query, where, getDocs } from './state.js';
import { esc, fmtDate, stagePill, toast } from './helpers.js';
import { dbUpdate } from './db.js';
import { showLeadModal } from './leads.js';
import { getDashboardData } from './dashboardData.js';
import { renderDonutCard } from './dashboardCharts.js';
import { renderRoleMetricsSection } from './dashboardCards.js';
import { saveOrgConfig, withOrgConfigSave } from './orgConfig.js';

// ════════════════════════════════════════════════════
// DASHBOARD TAB
// ════════════════════════════════════════════════════
export async function renderDashboardTab(){
  const ct = document.getElementById('content');
  const role = CP.role;

  // Fetch all data in parallel
  let leads = [], agentUsers = [], byId = {}, teamName = '';

  const leadsP = (async () => {
    if(role === 'manager'){
      const s = await getDocs(collection(db,'leads'));
      s.forEach(d => leads.push({id:d.id,...d.data()}));
    } else if(role === 'team_lead'){
      const s = await getDocs(query(collection(db,'leads'), where('teamId','==',CP.teamId)));
      s.forEach(d => leads.push({id:d.id,...d.data()}));
    } else {
      const s = await getDocs(query(collection(db,'leads'), where('assignedTo','==',CU.uid)));
      s.forEach(d => leads.push({id:d.id,...d.data()}));
    }
  })();

  const allUsersP = (async () => {
    const s = await getDocs(collection(db,'users'));
    s.forEach(d => { byId[d.id] = {id:d.id,...d.data()}; });
  })();

  const agentUsersP = role !== 'agent' ? (async () => {
    const q = role === 'manager'
      ? query(collection(db,'users'), where('role','==','agent'))
      : query(collection(db,'users'), where('tlId','==',CU.uid));
    const s = await getDocs(q);
    s.forEach(d => agentUsers.push({id:d.id,...d.data()}));
  })() : Promise.resolve();

  const teamP = role === 'team_lead' && CP.teamId ? (async () => {
    const s = await getDoc(doc(db,'teams',CP.teamId));
    if(s.exists()) teamName = s.data().name || '';
  })() : Promise.resolve();

  await Promise.all([leadsP, allUsersP, agentUsersP, teamP]);

  // KPI computations (all-time)
  const closedL   = leads.filter(l => l.stage === 'Closed');
  const lostL     = leads.filter(l => l.stage === 'Lost');
  const openL     = leads.filter(l => !['Closed','Lost'].includes(l.stage));
  const closedVal = closedL.reduce((s,l) => s + (Number(l.dealValue)||0), 0);
  const winRate   = leads.length ? Math.round(closedL.length / leads.length * 100) : 0;

  // Target — manager = sum of all agent targets
  const target = role === 'agent'     ? Number(CP.monthlyTarget)||0
               : role === 'team_lead' ? Number(CP.autoTarget||CP.monthlyTarget)||0
               : agentUsers.reduce((s,u) => s + (Number(u.monthlyTarget)||0), 0);

  // Helper: detect when a lead was closed from its history[]
  function closeMonthKey(l){
    const hist = (l.history||[]).filter(h => h.change && h.change.includes('→ Closed'));
    const ts = hist.length ? hist[hist.length-1].ts : (l.stage==='Closed' ? (l.lastEditedAt||l.createdAt) : null);
    if(!ts) return null;
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }

  // Current-month progress
  const nowD = new Date();
  const curKey = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}`;
  const curClosed = closedL.filter(l => closeMonthKey(l) === curKey);
  const curVal    = curClosed.reduce((s,l) => s + (Number(l.dealValue)||0), 0);
  const prog      = target ? Math.min(Math.round(curVal / target * 100), 100) : 0;
  const progColor = prog >= 100 ? 'var(--green)' : prog >= 50 ? 'var(--amber)' : 'var(--red)';
  const targetLbl = role === 'manager' ? 'Total across all agents'
                  : role === 'team_lead' ? (CP.targetSource==='override' ? 'Manager-set target' : 'Sum of agent targets')
                  : 'Your monthly target';

  // Monthly history — last 6 months newest-first
  const months = [];
  for(let i = 0; i < 6; i++){
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const lbl = d.toLocaleDateString('en-AE', {month:'short', year:'numeric'});
    months.push({key, lbl, count:0, val:0});
  }
  const mIdx = Object.fromEntries(months.map(m => [m.key, m]));
  closedL.forEach(l => { const k = closeMonthKey(l); if(k && mIdx[k]){ mIdx[k].count++; mIdx[k].val += Number(l.dealValue)||0; } });

  const monthRows = months.map(m => {
    const att = target ? Math.round(m.val / target * 100) : 0;
    const ac  = att >= 100 ? 'var(--green)' : att >= 50 ? 'var(--amber)' : m.val > 0 ? 'var(--red)' : 'var(--t2)';
    const cur = m.key === curKey;
    return `<tr ${cur ? 'style="background:rgba(124,58,237,.08)"' : ''}>
      <td style="font-weight:${cur?'600':'400'}">${esc(m.lbl)}${cur ? ' <span style="font-size:10px;color:var(--purple2)">(current)</span>' : ''}</td>
      <td>${target ? `AED ${Number(target).toLocaleString()}` : '—'}</td>
      <td>${m.count}</td>
      <td style="color:${m.val?'var(--green)':'var(--t2)'}">${m.val ? `AED ${Number(m.val).toLocaleString()}` : '—'}</td>
      <td style="color:${ac}">${target && m.val ? `${att}%` : '—'}</td>
    </tr>`;
  }).join('');

  // Follow-up buckets (open leads only)
  const todayDate = new Date(); todayDate.setHours(0,0,0,0);
  const todayStr  = todayDate.toISOString().slice(0,10);
  const endWeek   = new Date(todayDate); endWeek.setDate(todayDate.getDate() + (6 - todayDate.getDay()));
  const endWeekStr = endWeek.toISOString().slice(0,10);
  const withFu  = leads.filter(l => l.followup && !['Closed','Lost'].includes(l.stage));
  const fuOver  = withFu.filter(l => l.followup < todayStr).sort((a,b) => a.followup.localeCompare(b.followup));
  const fuToday = withFu.filter(l => l.followup === todayStr);
  const fuWeek  = withFu.filter(l => l.followup > todayStr && l.followup <= endWeekStr).sort((a,b) => a.followup.localeCompare(b.followup));

  // Activity log — flatten history[], sort desc, cap 50
  const acts = [];
  leads.forEach(l => (l.history||[]).forEach(h => acts.push({...h, company:l.company, leadId:l.id})));
  acts.sort((a,b) => (b.ts||'').localeCompare(a.ts||''));
  const recentActs = acts.slice(0,50);

  // Agent performance rows (progress column = this month's attainment)
  const agentRows = role === 'agent' ? '' : agentUsers.map(u => {
    const ul    = leads.filter(l => l.assignedTo === u.id);
    const uw    = ul.filter(l => l.stage === 'Closed');
    const ulst  = ul.filter(l => l.stage === 'Lost');
    const uOpen = ul.filter(l => !['Closed','Lost'].includes(l.stage));
    const uRate = ul.length ? Math.round(uw.length / ul.length * 100) : 0;
    const ut    = Number(u.monthlyTarget)||0;
    const uCurVal = uw.filter(l => closeMonthKey(l) === curKey).reduce((s,l) => s + (Number(l.dealValue)||0), 0);
    const up    = ut ? Math.min(Math.round(uCurVal / ut * 100), 100) : 0;
    const upc   = up >= 100 ? 'var(--green)' : up >= 50 ? 'var(--amber)' : 'var(--red)';
    return `<tr>
      <td>${esc(u.name)}</td>
      <td>${ul.length}</td>
      <td>${uOpen.length}</td>
      <td style="color:var(--green)">${uw.length}</td>
      <td style="color:var(--red)">${ulst.length}</td>
      <td style="color:var(--amber)">${uRate}%</td>
      <td>${ut ? `AED ${Number(ut).toLocaleString()}` : '—'}</td>
      <td style="min-width:130px">${ut ? `<div style="font-size:11px;margin-bottom:3px">${up}% · AED ${Number(uCurVal).toLocaleString()}</div><div class="prog-bar-wrap"><div class="prog-bar" style="width:${up}%;background:${upc}"></div></div>` : '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--t2)">No agents found</td></tr>`;

  function fuTable(arr){
    if(!arr.length) return `<p style="color:var(--t2);font-size:13px;margin:4px 0 10px">None</p>`;
    return `<table class="data-table" style="margin-bottom:10px"><thead><tr><th>Company</th><th>Contact</th><th>Date</th><th>Stage</th></tr></thead>
      <tbody>${arr.map(l=>`<tr class="fu-row" data-lid="${l.id}"><td>${esc(l.company)}</td><td>${esc(l.contact||'')}</td><td>${esc(l.followup)}</td><td>${stagePill(l.stage)}</td></tr>`).join('')}</tbody></table>`;
  }

  ct.innerHTML = `<div style="padding:24px;max-width:1100px">
    <h2 style="font-size:1.25rem;font-weight:700;margin:0 0 4px">📊 Dashboard</h2>
    ${role==='team_lead'&&teamName ? `<p style="font-size:13px;color:var(--t2);margin:0 0 18px">Team: <strong style="color:var(--t1)">${esc(teamName)}</strong></p>` : '<div style="margin-bottom:18px"></div>'}

    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-val">${leads.length}</div><div class="kpi-lbl">Total Leads</div></div>
      <div class="kpi-card"><div class="kpi-val">${openL.length}</div><div class="kpi-lbl">Open</div></div>
      <div class="kpi-card"><div class="kpi-val" style="color:var(--green)">${closedL.length}</div><div class="kpi-lbl">Closed</div></div>
      <div class="kpi-card"><div class="kpi-val" style="color:var(--red)">${lostL.length}</div><div class="kpi-lbl">Lost</div></div>
      <div class="kpi-card"><div class="kpi-val" style="color:var(--amber)">${winRate}%</div><div class="kpi-lbl">Win Rate</div></div>
      <div class="kpi-card"><div class="kpi-val" style="color:var(--green);font-size:1.15rem">AED ${Number(closedVal).toLocaleString()}</div><div class="kpi-lbl">Closed Value</div></div>
      ${role==='team_lead' ? `<div class="kpi-card"><div class="kpi-val">${agentUsers.length}</div><div class="kpi-lbl">Agents</div></div>` : ''}
    </div>

    ${role==='manager' ? `<div id="mgr-cockpit" style="margin-bottom:20px"></div>` : ''}

    ${role !== 'agent' ? `<div class="section-card" style="margin-bottom:20px">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px">👥 Agent Performance</div>
      <div style="overflow-x:auto"><table class="data-table">
        <thead><tr><th>Agent</th><th>Total</th><th>Open</th><th style="color:var(--green)">Closed</th><th style="color:var(--red)">Lost</th><th>Win Rate</th><th>Target</th><th>This Month</th></tr></thead>
        <tbody>${agentRows}</tbody>
      </table></div>
    </div>` : ''}

    <div class="section-card" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-weight:600;font-size:14px">This Month's Target</span>
        <span style="font-size:13px;color:var(--t2)">${target ? `${prog}% &nbsp;·&nbsp; AED ${Number(curVal).toLocaleString()} / AED ${Number(target).toLocaleString()}` : 'No target set'}</span>
      </div>
      ${target ? `<div class="prog-bar-wrap"><div class="prog-bar" style="width:${prog}%;background:${progColor}"></div></div>` : ''}
      <div class="stat-target">${targetLbl} · closed deals in current calendar month</div>
    </div>

    <div class="section-card" style="margin-bottom:20px">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px">📈 Monthly Performance History</div>
      <div style="overflow-x:auto"><table class="data-table">
        <thead><tr><th>Month</th><th>Target</th><th>Closed Deals</th><th>Closed Value</th><th>Attainment</th></tr></thead>
        <tbody>${monthRows}</tbody>
      </table></div>
      <div style="font-size:11px;color:var(--t2);margin-top:8px">Target shown is the current setting${role==='manager'?' (sum of all agents)':''}. Historical targets are not stored.</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
      <div class="section-card">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px">📅 Follow-ups</div>
        ${fuOver.length ? `<div class="fu-group-hdr fu-hdr-overdue">⚠ Overdue (${fuOver.length})</div>${fuTable(fuOver)}` : ''}
        <div class="fu-group-hdr fu-hdr-today">Today (${fuToday.length})</div>${fuTable(fuToday)}
        <div class="fu-group-hdr">This Week (${fuWeek.length})</div>${fuTable(fuWeek)}
      </div>
      <div class="section-card" style="overflow:hidden">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px">🕐 Recent Activity</div>
        ${recentActs.length ? `<div class="act-log" id="act-log">${recentActs.map((a,i)=>`<div class="act-item${i>=10?' act-hidden':''}">
          <div class="act-dot"></div>
          <div class="act-content">
            <div><span class="act-who">${esc(a.actorName||'')}</span> <span class="act-change">${esc(a.change||'')}</span> <span class="act-company">· ${esc(a.company||'')}</span></div>
            <div class="act-time">${fmtDate(a.ts)}</div>
          </div>
        </div>`).join('')}</div>${recentActs.length>10?`<button class="btn btn-ghost btn-sm mt-8" id="act-toggle">Show More (${recentActs.length-10})</button>`:''}` : `<p style="color:var(--t2);font-size:13px">No activity yet.</p>`}
      </div>
    </div>
  </div>`;

  ct.querySelectorAll('.fu-row').forEach(row => {
    const lead = leads.find(l => l.id === row.dataset.lid);
    if(lead) row.addEventListener('click', () => showLeadModal(lead, byId, agentUsers));
  });

  document.getElementById('act-toggle')?.addEventListener('click', () => {
    const log = document.getElementById('act-log');
    const btn = document.getElementById('act-toggle');
    const expanded = log.classList.toggle('expanded');
    btn.textContent = expanded ? 'Show Less' : `Show More (${recentActs.length-10})`;
  });

  // Manager's Cockpit (Session B4 Steps 5-7) — a separate section reading
  // through getDashboardData(period), independent of the leads/stage-based
  // KPIs above it. teams/agentUsers are already fetched for this role.
  if(role === 'manager') renderManagerCockpit();
}

// All teams (agentUsers above only covers role:'agent' for the manager
// branch — the cockpit's byTeam breakdown needs every team regardless of
// who's on it, so this re-fetches teams separately rather than threading a
// wider fetch back through renderDashboardTab's existing per-role branches).
async function fetchAllTeams(){
  const s = await getDocs(collection(db,'teams'));
  return s.docs.map(d=>({id:d.id,...d.data()}));
}

// Local UI state (period + AED/count mode) lives in this closure, shared
// across Steps 5-7's sections so they all react to the same selector
// instead of each owning a duplicate one. Re-renders only #mgr-cockpit's
// subtree, never the whole Dashboard tab.
function renderManagerCockpit(){
  const box = document.getElementById('mgr-cockpit');
  if(!box) return;
  let period = 'thisMonth';
  let mode = 'aed'; // 'aed' | 'count'
  let customFrom = '', customTo = '';

  async function refresh(){
    box.innerHTML = '<div class="loading"><div class="spin"></div> Loading…</div>';
    let data, err = '', users = [];
    try {
      const allTeams = await fetchAllTeams();
      const usersSnap = await getDocs(collection(db,'users'));
      users = usersSnap.docs.map(d=>({id:d.id,...d.data()}));
      const periodArg = period === 'custom' ? { preset:'custom', from:customFrom, to:customTo } : period;
      data = await getDashboardData(periodArg, { teams: allTeams, users });
    } catch(e){
      // The status+activatedAt composite index (js/dashboardData.js) ships
      // in Step 8 — until then Firestore denies this specific query shape
      // with its own "requires an index" error. Surface that plainly
      // instead of a raw Firebase error string.
      err = /requires an index/i.test(e.message||'')
        ? "This view needs a Firestore index that hasn't been created yet — ships in Step 8 of this build."
        : e.message;
    }

    const periodBtn = (id,label) => `<button class="ch-tag${period===id?' active':''}" data-period="${id}">${esc(label)}</button>`;
    const modeBtn = (id,label) => `<button class="ch-tag${mode===id?' active':''}" data-mode="${id}">${esc(label)}</button>`;

    // Target Remaining + run-rate toggle (Session B4 Step 7, ARCHITECTURE.md
    // §12 fixed decisions). Only "This Month" has a defined equivalent to
    // compare against — monthlyTarget is the only target this schema
    // tracks, so every other period is N/A rather than guessing at a
    // pro-rated figure nobody asked for. Visibility: a per-user override
    // (CP.runRateVisible, already coverable by the EXISTING users/{uid}
    // update rule's self-write clause — no Step 8 dependency) always wins
    // over the org default (orgs/{orgId}.runRateDefaultVisible, which DOES
    // need Step 8's rule) in either direction; default is OFF (hidden).
    function targetRemainingHtml(usersList){
      if(period !== 'thisMonth'){
        return `<div class="section-card" style="margin-bottom:14px">
          <div style="font-weight:700;font-size:14px;margin-bottom:4px">🎯 Target Remaining</div>
          <p class="text-dim text-xs" title="monthlyTarget is the only target this schema tracks — only This Month has a directly comparable figure.">N/A for ${esc(data.period.label)} — target-remaining only applies to This Month.</p>
        </div>`;
      }
      const target = usersList.filter(u=>u.role==='agent').reduce((s,u)=>s+(Number(u.monthlyTarget)||0),0);
      if(!target){
        return `<div class="section-card" style="margin-bottom:14px">
          <div style="font-weight:700;font-size:14px;margin-bottom:4px">🎯 Target Remaining</div>
          <p class="text-dim text-xs">No target set for any agent.</p>
        </div>`;
      }
      const achieved  = data.totals.activatedAed;
      const exceeded  = achieved > target;
      const remaining = Math.abs(target - achieved);
      const showRunRate = CP.runRateVisible != null ? CP.runRateVisible : !!(OC?.runRateDefaultVisible);
      const t = new Date();
      const daysLeft = new Date(t.getFullYear(), t.getMonth()+1, 0).getDate() - t.getDate() + 1; // today inclusive
      const runRate = daysLeft > 0 ? remaining / daysLeft : remaining;
      return `<div class="section-card" style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <div style="font-weight:700;font-size:14px">🎯 Target Remaining</div>
          <div class="flex gap-8">
            <button class="btn btn-ghost btn-xs" id="mc-runrate-toggle">${showRunRate?'Hide':'Show'} Run-Rate</button>
            <button class="btn btn-ghost btn-xs" id="mc-runrate-default">Set as Org Default</button>
          </div>
        </div>
        <div class="kpi-grid" style="margin-bottom:0">
          <div class="kpi-card"><div class="kpi-val" style="color:${exceeded?'var(--green)':'var(--t1)'}">AED ${Number(remaining).toLocaleString()}</div><div class="kpi-lbl">${exceeded?'Exceeded By':'Remaining'}</div></div>
          <div class="kpi-card"><div class="kpi-val">AED ${Number(target).toLocaleString()}</div><div class="kpi-lbl">Target</div></div>
          ${showRunRate ? `
          <div class="kpi-card"><div class="kpi-val">${daysLeft}</div><div class="kpi-lbl">Days Left</div></div>
          <div class="kpi-card"><div class="kpi-val" style="color:var(--amber)">AED ${Number(Math.round(runRate)).toLocaleString()}</div><div class="kpi-lbl">Required Daily Run-Rate</div></div>` : ''}
        </div>
      </div>`;
    }

    box.innerHTML = `
      <div class="pg-hdr" style="margin-bottom:12px">
        <div><h2 style="font-size:1.05rem">🎯 Manager's Cockpit</h2><p class="pg-hdr-sub">Activated submissions${data?` · ${esc(data.period.label)}`:''}</p></div>
      </div>
      <div class="filters" style="margin-bottom:8px">
        ${periodBtn('thisMonth','This Month')}${periodBtn('lastMonth','Last Month')}${periodBtn('thisQuarter','This Quarter')}${periodBtn('custom','Custom')}
      </div>
      ${period==='custom' ? `<div class="row2" style="max-width:420px;margin-bottom:12px">
        <div class="field"><label>From</label><input type="date" id="mc-from" value="${esc(customFrom)}"></div>
        <div class="field"><label>To <span class="text-dim">(max 92 days)</span></label><input type="date" id="mc-to" value="${esc(customTo)}"></div>
      </div>
      <button class="btn btn-ghost btn-sm mb-12" id="mc-apply-range">Apply Range</button>` : ''}
      <div class="filters" style="margin-bottom:12px">${modeBtn('aed','AED')}${modeBtn('count','Count')}</div>
      ${err ? `<p class="err">${esc(err)}</p>` : `
      ${targetRemainingHtml(users)}
      <div class="dash-donut-grid">
        ${renderDonutCard('Share by Team', data.byTeam.map(t=>({name:t.teamName, aed:t.aed, count:t.count})), mode)}
        ${renderDonutCard('Share by Contributor', data.byContributor.map(c=>({name:c.name, aed:c.aed, count:c.count})), mode)}
      </div>
      ${renderRoleMetricsSection(data.roleMetrics)}`}
    `;

    box.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click', ()=>{
      period = b.dataset.period;
      if(period !== 'custom') refresh();
      else render_customDefaults();
    }));
    box.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click', ()=>{ mode = b.dataset.mode; refresh(); }));
    box.querySelector('#mc-apply-range')?.addEventListener('click', ()=>{
      customFrom = document.getElementById('mc-from').value;
      customTo = document.getElementById('mc-to').value;
      if(!customFrom || !customTo){ toast('Pick both dates.','err'); return; }
      refresh();
    });
    box.querySelector('#mc-runrate-toggle')?.addEventListener('click', async ()=>{
      // Per-user override — covered by the users/{uid} rule's EXISTING
      // self-write clause (request.auth.uid == uid), so this works today,
      // no Step 8 dependency, unlike the org-default save below.
      const current = CP.runRateVisible != null ? CP.runRateVisible : !!(OC?.runRateDefaultVisible);
      try {
        await dbUpdate('users', CU.uid, { runRateVisible: !current });
        CP.runRateVisible = !current;
        refresh();
      } catch(e){ toast('Error: '+e.message,'err'); }
    });
    box.querySelector('#mc-runrate-default')?.addEventListener('click', async ()=>{
      const current = CP.runRateVisible != null ? CP.runRateVisible : !!(OC?.runRateDefaultVisible);
      const ok = await withOrgConfigSave(()=>saveOrgConfig({ runRateDefaultVisible: current }));
      if(ok) toast('Org default updated.');
      refresh();
    });

    function render_customDefaults(){
      // First switch to Custom: default the range to the current period's
      // own bounds so Apply Range works immediately without the manager
      // having to know today's date math themselves. Built in LOCAL time
      // (not toISOString, which converts to UTC and can silently roll the
      // date back a day west of UTC) since these feed <input type="date">.
      if(!customFrom){
        const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const t = new Date();
        customFrom = localDateStr(new Date(t.getFullYear(), t.getMonth(), 1));
        customTo = localDateStr(t);
      }
      refresh();
    }
  }

  refresh();
}
