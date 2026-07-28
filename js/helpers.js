import { SP } from './state.js';

// ════════════════════════════════════════════════════
// GENERIC HELPERS
// ════════════════════════════════════════════════════
export function v(id){ const el=document.getElementById(id); return el?(el.value||'').trim():''; }
// Session P0 (ARCHITECTURE.md §18). This used to round-trip through a
// detached div — `d.textContent = s; return d.innerHTML` — which escapes
// `&`, `<` and `>` but NOT quotes, because a text node has no need to
// escape them. Every `value="${esc(...)}"` and `data-*="${esc(...)}"` site
// in this codebase (there are dozens) was therefore attribute-breakable by
// a single `"` in the data: `" onmouseover="…` closes the attribute and
// opens a new one, with no `<` involved for the old esc() to catch.
//
// Quotes are now escaped explicitly. `&` must be replaced FIRST, or it
// would re-escape the ampersands introduced by the later replacements.
//
// The `String(s||'')` coercion is deliberately preserved verbatim rather
// than modernized to `??` — `esc(0)` returns '' today and several call
// sites rely on that falsy-to-empty behaviour; changing it here would be
// an unrelated rendering change riding a security fix.
//
// Output is HTML-context only. Do not feed esc() into CSV cells, clipboard
// text, or anything else that is not parsed as HTML — the entities would
// render literally. (Checked at the time of writing: nothing does. CSV
// export uses reports.js's csvEscape() on raw values, and queue.js's copy
// tools read `dataset.copy`, which the browser has already HTML-decoded.)
export function esc(s){
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
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

// A <select> sitting near the bottom of a scrollable modal body can have its
// native options popup clipped/pushed off-screen in some environments —
// there's little room below it and nothing forces the browser to reconsider.
// Centering the element in the viewport on focus (fires for mouse AND
// keyboard activation, before the popup opens) guarantees equal room on both
// sides regardless of where the field happened to land, without touching the
// native <select> itself — keyboard/screen-reader behavior is unaffected.
export function fixSelectScrollClip(id){
  const el = document.getElementById(id);
  if(el) el.addEventListener('focus', function(){ this.scrollIntoView({block:'center', behavior:'instant'}); });
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
// CONTRACT (Session P0, ARCHITECTURE.md §18):
//   `title` is TEXT — it is assigned to textContent and must be passed RAW.
//   `html` is HTML — it is assigned to innerHTML and every interpolated value
//   in it must already be esc()'d by the caller.
//
// Twenty-three call sites used to pass esc(...) into `title`, which produced
// visible double-escaping: a company called "O'Brien Trading" rendered as
// "O&#39;Brien Trading" in the modal header. Harmless-looking, but it is the
// tell for a real confusion about which sink is which, and it got worse the
// moment esc() started escaping quotes — before that, esc() left apostrophes
// alone and the bug only showed on the rarer < and >. Fixed at the call sites
// rather than by unescaping here: a sink that quietly undoes escaping is how
// you get an XSS hole the next time someone changes this function.
//
// If m-title is ever changed to innerHTML, every one of those call sites
// becomes an injection point. Don't.
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

// Same contract as modal(): `title` is raw TEXT (textContent), and `msg` is
// raw TEXT too — it is esc()'d HERE, so callers must not pre-escape it either.
export function confirmModal(title, msg, onYes, danger=true){
  modal(title, `<p class="text-dim" style="margin-bottom:16px">${esc(msg)}</p>
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
