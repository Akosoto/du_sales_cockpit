import { esc } from './helpers.js';

// ════════════════════════════════════════════════════
// DASHBOARD CHARTS (Session B4 Step 5, ARCHITECTURE.md §12) — reusable,
// dependency-free SVG donut. No charting library: a donut is just N
// <circle> arcs sharing one radius, positioned with stroke-dasharray +
// a rotation transform per segment — cheap enough to hand-roll and avoids
// pulling in a chart dependency for two charts.
// ════════════════════════════════════════════════════

export const CHART_PALETTE = ['#7c3aed','#10b981','#f59e0b','#3b82f6','#ef4444','#ec4899','#14b8a6','#a3e635','#f97316','#06b6d4'];

function donutArcsSvg(values, size=140, strokeWidth=20){
  const total = values.reduce((s,v)=>s+v.value,0);
  const r = (size - strokeWidth) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  if(total <= 0){
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--border2)" stroke-width="${strokeWidth}"/></svg>`;
  }
  let cursor = 0;
  const arcs = values.filter(v=>v.value>0).map(v => {
    const frac = v.value / total;
    const dash = Math.max(frac * circumference - 1.5, 0); // small gap between segments
    const gap = circumference - dash;
    const rotation = (cursor / total) * 360 - 90; // start at 12 o'clock
    cursor += v.value;
    return `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${v.color}" stroke-width="${strokeWidth}" stroke-dasharray="${dash} ${gap}" stroke-linecap="round" transform="rotate(${rotation} ${c} ${c})"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${arcs}</svg>`;
}

// segments: [{name, aed, count}] (byTeam rows use teamName instead of name —
// callers normalize before passing in). mode: 'aed' | 'count' selects which
// field drives both the arcs and the displayed values.
export function renderDonutCard(title, segments, mode){
  const valueOf = s => mode==='count' ? (s.count||0) : (s.aed||0);
  const fmtVal  = v => mode==='count' ? `${v} line${v!==1?'s':''}` : `AED ${Number(v).toLocaleString()}`;
  const total = segments.reduce((s,x)=>s+valueOf(x),0);

  if(!segments.length || total<=0){
    return `<div class="section-card">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px">${esc(title)}</div>
      <div class="empty"><div class="empty-icon">📊</div><div class="empty-title">No activated lines this period</div></div>
    </div>`;
  }

  const colored = segments.map((s,i)=>({ ...s, color: CHART_PALETTE[i % CHART_PALETTE.length] }));
  const donut = donutArcsSvg(colored.map(s=>({ value: valueOf(s), color: s.color })));
  const legend = colored.map(s => {
    const v = valueOf(s), pct = total ? Math.round(v/total*100) : 0;
    return `<div class="flex gap-8" style="align-items:center;margin-bottom:8px">
      <span style="width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0"></span>
      <span style="flex:1;font-size:12px;color:var(--t1)">${esc(s.name)}</span>
      <span style="font-size:12px;color:var(--t2);white-space:nowrap">${fmtVal(v)} · ${pct}%</span>
    </div>`;
  }).join('');

  return `<div class="section-card">
    <div style="font-weight:700;font-size:14px;margin-bottom:12px">${esc(title)}</div>
    <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
      <div style="position:relative;flex-shrink:0;width:140px;height:140px">
        ${donut}
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
          <div style="font-size:1rem;font-weight:700;line-height:1.2">${mode==='count'?total:`AED ${Number(total).toLocaleString()}`}</div>
          <div style="font-size:9px;color:var(--t2)">${mode==='count'?'Total Lines':'Total AED'}</div>
        </div>
      </div>
      <div style="flex:1;min-width:180px">${legend}</div>
    </div>
  </div>`;
}
