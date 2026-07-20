import { esc } from './helpers.js';

// ════════════════════════════════════════════════════
// ROLE METRICS CARDS (Session B4 Step 6, ARCHITECTURE.md §12) — reads
// getDashboardData(period).roleMetrics (Step 4). Sales-agent and backend
// definitions are fixed decisions from this session's mandate; KAM/
// escalations is a reserved placeholder only — that module ships in
// Phase E, and the escalation attribution rule (resolver gets credit,
// including backend agents) is recorded in ARCHITECTURE.md §12 now so it's
// not relitigated when that module actually lands.
// ════════════════════════════════════════════════════

// null (no qualifying samples this period) renders as N/A, never a
// fabricated 0 — see js/dashboardData.js's avg().
function fmtHours(h){
  if(h == null) return 'N/A';
  if(h < 48) return `${h.toFixed(1)}h`;
  return `${(h/24).toFixed(1)}d`;
}

function agentCardsHtml(agents){
  if(!agents.length) return '<p class="text-dim text-xs">No agent activity this period.</p>';
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>Agent</th><th>AED Closed</th><th>Lines Submitted</th></tr></thead>
    <tbody>${agents.map(a=>`<tr>
      <td>${esc(a.name)}</td>
      <td style="color:var(--green)">AED ${Number(a.aedClosed).toLocaleString()}</td>
      <td>${a.linesSubmitted}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function backendCardsHtml(backend){
  if(!backend.length) return '<p class="text-dim text-xs">No backend activity this period.</p>';
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>Backend Agent</th><th>Submissions Handled</th><th>Queue Wait (avg)</th><th>Handling Time (avg)</th><th>du Turnaround (avg)</th></tr></thead>
    <tbody>${backend.map(b=>`<tr>
      <td>${esc(b.name)}</td>
      <td>${b.submissionsHandled}</td>
      <td>${fmtHours(b.queueWaitAvgHours)}</td>
      <td>${fmtHours(b.handlingTimeAvgHours)}</td>
      <td>${fmtHours(b.duTurnaroundAvgHours)}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="text-dim text-xs mt-8">du Turnaround is du's own processing clock (submittedToDu → activated) — it measures du's speed, not this agent's performance.</p>`;
}

export function renderRoleMetricsSection(roleMetrics){
  return `
    <div class="section-card" style="margin-bottom:14px">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px">👤 Sales Agent Performance</div>
      ${agentCardsHtml(roleMetrics.agents)}
    </div>
    <div class="section-card" style="margin-bottom:14px">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px">🎧 Backend Performance</div>
      ${backendCardsHtml(roleMetrics.backend)}
    </div>
    <div class="section-card" style="margin-bottom:14px;opacity:.6">
      <div style="font-weight:700;font-size:14px;margin-bottom:4px">🏅 KAM / Escalations</div>
      <p class="text-dim text-xs">Coming with the escalations module (Phase E). Attribution rule already fixed: whoever resolves an escalation gets the credit — including backend agents.</p>
    </div>`;
}
