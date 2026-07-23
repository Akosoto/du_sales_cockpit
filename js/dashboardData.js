import { db, collection, query, where, getDocs, doc, getDoc } from './state.js';

// ════════════════════════════════════════════════════
// DASHBOARD DATA LAYER (Session B4 Step 4, ARCHITECTURE.md §12) —
// Manager's Cockpit donuts (Step 5) + role-metrics cards (Step 6) both read
// through getDashboardData(period). Deliberately a thin client-side
// aggregation over `submissions`, NOT the real rollup-counter engine —
// Phase C (a later Opus session) replaces the INTERNALS of this function
// with reads against precomputed rollup docs; the call signature
// (period in, {period,totals,byTeam,byContributor,roleMetrics} out) is the
// contract Phase C must preserve, so nothing calling getDashboardData()
// needs to change when that swap happens.
// ════════════════════════════════════════════════════

const CUSTOM_RANGE_CAP_DAYS = 92;

// period is either a preset string ('thisMonth'|'lastMonth'|'thisQuarter')
// or {preset:'custom', from:'YYYY-MM-DD', to:'YYYY-MM-DD'}. Returns ISO
// datetime boundaries (not bare dates) since every stamped timestamp in
// this schema (createdAt/activatedAt/submittedToDuAt/claimedAt, all from
// helpers.js now()) is a full ISO datetime — a bare-date string would sort
// before every same-day timestamp and silently exclude that day's data.
export function resolvePeriodRange(period){
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth();
  const startOfDay = d => new Date(d.getFullYear(),d.getMonth(),d.getDate(),0,0,0,0).toISOString();
  const endOfDay   = d => new Date(d.getFullYear(),d.getMonth(),d.getDate(),23,59,59,999).toISOString();

  if(period === 'thisMonth'){
    return { from: startOfDay(new Date(y,m,1)), to: endOfDay(today), label: 'This Month' };
  }
  if(period === 'lastMonth'){
    return { from: startOfDay(new Date(y,m-1,1)), to: endOfDay(new Date(y,m,0)), label: 'Last Month' };
  }
  if(period === 'thisQuarter'){
    const qStart = Math.floor(m/3)*3;
    return { from: startOfDay(new Date(y,qStart,1)), to: endOfDay(today), label: 'This Quarter' };
  }
  if(period && period.preset === 'custom'){
    const fromD = new Date(period.from), toD = new Date(period.to);
    if(isNaN(fromD) || isNaN(toD)) throw new Error('Invalid custom date range.');
    const days = (toD - fromD) / 86400000;
    if(days < 0) throw new Error('"From" date must be on or before "To" date.');
    if(days > CUSTOM_RANGE_CAP_DAYS) throw new Error(`Custom range cannot exceed ${CUSTOM_RANGE_CAP_DAYS} days.`);
    return { from: startOfDay(fromD), to: endOfDay(toD), label: `${period.from} – ${period.to}` };
  }
  throw new Error(`Unknown period: ${JSON.stringify(period)}`);
}

function hoursBetween(fromIso, toIso){ return (new Date(toIso) - new Date(fromIso)) / 3600000; }
function avg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; } // null = N/A, never 0

