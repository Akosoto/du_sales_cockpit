import { SP } from './state.js';

// ════════════════════════════════════════════════════
// GENERIC HELPERS
// ════════════════════════════════════════════════════
export function v(id){ const el=document.getElementById(id); return el?(el.value||'').trim():''; }
export function esc(s){ const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }
export function now(){ return new Date().toISOString(); }
export function fmtDate(iso){ try{ return new Date(iso).toLocaleDateString('en-AE',{day:'2-digit',month:'short',year:'numeric'}); }catch(e){return iso;} }
export function disable(id,txt){ const b=document.getElementById(id); if(b){b.disabled=true;b.textContent=txt;} }
export function enable(id,txt){  const b=document.getElementById(id); if(b){b.disabled=false;b.textContent=txt;} }
export function stagePill(s){ return `<span class="sp ${SP[s]||''}">${s}</span>`; }
export function calculateTLTarget(tlId, users){
  if(!tlId) return 0;
  return users
    .filter(u => u.role === 'agent' && u.tlId === tlId && u.active !== false)
    .reduce((sum, u) => sum + (Number(u.monthlyTarget) || 0), 0);
}

// ════════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════════
let _tt = null;
export function toast(msg, type='ok'){
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `show ${type}`;
  clearTimeout(_tt); _tt = setTimeout(()=> el.className='', 3200);
}

// ════════════════════════════════════════════════════
// MODAL
// ════════════════════════════════════════════════════
export function modal(title, html, wide=false){
  document.getElementById('m-title').textContent = title;
  document.getElementById('m-body').innerHTML = html;
  document.getElementById('m-box').className = wide ? 'm-box wide' : 'm-box';
  document.getElementById('modal').style.display = 'flex';
}
export function closeModal(){
  document.getElementById('modal').style.display = 'none';
  document.getElementById('m-body').innerHTML = '';
}
document.getElementById('m-close').onclick = closeModal;
document.getElementById('modal').onclick = e => { if(e.target.id==='modal') closeModal(); };
document.addEventListener('click', e => {
  if(!e.target.closest('.ms-wrap'))
    document.querySelectorAll('.ms-dd.open').forEach(d=>d.classList.remove('open'));
});

export function confirmModal(title, msg, onYes, danger=true){
  modal(title, `<p class="text-dim" style="margin-bottom:16px">${msg}</p>
    <div class="flex gap-8">
      <button class="btn ${danger?'btn-danger':'btn-primary'}" id="yes-btn">Confirm</button>
      <button class="btn btn-ghost" onclick="document.getElementById('modal').style.display='none'">Cancel</button>
    </div>`);
  document.getElementById('yes-btn').onclick = onYes;
}

// ════════════════════════════════════════════════════
// MULTI-SELECT FILTER HELPERS
// ════════════════════════════════════════════════════
export function buildMsFilter(wrapId, labelText, opts){
  if(!opts.length) return '';
  return `<div class="ms-wrap" id="${wrapId}">
    <button class="ms-btn" id="${wrapId}-btn" type="button">${labelText}: <span id="${wrapId}-lbl">All</span> ▾</button>
    <div class="ms-dd" id="${wrapId}-dd">
      ${opts.map(o=>`<div class="ms-item"><input type="checkbox" value="${esc(o.id)}"> ${esc(o.name)}</div>`).join('')}
    </div>
  </div>`;
}

export function wireMsFilter(wrapId, arr, onchange){
  const btn = document.getElementById(`${wrapId}-btn`);
  const dd  = document.getElementById(`${wrapId}-dd`);
  if(!btn||!dd) return;
  btn.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('open'); });
  dd.addEventListener('click', e => {
    e.stopPropagation();
    const item = e.target.closest('.ms-item');
    if(!item) return;
    const cb = item.querySelector('input[type=checkbox]');
    if(!cb) return;
    if(e.target !== cb) cb.checked = !cb.checked;
    arr.length = 0;
    dd.querySelectorAll('input[type=checkbox]:checked').forEach(c => arr.push(c.value));
    const lbl = document.getElementById(`${wrapId}-lbl`);
    if(lbl) lbl.textContent = arr.length ? `${arr.length} sel.` : 'All';
    btn.classList.toggle('has-sel', arr.length > 0);
    onchange();
  });
}
