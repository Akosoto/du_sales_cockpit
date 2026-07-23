import './auth.js';
import { CP, TAB, setTab } from './state.js';
import { renderOrgTab } from './org.js';
import { renderDashboardTab } from './dashboard.js';
import { renderPipelineTab } from './leads.js';
import { renderScriptsSection } from './scripts.js';
import { renderProductsSection } from './products.js';
import { renderQueueTab } from './queue.js';
import { renderReportsTab } from './reports.js';

// isActiveBackend, client-side mirror of the rules helper of the same name —
// department is independent of role (a backend coordinator might still be
// role:'team_lead', for instance), so this is never folded into the role
// switch below.
function isBackendUser(){ return CP.department === 'backend' && CP.active !== false; }

// ════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════
function getTabs(){
  const r = CP.role;
  const queueTab = (r==='manager' || isBackendUser()) ? [['queue','📥 Queue']] : [];
  if(r==='manager')   return [['org','🏢 Org & Teams'], ...queueTab, ['dashboard','📊 Dashboard'],['reports','📈 Reports'],['pipeline','📋 Pipeline'],['scripts','📞 Scripts'],['products','📦 Products']];
  if(r==='team_lead') return [...queueTab, ['dashboard','📊 Dashboard'],['pipeline','📋 Pipeline'],['scripts','📞 Scripts'],['products','📦 Products']];
  return [...queueTab, ['dashboard','📊 Dashboard'],['pipeline','📋 My Pipeline'],['scripts','📞 Scripts'],['products','📦 Products']];
}

export function renderNav(){
  const nav = document.getElementById('nav');
  nav.innerHTML = getTabs().map(([id,label]) =>
    `<button class="tab-btn ${id===TAB?'active':''}" data-t="${id}">${label}</button>`
  ).join('');
  nav.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.t));
}

export function switchTab(id){
  setTab(id); renderNav();
  document.getElementById('content').innerHTML = '<div class="loading"><div class="spin"></div> Loading…</div>';
  if(id==='org')           renderOrgTab();
  else if(id==='queue')    renderQueueTab();
  else if(id==='dashboard')renderDashboardTab();
  else if(id==='reports')  renderReportsTab();
  else if(id==='pipeline') renderPipelineTab();
  else if(id==='scripts')  renderScriptsSection();
  else if(id==='products') renderProductsSection();
}
