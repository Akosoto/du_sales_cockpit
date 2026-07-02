import './auth.js';
import { CP, TAB, setTab } from './state.js';
import { renderOrgTab } from './org.js';
import { renderDashboardTab } from './dashboard.js';
import { renderPipelineTab } from './leads.js';
import { renderScriptsSection } from './scripts.js';
import { renderProductsSection } from './products.js';

// ════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════
function getTabs(){
  const r = CP.role;
  if(r==='manager')   return [['org','🏢 Org & Teams'],['dashboard','📊 Dashboard'],['pipeline','📋 Pipeline'],['scripts','📞 Scripts'],['products','📦 Products']];
  if(r==='team_lead') return [['dashboard','📊 Dashboard'],['pipeline','📋 Pipeline'],['scripts','📞 Scripts'],['products','📦 Products']];
  return [['dashboard','📊 Dashboard'],['pipeline','📋 My Pipeline'],['scripts','📞 Scripts'],['products','📦 Products']];
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
  else if(id==='dashboard')renderDashboardTab();
  else if(id==='pipeline') renderPipelineTab();
  else if(id==='scripts')  renderScriptsSection();
  else if(id==='products') renderProductsSection();
}
