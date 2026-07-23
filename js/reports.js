import { db, CP, OC, collection, getDocs } from './state.js';
import { esc, toast } from './helpers.js';
import { getDashboardData } from './dashboardData.js';

// ════════════════════════════════════════════════════
// REPORTS TAB (Session C2, ARCHITECTURE.md §16) — manager-only. Every
// report fetches on tab-open + a manual Refresh button only — no polling,
// no onSnapshot listeners (quota discipline, this session's fixed
// decisions). Reuses getDashboardData()/js/rollups.js helpers throughout;
// no report re-implements attribution or rollup aggregation logic itself.
// ════════════════════════════════════════════════════

const REPORT_TABS = [
  ['daily-team',    '📋 Live Daily Team Table'],
  ['daily-summary', '📝 Daily Summary'],
  ['tracker',       '🗂️ Master Tracker'],
  ['rejections',    '🚫 Rejection Analytics']
];

function placeholderHtml(name){
  return `<div class="empty"><div class="empty-icon">🚧</div><div class="empty-title">${esc(name)} — coming in a later step</div></div>`;
}

// Shared fetch — teams + ALL users (unfiltered), same shape dashboard.js's
// own Manager's Cockpit fetch uses. Deliberately NOT pre-filtered to
// role=='agent': getDashboardData's own backend-role-metrics computation
// needs the full users list (userById[...].department==='backend' checks)
// even though Report 1 itself only reads the agent slice — filtering here
// would silently break backend metrics for any future report/caller reusing
// this helper.
async function fetchTeamsAndUsers(){
  const [teamsSnap, usersSnap] = await Promise.all([
    getDocs(collection(db,'teams')),
    getDocs(collection(db,'users'))
  ]);
  return {
    teams: teamsSnap.docs.map(d=>({id:d.id,...d.data()})),
    users: usersSnap.docs.map(d=>({id:d.id,...d.data()}))
  };
}

function todayDateStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtTime(d){
  return d.toLocaleTimeString('en-AE', { hour:'2-digit', minute:'2-digit' });
}