// ── Phase C rollup swap (ARCHITECTURE.md §15.5) ──
// The three PRESET periods read their donut/KPI aggregation (totals + byTeam
// + byContributor) from precomputed rollups/{YYYY-MM} docs instead of scanning
// submissions; CUSTOM ranges keep the live path unchanged. Month keys are the
// LOCAL-time YYYY-MM the increment sites bucket by (js/rollups.js monthKey), so
// a preset here reads exactly the months resolvePeriodRange() spans. This
// Quarter = the (up to) three months of the current quarter, summed
// client-side. Time metrics + agent role metrics stay on the live queries this
// session (fixed decision + §12: agent metrics are attribution-independent,
// keyed by agentId, which the attribution-based byContributor can't serve), so
// the live scans below still run for roleMetrics in preset mode too — this swap
// sources the donuts/KPIs from rollups and proves preset==custom, not a full
// read-elimination (that lands when time/role metrics roll up in a later
// session).
const PRESETS = new Set(['thisMonth','lastMonth','thisQuarter']);
function monthKeyLocal(y, mZeroBased){ const d = new Date(y, mZeroBased, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function presetMonths(period){
  const t = new Date(); const y = t.getFullYear(), m = t.getMonth();
  if(period === 'thisMonth') return [monthKeyLocal(y, m)];
  if(period === 'lastMonth') return [monthKeyLocal(y, m-1)];               // new Date handles Jan→prev-Dec rollover
  if(period === 'thisQuarter'){ const qs = Math.floor(m/3)*3; return [0,1,2].map(i => monthKeyLocal(y, qs+i)); }
  return [];
}
// Sum the targeted month docs. A missing/denied month doc (the get-on-
// nonexistent-doc gotcha, §12) degrades to zeros — same try/catch posture as
// loadOrgConfig()/the recompute tool.
async function readPresetRollups(period){
  const acc = { totals:{aedActivated:0, linesActivated:0}, byTeam:{}, byContributor:{} };
  for(const mk of presetMonths(period)){
    let data = null;
    try { const s = await getDoc(doc(db,'rollups',mk)); if(s.exists()) data = s.data(); }
    catch(e){ /* absent/denied → treat as empty */ }
    if(!data) continue;
    acc.totals.aedActivated  += Number(data.totals && data.totals.aedActivated)  || 0;
    acc.totals.linesActivated += Number(data.totals && data.totals.linesActivated) || 0;
    for(const [team,v] of Object.entries(data.byTeam || {})){
      const b = acc.byTeam[team] || (acc.byTeam[team] = { aed:0, count:0 });
      b.aed += Number(v.aed)||0; b.count += Number(v.count)||0;
    }
    for(const [key,v] of Object.entries(data.byContributor || {})){
      const c = acc.byContributor[key] || (acc.byContributor[key] = { aed:0, count:0, label:v.label, type:v.type });
      c.aed += Number(v.aed)||0; c.count += Number(v.count)||0;
      if(v.label) c.label = v.label; if(v.type) c.type = v.type;
    }
  }
  return acc;
}

// {teams, users}: already-fetched org data (dashboard.js's manager branch
// already loads these) — avoids this module re-fetching them itself, and
// keeps getDashboardData a pure function of its inputs.
export async function getDashboardData(period, { teams = [], users = [] } = {}){
  const range = resolvePeriodRange(period);
  const { from, to } = range;

  // Manager-only caller (ARCHITECTURE.md §12 — "Manager Dashboard"). Every
  // query below is provable because rules/firestore.rules' submissions read
  // rule is `isAuth() && sameOrg() && (role()=='manager' || ...)` — the
  // role()=='manager' branch is a REQUEST-time fact (one get() on the
  // caller's own doc, independent of which result document is being
  // evaluated), so it's a valid unconditional escape hatch through the
  // whole rule regardless of what sameOrg() would otherwise require for a
  // non-manager caller. This is NOT just theory: Step 8's review
  // specifically challenged this reasoning (queries with no orgId filter
  // "cannot prove sameOrg()"), so all four shapes below were re-verified
  // live against the CURRENTLY-PUBLISHED submissions rule (unchanged by
  // this session) as the manager account — bare, status-equality-only,
  // createdAt-range-only, and claimedAt-range-only ALL returned real
  // results, zero permission-denied. The one and only failure observed is
  // the status+activatedAt combo, and its error code is 'failed-precondition'
  // ("requires an index") — a DIFFERENT error family from 'permission-denied'
  // — confirming it is purely a missing-index gap, not a rules gap. This
  // reconciles with js/queue.js's own bare `collection(db,'submissions')`
  // list (no orgId filter either) working today: there is no read-side
  // gateway anywhere in this codebase that injects an orgId filter — both
  // that query and these three rely on the exact same manager-branch
  // mechanism, on the exact same collection's rule.
  //
  // Composite index needed once Step 8 publishes rules (equality + range on
  // two different fields): submissions (status ASC, activatedAt ASC) — no
  // orgId field in this index, since none of these queries filter on it.
  // createdAt-range-only and claimedAt-range-only are single-field ranges —
  // auto-indexed, no composite needed, also verified live.
  const [activatedSnap, createdSnap, claimedSnap] = await Promise.all([
    getDocs(query(collection(db,'submissions'), where('status','==','activated'), where('activatedAt','>=',from), where('activatedAt','<=',to))),
    getDocs(query(collection(db,'submissions'), where('createdAt','>=',from), where('createdAt','<=',to))),
    getDocs(query(collection(db,'submissions'), where('claimedAt','>=',from), where('claimedAt','<=',to)))
  ]);
  const activated = activatedSnap.docs.map(d=>({id:d.id,...d.data()}));
  const created    = createdSnap.docs.map(d=>({id:d.id,...d.data()}));
  const claimed     = claimedSnap.docs.map(d=>({id:d.id,...d.data()}));

  const teamById = {}; teams.forEach(t=>teamById[t.id]=t);
  const userById = {}; users.forEach(u=>userById[u.id]=u);

  // ── Totals + byTeam + byContributor — activated lines only, AED = mrc ──
  let activatedAed = 0;
  const byTeamMap = {}, byContribMap = {};
  activated.forEach(s => {
    const aed = Number(s.mrc)||0;
    activatedAed += aed;

    const teamKey = s.teamId || 'none';
    const t = byTeamMap[teamKey] || (byTeamMap[teamKey] = { teamId: s.teamId||null, teamName: teamById[s.teamId]?.name || 'Unassigned', aed:0, count:0 });
    t.aed += aed; t.count++;

    // Attribution rule (ARCHITECTURE.md §13, Session B5 — replaces the B4
    // accTransfer-based proxy): a normal line credits the submitting agent;
    // a sourcedBy-flagged line (brought in by an external partner/
    // freelancer/subcontractor, not the normal funnel) credits that
    // partner instead, falling back to "Outsourced Revenue" when no partner
    // name was recorded. accTransfer is deliberately NOT read here anymore
    // — it's an operational account-takeover marker (custody moving from a
    // losing partner to us, reversible by du), orthogonal to sourcing;
    // crediting revenue to fromPartner (often the losing competitor) was
    // wrong by design, not just imprecise. See js/submissions.js for where
    // sourcedBy is captured (create-time only, same pattern accTransfer
    // already used).
    const isExternal = !!s.sourcedBy?.flag;
    const key  = isExternal ? (s.sourcedBy.partnerName || 'Outsourced Revenue') : (s.agentId || 'unknown');
    const name = isExternal ? (s.sourcedBy.partnerName || 'Outsourced Revenue') : (s.agentName || 'Unknown');
    const c = byContribMap[key] || (byContribMap[key] = { key, name, type: isExternal?'partner':'agent', aed:0, count:0 });
    c.aed += aed; c.count++;
  });

  // ── Sales agent role metrics: AED closed (activated) + lines submitted (created) ──
  const agentMetrics = {};
  function am(id,name){ return agentMetrics[id] || (agentMetrics[id] = { userId:id, name, aedClosed:0, linesSubmitted:0 }); }
  activated.forEach(s => { if(userById[s.agentId]?.role==='agent') am(s.agentId, s.agentName).aedClosed += Number(s.mrc)||0; });
  created.forEach(s   => { if(userById[s.agentId]?.role==='agent') am(s.agentId, s.agentName).linesSubmitted++; });

  // ── Backend role metrics: queue wait (created->claimed), handling time
  // (claimed->submittedToDu), du turnaround (submittedToDu->activated — this
  // is du's own clock, NOT the backend agent's performance; label it that
  // way wherever it renders, Step 6). Each *Hours field is an array of raw
  // samples so the UI can average — avg() returns null (N/A) rather than 0
  // when a backend agent has no qualifying samples this period (pre-B4 data
  // with no claimedAt, or every submission auto-assigned/never explicitly
  // claimed) — never fabricated as a misleadingly-fast zero.
  const backendMetrics = {};
  function bm(id){ return backendMetrics[id] || (backendMetrics[id] = { userId:id, name: userById[id]?.name || '—', submissionsHandled:0, queueWaitHours:[], handlingTimeHours:[], duTurnaroundHours:[] }); }
  claimed.forEach(s => {
    if(userById[s.assignedBackendAgent]?.department !== 'backend') return;
    const m = bm(s.assignedBackendAgent);
    if(s.claimedAt && s.createdAt)      m.queueWaitHours.push(hoursBetween(s.createdAt, s.claimedAt));
    if(s.claimedAt && s.submittedToDuAt) m.handlingTimeHours.push(hoursBetween(s.claimedAt, s.submittedToDuAt));
  });
  activated.forEach(s => {
    if(userById[s.assignedBackendAgent]?.department !== 'backend') return;
    const m = bm(s.assignedBackendAgent);
    m.submissionsHandled++;
    if(s.submittedToDuAt && s.activatedAt) m.duTurnaroundHours.push(hoursBetween(s.submittedToDuAt, s.activatedAt));
  });
  const backendRows = Object.values(backendMetrics).map(m => ({
    userId: m.userId, name: m.name,
    submissionsHandled: m.submissionsHandled,
    queueWaitAvgHours: avg(m.queueWaitHours),
    handlingTimeAvgHours: avg(m.handlingTimeHours),
    duTurnaroundAvgHours: avg(m.duTurnaroundHours)
  }));

  // ── Donuts/KPIs: presets from rollups, custom from the live scan above ──
  // roleMetrics is ALWAYS the live computation (below), unchanged in both
  // modes. Preset totals/byTeam/byContributor come from the rollup docs; the
  // live byTeamMap/byContribMap/activatedAed are still computed above (the
  // activated scan feeds roleMetrics regardless) and used only for CUSTOM.
  let outTotals, outByTeam, outByContributor;
  if(PRESETS.has(period)){
    const roll = await readPresetRollups(period);
    outTotals = { activatedAed: roll.totals.aedActivated, activatedCount: roll.totals.linesActivated };
    outByTeam = Object.entries(roll.byTeam).map(([teamId,v]) => ({
      teamId: teamId==='none' ? null : teamId,
      teamName: teamById[teamId]?.name || (teamId==='none' ? 'Unassigned' : teamId),
      aed: v.aed, count: v.count
    })).sort((a,b)=>b.aed-a.aed);
    outByContributor = Object.entries(roll.byContributor).map(([key,v]) => ({
      key, name: v.label || key, type: v.type || 'agent', aed: v.aed, count: v.count
    })).sort((a,b)=>b.aed-a.aed);
  } else {
    outTotals = { activatedAed, activatedCount: activated.length };
    outByTeam = Object.values(byTeamMap).sort((a,b)=>b.aed-a.aed);
    outByContributor = Object.values(byContribMap).sort((a,b)=>b.aed-a.aed);
  }

  return {
    period: range,
    totals: outTotals,
    byTeam: outByTeam,
    byContributor: outByContributor,
    roleMetrics: {
      agents: Object.values(agentMetrics).sort((a,b)=>b.aedClosed-a.aedClosed),
      backend: backendRows.sort((a,b)=>b.submissionsHandled-a.submissionsHandled),
      // Reserved placeholders — escalations module + KAM role ship in Phase E
      // (ARCHITECTURE.md §12). Present now so Step 6's card layout has a
      // stable slot to render "Coming with escalations module" into.
      kam: []
    }
  };
}
