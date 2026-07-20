import { db, collection, query, where, getDocs } from './state.js';

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

// {teams, users}: already-fetched org data (dashboard.js's manager branch
// already loads these) — avoids this module re-fetching them itself, and
// keeps getDashboardData a pure function of its inputs.
export async function getDashboardData(period, { teams = [], users = [] } = {}){
  const range = resolvePeriodRange(period);
  const { from, to } = range;

  // Manager-only caller (ARCHITECTURE.md §12 — "Manager Dashboard"). Every
  // query below is provable because rules/firestore.rules' submissions read
  // rule is `isAuth() && sameOrg() && (role()=='manager' || ...)` — the
  // role()=='manager' branch doesn't reference resource.data at all, so
  // Firestore can prove the read for a manager regardless of which extra
  // where() filters are attached (same established pattern as js/queue.js's
  // bare submissions list and js/org.js's bare collection queries).
  //
  // Composite index needed once Step 8 publishes rules (equality + range on
  // two different fields): submissions (status ASC, activatedAt ASC).
  // createdAt-range-only and claimedAt-range-only are single-field ranges —
  // auto-indexed, no composite needed.
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

    // Attribution rule (ARCHITECTURE.md §12): assigned leads credit the
    // submitting agent; an accTransfer-flagged line (account brought in via
    // an external partner, not the normal funnel — the only "manager-kept
    // external-source" signal this schema already tracks) credits that
    // partner instead, falling back to the literal "Outsourced Revenue"
    // bucket when no partner name was recorded.
    const isExternal = !!s.accTransfer?.flag;
    const key  = isExternal ? (s.accTransfer.fromPartner || 'Outsourced Revenue') : (s.agentId || 'unknown');
    const name = isExternal ? (s.accTransfer.fromPartner || 'Outsourced Revenue') : (s.agentName || 'Unknown');
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

  return {
    period: range,
    totals: { activatedAed, activatedCount: activated.length },
    byTeam: Object.values(byTeamMap).sort((a,b)=>b.aed-a.aed),
    byContributor: Object.values(byContribMap).sort((a,b)=>b.aed-a.aed),
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