// ════════════════════════════════════════════════════
// REPORT 1 — Live Daily Team Table (ARCHITECTURE.md §16.1)
// Built entirely from TWO getDashboardData() calls (today-custom, this-
// Month-preset) — zero new query shapes. Per-team activated (AED+lines):
// byTeam (rollup-sourced for MTD, live for today — unaffected by
// attribution). Per-agent activated (AED+lines) + submitted (lines):
// roleMetrics.agents (agentId-keyed, NOT byContributor's attribution-based
// credit — a sourcedBy line must still count toward the SUBMITTING agent's
// own production here, matching ARCHITECTURE.md §12's established
// distinction). Per-TEAM submitted lines: derived by summing per-agent
// roleMetrics.linesSubmitted grouped by teamId (neither rollups nor
// roleMetrics carries a native team-submitted dimension — §16.6 Flag 2) —
// footnoted below since this undercounts a team_lead's own direct
// submissions (roleMetrics.agents is role=='agent'-gated).
// ════════════════════════════════════════════════════
async function renderDailyTeamReport(body){
  const { teams, users } = await fetchTeamsAndUsers();
  const todayStr = todayDateStr();

  const [todayData, mtdData] = await Promise.all([
    getDashboardData({ preset:'custom', from: todayStr, to: todayStr }, { teams, users }),
    getDashboardData('thisMonth', { teams, users })
  ]);

  const todayTeamAct = Object.fromEntries(todayData.byTeam.map(t=>[t.teamId||'none', t]));
  const mtdTeamAct   = Object.fromEntries(mtdData.byTeam.map(t=>[t.teamId||'none', t]));
  const todayAgentM  = Object.fromEntries(todayData.roleMetrics.agents.map(a=>[a.userId, a]));
  const mtdAgentM    = Object.fromEntries(mtdData.roleMetrics.agents.map(a=>[a.userId, a]));

  const agentUsers = users.filter(u=>u.role==='agent');
  const agentsByTeam = {};
  agentUsers.forEach(u => { const k = u.teamId||'none'; (agentsByTeam[k] ||= []).push(u); });

  const teamSubmitted = (agentMetricsMap, teamAgents) =>
    teamAgents.reduce((s,u) => s + (agentMetricsMap[u.id]?.linesSubmitted||0), 0);

  const teamGroups = [...teams.map(t=>({ id:t.id, name:t.name||'Unassigned' }))];
  if(agentsByTeam['none']?.length) teamGroups.push({ id:'none', name:'Unassigned' });

  const aed = n => `AED ${Number(n||0).toLocaleString()}`;

  const bodyRows = teamGroups.map(team => {
    const tId = team.id;
    const todayAct = todayTeamAct[tId] || {aed:0,count:0};
    const mtdAct   = mtdTeamAct[tId]   || {aed:0,count:0};
    const teamAgents = agentsByTeam[tId] || [];
    const todaySub = teamSubmitted(todayAgentM, teamAgents);
    const mtdSub   = teamSubmitted(mtdAgentM, teamAgents);

    const agentRows = teamAgents.map(u => {
      const ta = todayAgentM[u.id] || {aedClosed:0,activatedCount:0,linesSubmitted:0};
      const ma = mtdAgentM[u.id]   || {aedClosed:0,activatedCount:0,linesSubmitted:0};
      return `<tr>
        <td style="padding-left:24px;color:var(--t2)">${esc(u.name)}</td>
        <td>${ta.linesSubmitted}</td>
        <td style="color:var(--green)">${aed(ta.aedClosed)}</td>
        <td>${ta.activatedCount}</td>
        <td>${ma.linesSubmitted}</td>
        <td style="color:var(--green)">${aed(ma.aedClosed)}</td>
        <td>${ma.activatedCount}</td>
      </tr>`;
    }).join('');

    return `<tr style="font-weight:700;background:var(--bg2)">
      <td>🏢 ${esc(team.name)}</td>
      <td>${todaySub}</td>
      <td style="color:var(--green)">${aed(todayAct.aed)}</td>
      <td>${todayAct.count}</td>
      <td>${mtdSub}</td>
      <td style="color:var(--green)">${aed(mtdAct.aed)}</td>
      <td>${mtdAct.count}</td>
    </tr>${agentRows}`;
  }).join('');

  body.innerHTML = `
    <div class="flex gap-8" style="justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <p class="text-dim text-xs">Last fetched: ${fmtTime(new Date())}</p>
      <button class="btn btn-ghost btn-sm" id="rp1-refresh">🔄 Refresh</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th rowspan="2" style="vertical-align:bottom">Team / Agent</th>
            <th colspan="3" style="text-align:center;border-bottom:1px solid var(--border2)">Today</th>
            <th colspan="3" style="text-align:center;border-bottom:1px solid var(--border2)">MTD</th>
          </tr>
          <tr>
            <th>Submitted</th><th>Activated AED</th><th>Activated Lines</th>
            <th>Submitted</th><th>Activated AED</th><th>Activated Lines</th>
          </tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="7" class="text-dim">No teams found.</td></tr>`}</tbody>
      </table>
    </div>
    <p class="text-dim text-xs mt-8" title="roleMetrics.agents is role=='agent'-gated (ARCHITECTURE.md §12) — a team_lead submitting their own leads directly is not included in this sum.">
      Team "Submitted" totals are a sum of that team's AGENTS' own submitted lines — a team_lead's own directly-submitted leads (rare) are not counted in the team row.
    </p>
  `;

  document.getElementById('rp1-refresh')?.addEventListener('click', () => renderDailyTeamReport(body));
}

// ════════════════════════════════════════════════════
// REPORT 2 — Daily Summary (ARCHITECTURE.md §16.2)
// Today's numbers (its own today-custom getDashboardData call) + MTD vs org
// target, reusing js/dashboard.js's target/run-rate resolution logic
// VERBATIM (not re-derived): target = Σ active agents' monthlyTarget;
// run-rate visibility = CP.runRateVisible ?? OC.runRateDefaultVisible
// (per-user override always wins, §12) — the run-rate line renders ONLY
// when that resolves visible, never forced on.
// ════════════════════════════════════════════════════
function buildSummaryText({ periodLabel, today, mtd, target, achieved, exceeded, remaining, showRunRate, daysLeft, runRate }){
  const lines = [
    `📊 Daily Summary — ${periodLabel}`,
    `Today: ${today.submitted} submitted · ${today.count} activated (AED ${Number(today.aed).toLocaleString()})`,
    `MTD: ${mtd.count} activated (AED ${Number(mtd.aed).toLocaleString()})` +
      (target ? ` — Target AED ${Number(target).toLocaleString()} (AED ${Number(remaining).toLocaleString()} ${exceeded?'exceeded by':'remaining'})` : ' — no target set')
  ];
  if(target && showRunRate) lines.push(`Required daily run-rate: AED ${Number(Math.round(runRate)).toLocaleString()}/day (${daysLeft} day${daysLeft!==1?'s':''} left)`);
  return lines.join('\n');
}

async function renderDailySummaryReport(body){
  const { teams, users } = await fetchTeamsAndUsers();
  const todayStr = todayDateStr();

  const [todayData, mtdData] = await Promise.all([
    getDashboardData({ preset:'custom', from: todayStr, to: todayStr }, { teams, users }),
    getDashboardData('thisMonth', { teams, users })
  ]);

  const todaySubmitted = todayData.roleMetrics.agents.reduce((s,a)=>s+(a.linesSubmitted||0),0);
  const today = { submitted: todaySubmitted, count: todayData.totals.activatedCount, aed: todayData.totals.activatedAed };
  const mtd   = { count: mtdData.totals.activatedCount, aed: mtdData.totals.activatedAed };

  // Target/run-rate — verbatim js/dashboard.js resolution (Session B4 Step 7).
  const target = users.filter(u=>u.role==='agent').reduce((s,u)=>s+(Number(u.monthlyTarget)||0),0);
  const achieved = mtd.aed;
  const exceeded = achieved > target;
  const remaining = Math.abs(target - achieved);
  const showRunRate = CP.runRateVisible != null ? CP.runRateVisible : !!(OC?.runRateDefaultVisible);
  const t = new Date();
  const daysLeft = new Date(t.getFullYear(), t.getMonth()+1, 0).getDate() - t.getDate() + 1; // today inclusive
  const runRate = daysLeft > 0 ? remaining / daysLeft : remaining;

  const periodLabel = t.toLocaleDateString('en-AE', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
  const summaryText = buildSummaryText({ periodLabel, today, mtd, target, achieved, exceeded, remaining, showRunRate, daysLeft, runRate });

  const aed = n => `AED ${Number(n||0).toLocaleString()}`;

  body.innerHTML = `
    <div class="flex gap-8" style="justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <p class="text-dim text-xs">Last fetched: ${fmtTime(new Date())}</p>
      <div class="flex gap-8">
        <button class="btn btn-ghost btn-sm" id="rp2-copy">📋 Copy Summary</button>
        <button class="btn btn-ghost btn-sm" id="rp2-refresh">🔄 Refresh</button>
      </div>
    </div>
    <div class="section-card" style="margin-bottom:14px">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px">📅 Today — ${esc(periodLabel)}</div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-val">${today.submitted}</div><div class="kpi-lbl">Lines Submitted</div></div>
        <div class="kpi-card"><div class="kpi-val" style="color:var(--green)">${aed(today.aed)}</div><div class="kpi-lbl">Activated AED</div></div>
        <div class="kpi-card"><div class="kpi-val">${today.count}</div><div class="kpi-lbl">Activated Lines</div></div>
      </div>
    </div>
    <div class="section-card" style="margin-bottom:14px">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px">📆 Month to Date</div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-val" style="color:var(--green)">${aed(mtd.aed)}</div><div class="kpi-lbl">Activated AED</div></div>
        <div class="kpi-card"><div class="kpi-val">${mtd.count}</div><div class="kpi-lbl">Activated Lines</div></div>
        ${target ? `
        <div class="kpi-card"><div class="kpi-val">${aed(target)}</div><div class="kpi-lbl">Target</div></div>
        <div class="kpi-card"><div class="kpi-val" style="color:${exceeded?'var(--green)':'var(--t1)'}">${aed(remaining)}</div><div class="kpi-lbl">${exceeded?'Exceeded By':'Remaining'}</div></div>
        ${showRunRate ? `<div class="kpi-card"><div class="kpi-val" style="color:var(--amber)">${aed(Math.round(runRate))}</div><div class="kpi-lbl">Required Daily Run-Rate</div></div>` : ''}
        ` : `<div class="kpi-card"><div class="kpi-val text-dim">—</div><div class="kpi-lbl">No target set</div></div>`}
      </div>
    </div>
  `;

  document.getElementById('rp2-refresh')?.addEventListener('click', () => renderDailySummaryReport(body));
  document.getElementById('rp2-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(summaryText); toast('Copied.'); }
    catch(e){ toast('Could not copy — copy it manually.', 'err'); }
  });
}

// ════════════════════════════════════════════════════
// TAB SCAFFOLD
// ════════════════════════════════════════════════════
export async function renderReportsTab(){
  const ct = document.getElementById('content');

  if(CP.role !== 'manager'){
    ct.innerHTML = `<div class="empty"><div class="empty-icon">🔒</div><div class="empty-title">Manager only</div></div>`;
    return;
  }

  let active = 'daily-team';

  ct.innerHTML = `
    <div class="pg-hdr">
      <div><h2>📈 Reports</h2><p class="pg-hdr-sub">Live operational reports — fetched on open, refresh manually (no auto-polling).</p></div>
    </div>
    <div class="filters" style="margin-bottom:16px" id="rp-nav">
      ${REPORT_TABS.map(([id,label]) => `<button class="ch-tag${id===active?' active':''}" data-report="${id}">${label}</button>`).join('')}
    </div>
    <div id="rp-body"><div class="loading"><div class="spin"></div> Loading…</div></div>
  `;

  const nav = document.getElementById('rp-nav');
  const body = document.getElementById('rp-body');

  async function renderActive(){
    body.innerHTML = '<div class="loading"><div class="spin"></div> Loading…</div>';
    try {
      if(active === 'daily-team')         await renderDailyTeamReport(body);
      else if(active === 'daily-summary') await renderDailySummaryReport(body);
      else if(active === 'tracker')       body.innerHTML = placeholderHtml('Master Tracker');
      else if(active === 'rejections')    body.innerHTML = placeholderHtml('Rejection Analytics');
    } catch(e){
      body.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`;
    }
  }

  nav.querySelectorAll('[data-report]').forEach(b => b.addEventListener('click', () => {
    active = b.dataset.report;
    nav.querySelectorAll('[data-report]').forEach(x => x.classList.toggle('active', x.dataset.report===active));
    renderActive();
  }));

  renderActive();
}
