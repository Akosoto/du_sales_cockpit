import {
  db, CU, CP,
  collection, query, where, getDocs
} from './state.js';
import { dbAdd, dbUpdate, newBatch, batchAdd } from './db.js';
import { v, esc, now, fmtDate, disable, enable, toast, modal, closeModal, confirmModal } from './helpers.js';
import {
  currentCategories, categoryLabel, currentTermLabels, termLabel, loadOrgConfig, saveOrgConfig, withOrgConfigSave,
  currentFamilies, familyLabel, findFamilyIdByLabel, DEFAULT_FAMILIES, DEFAULT_FAMILY_MAPPING
} from './orgConfig.js';

// ════════════════════════════════════════════════════
// PRODUCTS — SEED DATA  (du Business, June 2026)
// Sources: STARTER_BTL_V12/JULY_2025, AP-ENT-BUS-FIX-SER-MAY2019,
//          ENT-ULT-BTL-SEP-2025, BMP_2024 (header dated 2023)
// ════════════════════════════════════════════════════
const SEED_PRODUCTS = [
  // ── Starter ──────────────────────────────────────
  { category:'starter', name:'Starter',
    pricingOptions:[{term:12,label:'12-month contract',price:299}],
    activationFee:200,
    specs:{ 'Internet':'Unlimited usage, full speed', 'Router':'5G enabled, Gigabit Ethernet port', 'Voice':'Not included' },
    sourceDoc:'STARTER_BTL_V12/JULY_2025',
    notes:'Add-ons (intl. minute bundles, .ae domain hosting) tracked separately — ask manager.',
    discounts:[{ id:'d_seed_starter', appliesToTerm:12, appliesToTermLabel:'12-month contract',
      price:249, percentage:17, validFrom:'2025-07-01', validTo:null,
      conditions:'Promotional price applies for the full 12-month contract period.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-07-01T00:00:00.000Z' }] },

  { category:'starter', name:'Starter Pro',
    pricingOptions:[{term:12,label:'12-month contract',price:499}],
    activationFee:200,
    specs:{ 'Internet':'Unlimited usage, full speed', 'Router':'5G enabled, Gigabit Ethernet port',
      'Voice':'1 business landline, unlimited national landline-to-landline, 250 national minutes',
      'Free with plan':'Landline handset, Microsoft 365 Basic (1 user), .ae domain registration' },
    sourceDoc:'STARTER_BTL_V12/JULY_2025',
    notes:'Add-ons (intl. minute bundles, .ae domain hosting) tracked separately — ask manager.',
    discounts:[{ id:'d_seed_starterpro', appliesToTerm:12, appliesToTermLabel:'12-month contract',
      price:399, percentage:20, validFrom:'2025-07-01', validTo:null,
      conditions:'AED 279.3 applies for the first 6 months of the 12-month term, then reverts to AED 399 for the remaining 6 months.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-07-01T00:00:00.000Z' }] },

  // ── Essential ────────────────────────────────────
  { category:'essential', name:'Essential 80 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:810},{term:0,label:'No contract',price:1450}],
    activationFee:200, specs:{ 'Speed':'80/10 Mbps' },
    sourceDoc:'AP-ENT-BUS-FIX-SER-MAY2019',
    notes:'Source sheet dated 2019 — confirm against current du.ae pricing before quoting.',
    discounts:[] },

  { category:'essential', name:'Essential 120 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:950},{term:0,label:'No contract',price:1850}],
    activationFee:200, specs:{ 'Speed':'120/15 Mbps' },
    sourceDoc:'AP-ENT-BUS-FIX-SER-MAY2019',
    notes:'Subject to technical availability and site survey. Source sheet dated 2019 — confirm before quoting.',
    discounts:[] },

  { category:'essential', name:'Essential 175 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:1250},{term:0,label:'No contract',price:2250}],
    activationFee:200, specs:{ 'Speed':'175/25 Mbps' },
    sourceDoc:'AP-ENT-BUS-FIX-SER-MAY2019',
    notes:'Subject to technical availability and site survey. Source sheet dated 2019 — confirm before quoting.',
    discounts:[] },

  { category:'essential', name:'Essential 275 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:1550},{term:0,label:'No contract',price:2850}],
    activationFee:200, specs:{ 'Speed':'275/30 Mbps' },
    sourceDoc:'AP-ENT-BUS-FIX-SER-MAY2019',
    notes:'Subject to technical availability and site survey. Source sheet dated 2019 — confirm before quoting.',
    discounts:[] },

  { category:'essential', name:'Essential 500 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:2990},{term:0,label:'No contract',price:3650}],
    activationFee:200, specs:{ 'Speed':'500/50 Mbps' },
    sourceDoc:'AP-ENT-BUS-FIX-SER-MAY2019',
    notes:'Subject to technical availability and site survey. Source sheet dated 2019 — confirm before quoting.',
    discounts:[] },

  // ── Ultimate ─────────────────────────────────────
  { category:'ultimate', name:'Ultimate 200 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:1049},{term:24,label:'24-month contract',price:949}],
    activationFee:200,
    specs:{ 'Speed':'200/40 Mbps','Router':'Basic','Business Voice':'1 Business Line','Desk Phone':'1 Cordless Phone',
      'Microsoft 365 Licenses':'2','Antivirus Licenses':'3','Included Add-ons':'1 (Access Point or Handset Voucher)' },
    sourceDoc:'ENT-ULT-BTL-SEP-2025',
    notes:'All Ultimate tiers include: unlimited landline + 100 mobile + 100 intl. minutes, firewall, 1-yr e-Commerce Starter Kit, 1 .ae domain.',
    discounts:[] },

  { category:'ultimate', name:'Ultimate 400 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:1399},{term:24,label:'24-month contract',price:1299}],
    activationFee:200,
    specs:{ 'Speed':'400/80 Mbps','Router':'Advanced','Business Voice':'1 Business Line','Desk Phone':'1 Cordless Phone',
      'Microsoft 365 Licenses':'3','Antivirus Licenses':'3','Included Add-ons':'1 (Access Point or Handset Voucher)' },
    sourceDoc:'ENT-ULT-BTL-SEP-2025',
    notes:'All Ultimate tiers include: unlimited landline + 100 mobile + 100 intl. minutes, firewall, 1-yr e-Commerce Starter Kit, 1 .ae domain.',
    discounts:[{ id:'d_seed_ult400', appliesToTerm:12, appliesToTermLabel:'12-month contract',
      price:979.3, percentage:30, validFrom:'2025-09-01', validTo:null,
      conditions:'30% off for the first 6 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' },
      { id:'d_seed_ult400_24', appliesToTerm:24, appliesToTermLabel:'24-month contract',
      price:909.3, percentage:30, validFrom:'2025-09-01', validTo:null,
      conditions:'30% off for the first 6 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' }] },

  { category:'ultimate', name:'Ultimate 600 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:1799},{term:24,label:'24-month contract',price:1699}],
    activationFee:200,
    specs:{ 'Speed':'600/120 Mbps','Router':'Advanced','Business Voice':'1 Business Line','Desk Phone':'1 Cordless Phone',
      'Microsoft 365 Licenses':'4','Antivirus Licenses':'5','Included Add-ons':'1 (Access Point or Handset Voucher)' },
    sourceDoc:'ENT-ULT-BTL-SEP-2025',
    notes:'All Ultimate tiers include: unlimited landline + 100 mobile + 100 intl. minutes, firewall, 1-yr e-Commerce Starter Kit, 1 .ae domain.',
    discounts:[{ id:'d_seed_ult600', appliesToTerm:12, appliesToTermLabel:'12-month contract',
      price:1259.3, percentage:30, validFrom:'2025-09-01', validTo:null,
      conditions:'30% off for the first 6 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' },
      { id:'d_seed_ult600_24', appliesToTerm:24, appliesToTermLabel:'24-month contract',
      price:1189.3, percentage:30, validFrom:'2025-09-01', validTo:null,
      conditions:'30% off for the first 6 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' }] },

  { category:'ultimate', name:'Ultimate 800 Mbps',
    pricingOptions:[{term:12,label:'12-month contract',price:2399},{term:24,label:'24-month contract',price:2299}],
    activationFee:200,
    specs:{ 'Speed':'800/160 Mbps','Router':'Pro','Business Voice':'1 Trunk Line + 1 Extension','Desk Phone':'2 Cordless Phones',
      'Microsoft 365 Licenses':'5','Antivirus Licenses':'10','Included Add-ons':'2 (Access Point or Handset Voucher)' },
    sourceDoc:'ENT-ULT-BTL-SEP-2025',
    notes:'All Ultimate tiers include: unlimited landline + 100 mobile + 100 intl. minutes, firewall, 1-yr e-Commerce Starter Kit, 1 .ae domain.',
    discounts:[{ id:'d_seed_ult800', appliesToTerm:12, appliesToTermLabel:'12-month contract',
      price:959.6, percentage:60, validFrom:'2025-09-01', validTo:null,
      conditions:'60% off for the first 3 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' },
      { id:'d_seed_ult800_24', appliesToTerm:24, appliesToTermLabel:'24-month contract',
      price:919.6, percentage:60, validFrom:'2025-09-01', validTo:null,
      conditions:'60% off for the first 3 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' }] },

  { category:'ultimate', name:'Ultimate 1 Gbps',
    pricingOptions:[{term:12,label:'12-month contract',price:3299},{term:24,label:'24-month contract',price:3149}],
    activationFee:200,
    specs:{ 'Speed':'1 Gbps/200 Mbps','Router':'Pro','Business Voice':'1 Trunk Line + 2 Extensions','Desk Phone':'3 Cordless Phones',
      'Microsoft 365 Licenses':'8','Antivirus Licenses':'20','Included Add-ons':'3 (Access Point or Handset Voucher)' },
    sourceDoc:'ENT-ULT-BTL-SEP-2025',
    notes:'All Ultimate tiers include: unlimited landline + 100 mobile + 100 intl. minutes, firewall, 1-yr e-Commerce Starter Kit, 1 .ae domain.',
    discounts:[{ id:'d_seed_ult1g', appliesToTerm:12, appliesToTermLabel:'12-month contract',
      price:1319.6, percentage:60, validFrom:'2025-09-01', validTo:null,
      conditions:'60% off for the first 3 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' },
      { id:'d_seed_ult1g_24', appliesToTerm:24, appliesToTermLabel:'24-month contract',
      price:1259.6, percentage:60, validFrom:'2025-09-01', validTo:null,
      conditions:'60% off for the first 3 months, reverts to standard rate for the remaining term. Eligibility determined by Business Management — selected customers only.',
      createdBy:'system', createdByName:'Seed', createdAt:'2025-09-01T00:00:00.000Z' }] },

  // ── Mobile (BMP) ─────────────────────────────────
  { category:'mobile', name:'BMP 100 — National',
    pricingOptions:[{term:12,label:'12-month contract',price:100},{term:0,label:'No contract',price:125}],
    activationFee:55,
    specs:{ 'National minutes':'1,100','International minutes':'Not included','National data':'8 GB','National SMS':'130',
      'Business calling circle':'10,000 min pooled' },
    sourceDoc:'BMP_2024',
    notes:'Internet calling pack +AED 50/mo (national+intl. plans get this free) — tracked as add-on, not in core pricing.',
    discounts:[] },

  { category:'mobile', name:'BMP 200 — National',
    pricingOptions:[{term:12,label:'12-month contract',price:200},{term:0,label:'No contract',price:225}],
    activationFee:55,
    specs:{ 'National minutes':'2,000','International minutes':'Not included','National data':'18 GB','National SMS':'200',
      'Business calling circle':'10,000 min pooled' },
    sourceDoc:'BMP_2024', notes:'Internet calling pack free on this tier.',
    discounts:[] },

  { category:'mobile', name:'BMP 100 — National & International',
    pricingOptions:[{term:12,label:'12-month contract',price:100},{term:0,label:'No contract',price:125}],
    activationFee:55,
    specs:{ 'National minutes':'600','International minutes':'200','National data':'8 GB','National SMS':'65','International SMS':'65',
      'Business calling circle':'10,000 min pooled' },
    sourceDoc:'BMP_2024',
    notes:'Internet calling pack +AED 50/mo — tracked as add-on, not in core pricing.',
    discounts:[] },

  { category:'mobile', name:'BMP 200 — National & International',
    pricingOptions:[{term:12,label:'12-month contract',price:200},{term:0,label:'No contract',price:225}],
    activationFee:55,
    specs:{ 'National minutes':'1,000','International minutes':'600','National data':'18 GB','National SMS':'130','International SMS':'130',
      'Business calling circle':'10,000 min pooled' },
    sourceDoc:'BMP_2024', notes:'Internet calling pack free on this tier.',
    discounts:[] },

  { category:'mobile', name:'BMP 325',
    pricingOptions:[{term:12,label:'12-month contract',price:325},{term:0,label:'No contract',price:350}],
    activationFee:55,
    specs:{ 'National minutes':'Unlimited','International minutes':'410','National data':'55 GB','National/Intl SMS':'130/130',
      'Roaming data':'2 GB','Business calling circle':'10,000 min pooled' },
    sourceDoc:'BMP_2024',
    notes:'Identical entitlements whether booked as National or National+International — single SKU. Intl. per-minute rate carries its own promo (AED 2.2→1/min) tracked separately, not as a plan discount.',
    discounts:[] },

  { category:'mobile', name:'BMP 600',
    pricingOptions:[{term:12,label:'12-month contract',price:600},{term:0,label:'No contract',price:700}],
    activationFee:55,
    specs:{ 'National minutes':'Unlimited','International minutes':'Unlimited','National data':'85 GB','National/Intl SMS':'300/300',
      'Roaming':'100 in / 200 out min, 5 GB data','Business calling circle':'10,000 min pooled' },
    sourceDoc:'BMP_2024',
    notes:'Identical entitlements whether booked as National or National+International — single SKU. Intl. per-minute rate carries its own promo (AED 1.8→1/min) tracked separately, not as a plan discount.',
    discounts:[] },

  { category:'mobile', name:'BMP 900',
    pricingOptions:[{term:12,label:'12-month contract',price:900},{term:0,label:'No contract',price:1000}],
    activationFee:55,
    specs:{ 'National minutes':'Unlimited','International minutes':'Unlimited','National data':'Unlimited','National/Intl SMS':'300/300',
      'Roaming':'500 in / 1,000 out min, 40 GB data','Business calling circle':'10,000 min pooled' },
    sourceDoc:'BMP_2024',
    notes:'Identical entitlements whether booked as National or National+International — single SKU. Intl. per-minute rate carries its own promo (AED 1.8→1/min) tracked separately, not as a plan discount.',
    discounts:[] },
];

// ════════════════════════════════════════════════════
// PRODUCTS — HELPERS
// ════════════════════════════════════════════════════
async function seedProducts(){
  const snap = await getDocs(collection(db,'products'));
  if(snap.size > 0) return;
  const bat = newBatch();
  SEED_PRODUCTS.forEach(p => {
    batchAdd(bat, 'products', { ...p, monthlyWaivers:[], active:true, createdByName:CP.name });
  });
  await bat.commit();
}

function activeDiscount(discounts, term){
  const t = now().slice(0,10);
  return (discounts||[]).find(d =>
    d.appliesToTerm===term && (!d.validFrom||d.validFrom<=t) && (!d.validTo||d.validTo>=t)
  ) || null;
}

function parseSpecs(text){
  const out = {};
  (text||'').split('\n').forEach(line=>{
    const i = line.indexOf(':');
    if(i<0) return;
    const k = line.slice(0,i).trim(), val = line.slice(i+1).trim();
    if(k) out[k] = val;
  });
  return out;
}
function specsToText(obj){
  return Object.entries(obj||{}).map(([k,val])=>`${k}: ${val}`).join('\n');
}
function prCatClass(cat){
  const c = (cat||'').toLowerCase();
  if(c==='starter')   return 'pr-cat-starter';
  if(c==='essential') return 'pr-cat-essential';
  if(c==='ultimate')  return 'pr-cat-ultimate';
  if(c==='mobile')    return 'pr-cat-mobile';
  return 'pr-cat-starter';
}

// ════════════════════════════════════════════════════
// PRODUCTS TAB
// ════════════════════════════════════════════════════
export async function renderProductsSection(){
  const ct = document.getElementById('content');
  const role = CP.role;
  const isManager = role==='manager';
  ct.innerHTML = '<div class="loading"><div class="spin"></div> Loading…</div>';

  if(isManager) await seedProducts();

  const snap = await getDocs(query(collection(db,'products'),where('active','==',true)));
  let products = snap.docs.map(d=>({id:d.id,...d.data()}));

  const categories = currentCategories(); // [{id,label}] — org-config, Session B4
  let catFilter = '';

  function filtered(){ return catFilter ? products.filter(p=>p.category===catFilter) : products; }

  function onProductUpdate(updated){
    const idx = products.findIndex(x=>x.id===updated.id);
    if(idx>=0) products[idx]=updated; else products.push(updated);
    renderCards();
  }

  function renderCards(){
    const list = document.getElementById('pr-list');
    if(!list) return;
    const cntEl = document.getElementById('pr-count');
    if(cntEl) cntEl.textContent = `${products.length} product${products.length!==1?'s':''}`;
    const f = filtered();
    if(!f.length){
      list.innerHTML = `<div class="empty"><div class="empty-icon">📦</div>
        <div class="empty-title">No products yet</div>
        <div class="empty-sub">${isManager?'Add your first product to get started.':'Check back soon.'}</div></div>`;
      return;
    }
    list.innerHTML = `<div class="pr-grid">${f.map(p=>{
      const opts = p.pricingOptions||[];
      const priceRows = opts.map(po=>{
        const disc = activeDiscount(p.discounts, po.term);
        return `<div class="pr-price-row">
          <span class="pr-price-term">${esc(termLabel(po.term,po.label))}:</span>
          ${disc
            ? `<span class="pr-price-orig">AED ${po.price}</span><span class="pr-price-now">AED ${disc.price}</span>${disc.percentage?`<span class="text-dim text-xs">(${disc.percentage}% off)</span>`:''}`
            : `<span class="pr-price-now">AED ${po.price}</span>`}
        </div>`;
      }).join('');
      const specEntries = Object.entries(p.specs||{}).slice(0,6);
      const specsHtml = specEntries.length
        ? `<div class="info-grid mt-12">${specEntries.map(([k,val])=>
            `<div class="info-item"><div class="lbl">${esc(k)}</div><div class="val">${esc(val)}</div></div>`).join('')}</div>`
        : '';
      const discCount = (p.discounts||[]).length;
      const wvCount   = (p.monthlyWaivers||[]).length;
      return `<div class="pr-card">
        <div class="flex gap-8" style="flex-wrap:wrap;justify-content:space-between">
          <span class="pr-cat ${prCatClass(p.category)}">${esc(categoryLabel(p.category))}</span>
          <div class="flex gap-8">
            ${discCount?`<span class="pr-sub-badge pr-sub-discount">${discCount} discount${discCount!==1?'s':''}</span>`:''}
            ${wvCount?`<span class="pr-sub-badge pr-sub-waiver">${wvCount} waiver${wvCount!==1?'s':''}</span>`:''}
          </div>
        </div>
        <div style="font-weight:600;font-size:.95rem">${esc(p.name)}</div>
        ${priceRows}
        <p class="text-dim text-xs">Activation: AED ${p.activationFee||0}</p>
        ${specsHtml}
        ${p.notes?`<p class="text-dim text-xs mt-8">${esc(p.notes)}</p>`:''}
        ${isManager?`
          <div class="sc-actions">
            <button class="btn btn-ghost btn-xs" data-pr-edit="${p.id}">✏ Edit</button>
            <button class="btn btn-ghost btn-xs" data-pr-disc="${p.id}">% Discounts</button>
            <button class="btn btn-ghost btn-xs" data-pr-wv="${p.id}">💰 Waivers</button>
            <button class="btn btn-danger btn-xs" data-pr-del="${p.id}">Remove</button>
          </div>`:''}
      </div>`;
    }).join('')}</div>`;

    list.querySelectorAll('[data-pr-edit]').forEach(b=>{
      const p = products.find(x=>x.id===b.dataset.prEdit);
      if(p) b.addEventListener('click',()=>showEditProductModal(p,onProductUpdate));
    });
    list.querySelectorAll('[data-pr-disc]').forEach(b=>{
      const p = products.find(x=>x.id===b.dataset.prDisc);
      if(p) b.addEventListener('click',()=>showManageDiscountsModal(p,onProductUpdate));
    });
    list.querySelectorAll('[data-pr-wv]').forEach(b=>{
      const p = products.find(x=>x.id===b.dataset.prWv);
      if(p) b.addEventListener('click',()=>showManageWaiversModal(p,onProductUpdate));
    });
    list.querySelectorAll('[data-pr-del]').forEach(b=>{
      const pid = b.dataset.prDel;
      const p = products.find(x=>x.id===pid);
      if(!p) return;
      // Soft delete (ARCHITECTURE.md audit item 11) — products are
      // deactivated, not hard-deleted, since a future submission line item
      // can reference a productId as a snapshot even after the catalog entry
      // is retired. The product fetch already scopes to active==true, so a
      // deactivated product disappears from view exactly as before.
      b.addEventListener('click',()=>confirmModal(`Remove "${p.name}"?`,'It will no longer appear in the catalog. Existing submissions referencing it are unaffected.',async()=>{
        await dbUpdate('products', pid, {active:false});
        products = products.filter(x=>x.id!==pid);
        closeModal(); toast('Product removed.','info');
        renderCards();
      }));
    });
  }

  ct.innerHTML = `
    <div class="pg-hdr">
      <div><h2>📦 Products & Pricing</h2><p class="pg-hdr-sub" id="pr-count">${products.length} product${products.length!==1?'s':''}</p></div>
      <div class="pg-actions">
        ${isManager?`<button class="btn btn-ghost btn-sm" id="btn-config-categories">⚙ Categories & Terms</button>
        <button class="btn btn-primary btn-sm" id="btn-add-pr">+ New Product</button>`:''}
      </div>
    </div>
    <div class="filters" id="pr-cat-filters">
      <button class="ch-tag active" data-cat="">All</button>
      ${categories.map(c=>`<button class="ch-tag" data-cat="${c.id}">${esc(c.label)}</button>`).join('')}
    </div>
    <div id="pr-list"></div>`;

  renderCards();

  ct.querySelector('#btn-add-pr')?.addEventListener('click',()=>showAddProductModal(onProductUpdate));
  ct.querySelector('#btn-config-categories')?.addEventListener('click',()=>showCategoryConfigModal(products, ()=>renderProductsSection()));
  ct.querySelectorAll('[data-cat]').forEach(b=>b.addEventListener('click',()=>{
    catFilter = b.dataset.cat;
    ct.querySelectorAll('[data-cat]').forEach(x=>x.classList.toggle('active',x===b));
    renderCards();
  }));
}

// ── ADD PRODUCT (manager) ───────────────────────────
function showAddProductModal(onUpdate){
  modal('New Product', `
    <div class="row2">
      <div class="field"><label>Category*</label>
        <select id="np-cat">
          ${currentCategories().map(c=>`<option value="${c.id}">${esc(c.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Name*</label><input type="text" id="np-name" placeholder="e.g. Essential 80 Mbps"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Activation Fee (AED)</label><input type="number" id="np-act" value="200"></div>
      <div class="field"><label>Source Doc</label><input type="text" id="np-src" placeholder="e.g. ENT-ULT-BTL-SEP-2025"></div>
    </div>
    <div class="divider"></div>
    <p class="text-dim text-xs mb-12">Pricing options — at least one required.</p>
    <div class="row3">
      <div class="field"><label>Term 1 Label*</label><input type="text" id="np-t1-label" placeholder="12-month contract"></div>
      <div class="field"><label>Term (months)</label><input type="number" id="np-t1-term" placeholder="12"></div>
      <div class="field"><label>Price (AED)*</label><input type="number" id="np-t1-price"></div>
    </div>
    <div class="row3">
      <div class="field"><label>Term 2 Label</label><input type="text" id="np-t2-label" placeholder="No contract"></div>
      <div class="field"><label>Term (months)</label><input type="number" id="np-t2-term" placeholder="0"></div>
      <div class="field"><label>Price (AED)</label><input type="number" id="np-t2-price"></div>
    </div>
    <div class="divider"></div>
    <div class="field"><label>Specs (one per line, "Label: Value")</label>
      <textarea id="np-specs" rows="6" placeholder="Speed: 80/10 Mbps&#10;Router: Basic"></textarea>
    </div>
    <div class="field"><label>Notes</label><input type="text" id="np-notes" placeholder="e.g. Add-ons catalog available separately"></div>
    <p id="np-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="np-btn">Create Product</button>`, true);

  document.getElementById('np-btn').onclick = async () => {
    const category=v('np-cat'), name=v('np-name');
    const err = document.getElementById('np-err');
    if(!name){ err.textContent='Name is required.'; return; }
    const t1label=v('np-t1-label'), t1price=v('np-t1-price');
    if(!t1label||!t1price){ err.textContent='At least one pricing option (label + price) is required.'; return; }
    disable('np-btn','Creating…');
    try{
      const pricingOptions=[{term:Number(v('np-t1-term'))||12, label:t1label, price:Number(t1price)}];
      if(v('np-t2-label')&&v('np-t2-price')){
        pricingOptions.push({term:Number(v('np-t2-term'))||0, label:v('np-t2-label'), price:Number(v('np-t2-price'))});
      }
      const payload={
        category, name, specs:parseSpecs(v('np-specs')),
        pricingOptions, activationFee:Number(v('np-act'))||0,
        sourceDoc:v('np-src'), notes:v('np-notes'),
        active:true, discounts:[], monthlyWaivers:[],
        createdByName:CP.name
      };
      const ref=await dbAdd('products', payload);
      closeModal(); toast('Product created.');
      onUpdate({id:ref.id,...payload,createdBy:CU.uid,createdAt:now(),lastEditedBy:CP.name,lastEditedAt:now()});
    }catch(e){ err.textContent=e.message; enable('np-btn','Create Product'); }
  };
}

// ── EDIT PRODUCT (manager) ──────────────────────────
function showEditProductModal(p, onUpdate){
  const t1=(p.pricingOptions||[])[0], t2=(p.pricingOptions||[])[1];
  modal(`Edit: ${p.name}`, `
    <div class="row2">
      <div class="field"><label>Category*</label>
        <select id="ep-cat">
          ${currentCategories().map(c=>`<option value="${c.id}"${p.category===c.id?' selected':''}>${esc(c.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Name*</label><input type="text" id="ep-name" value="${esc(p.name)}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Activation Fee (AED)</label><input type="number" id="ep-act" value="${p.activationFee||0}"></div>
      <div class="field"><label>Source Doc</label><input type="text" id="ep-src" value="${esc(p.sourceDoc||'')}"></div>
    </div>
    <div class="divider"></div>
    <p class="text-dim text-xs mb-12">Pricing options — at least one required.</p>
    <div class="row3">
      <div class="field"><label>Term 1 Label*</label><input type="text" id="ep-t1-label" value="${t1?esc(t1.label):''}"></div>
      <div class="field"><label>Term (months)</label><input type="number" id="ep-t1-term" value="${t1?t1.term:''}"></div>
      <div class="field"><label>Price (AED)*</label><input type="number" id="ep-t1-price" value="${t1?t1.price:''}"></div>
    </div>
    <div class="row3">
      <div class="field"><label>Term 2 Label</label><input type="text" id="ep-t2-label" value="${t2?esc(t2.label):''}"></div>
      <div class="field"><label>Term (months)</label><input type="number" id="ep-t2-term" value="${t2?t2.term:''}"></div>
      <div class="field"><label>Price (AED)</label><input type="number" id="ep-t2-price" value="${t2?t2.price:''}"></div>
    </div>
    <div class="divider"></div>
    <div class="field"><label>Specs (one per line, "Label: Value")</label>
      <textarea id="ep-specs" rows="6">${esc(specsToText(p.specs||{}))}</textarea>
    </div>
    <div class="field"><label>Notes</label><input type="text" id="ep-notes" value="${esc(p.notes||'')}"></div>
    <p class="text-dim text-xs">Discounts and waivers are managed from the buttons on the product card.</p>
    <p id="ep-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="ep-btn">Save Changes</button>`, true);

  document.getElementById('ep-btn').onclick = async () => {
    const name=v('ep-name');
    const err=document.getElementById('ep-err');
    if(!name){ err.textContent='Name is required.'; return; }
    const t1label=v('ep-t1-label'), t1price=v('ep-t1-price');
    if(!t1label||!t1price){ err.textContent='At least one pricing option (label + price) is required.'; return; }
    disable('ep-btn','Saving…');
    try{
      const pricingOptions=[{term:Number(v('ep-t1-term'))||12, label:t1label, price:Number(t1price)}];
      if(v('ep-t2-label')&&v('ep-t2-price')){
        pricingOptions.push({term:Number(v('ep-t2-term'))||0, label:v('ep-t2-label'), price:Number(v('ep-t2-price'))});
      }
      const upd={
        category:v('ep-cat'), name, specs:parseSpecs(v('ep-specs')),
        pricingOptions, activationFee:Number(v('ep-act'))||0,
        sourceDoc:v('ep-src'), notes:v('ep-notes')
      };
      await dbUpdate('products', p.id, upd);
      closeModal(); toast('Product updated.'); onUpdate({...p,...upd,lastEditedBy:CP.name,lastEditedAt:now()});
    }catch(e){ err.textContent=e.message; enable('ep-btn','Save Changes'); }
  };
}

// ── MANAGE DISCOUNTS (manager, per product) ─────────
function showManageDiscountsModal(product, onUpdate){
  let discounts = [...(product.discounts||[])];

  function renderList(){
    const rows = discounts.length ? discounts.map(d=>`
      <div class="pr-sub-row">
        <div class="flex gap-8" style="justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-weight:600;font-size:13px">${esc(d.appliesToTermLabel||'')} — AED ${d.price}${d.percentage?` <span class="text-dim text-xs">(${d.percentage}% off)</span>`:''}</div>
            <div class="text-dim text-xs mt-8">${d.validFrom?fmtDate(d.validFrom):'—'} → ${d.validTo?fmtDate(d.validTo):'No end date'}</div>
            ${d.conditions?`<div class="text-xs mt-8">${esc(d.conditions)}</div>`:''}
          </div>
          <div class="flex gap-8">
            <button class="btn btn-ghost btn-xs" data-edit-disc="${d.id}">Edit</button>
            <button class="btn btn-danger btn-xs" data-del-disc="${d.id}">Delete</button>
          </div>
        </div>
      </div>`).join('') : '<p class="text-dim text-xs">No discounts on this product.</p>';

    modal(`Discounts — ${product.name}`, `
      <div id="disc-list">${rows}</div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-sm" id="disc-add-btn">+ Add Discount</button>`, true);

    document.querySelectorAll('[data-edit-disc]').forEach(b=>{
      const d = discounts.find(x=>x.id===b.dataset.editDisc);
      if(d) b.onclick = () => renderForm(d);
    });
    document.querySelectorAll('[data-del-disc]').forEach(b=>{
      const id = b.dataset.delDisc;
      b.onclick = () => confirmModal('Delete this discount?','Cannot be undone.',async()=>{
        discounts = discounts.filter(x=>x.id!==id);
        await dbUpdate('products', product.id, {discounts});
        toast('Discount deleted.','info');
        onUpdate({...product, discounts});
        renderList();
      });
    });
    document.getElementById('disc-add-btn').onclick = () => renderForm(null);
  }

  function renderForm(existing){
    const termOptions = (product.pricingOptions||[]).map(po=>
      `<option value="${po.term}"${existing&&existing.appliesToTerm===po.term?' selected':''}>${esc(po.label)} (AED ${po.price})</option>`
    ).join('');
    modal(existing?'Edit Discount':'Add Discount', `
      <div class="field"><label>Applies To</label><select id="df-term">${termOptions}</select></div>
      <div class="row2">
        <div class="field"><label>Discounted Price (AED)*</label><input type="number" id="df-price" value="${existing?existing.price:''}"></div>
        <div class="field"><label>Percentage Off</label><input type="number" id="df-pct" value="${existing&&existing.percentage?existing.percentage:''}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Valid From</label><input type="date" id="df-from" value="${existing&&existing.validFrom?existing.validFrom:''}"></div>
        <div class="field"><label>Valid To</label><input type="date" id="df-to" value="${existing&&existing.validTo?existing.validTo:''}"></div>
      </div>
      <div class="field"><label>Conditions</label><textarea id="df-cond" rows="3">${existing?esc(existing.conditions||''):''}</textarea></div>
      <p id="df-err" class="err"></p>
      <div class="flex gap-8 mt-12">
        <button class="btn btn-primary" id="df-save">${existing?'Save Changes':'Add Discount'}</button>
        <button class="btn btn-ghost" id="df-cancel">Cancel</button>
      </div>`, true);

    document.getElementById('df-cancel').onclick = renderList;
    document.getElementById('df-save').onclick = async () => {
      const term = Number(v('df-term'));
      const po = (product.pricingOptions||[]).find(x=>x.term===term);
      const price = Number(v('df-price'));
      const err = document.getElementById('df-err');
      if(!price){ err.textContent='Discounted price is required.'; return; }
      disable('df-save','Saving…');
      try{
        const pct = v('df-pct');
        const entry = {
          id: existing?existing.id:`d_${Date.now()}`,
          appliesToTerm: term, appliesToTermLabel: po?po.label:'',
          price, percentage: pct?Number(pct):null,
          validFrom: v('df-from')||null, validTo: v('df-to')||null,
          conditions: v('df-cond'),
          createdBy: existing?existing.createdBy:CU.uid,
          createdByName: existing?existing.createdByName:CP.name,
          createdAt: existing?existing.createdAt:now()
        };
        discounts = existing ? discounts.map(d=>d.id===entry.id?entry:d) : [...discounts, entry];
        await dbUpdate('products', product.id, {discounts});
        toast(existing?'Discount updated.':'Discount added.');
        onUpdate({...product, discounts});
        renderList();
      }catch(e){ err.textContent=e.message; enable('df-save', existing?'Save Changes':'Add Discount'); }
    };
  }

  renderList();
}

// ── MANAGE MONTHLY WAIVERS (manager, per product) ───
function showManageWaiversModal(product, onUpdate){
  let waivers = [...(product.monthlyWaivers||[])];

  function renderList(){
    const rows = waivers.length ? waivers.map(w=>`
      <div class="pr-sub-row">
        <div class="flex gap-8" style="justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-weight:600;font-size:13px">${esc(w.label)} — ${w.valueType==='percentage'?w.value+'%':'AED '+w.value} off /mo</div>
            ${w.conditions?`<div class="text-xs mt-8">${esc(w.conditions)}</div>`:''}
          </div>
          <div class="flex gap-8">
            <button class="btn btn-ghost btn-xs" data-edit-wv="${w.id}">Edit</button>
            <button class="btn btn-danger btn-xs" data-del-wv="${w.id}">Delete</button>
          </div>
        </div>
      </div>`).join('') : '<p class="text-dim text-xs">No monthly waivers defined yet.</p>';

    modal(`Monthly Waivers — ${product.name}`, `
      <p class="text-dim text-xs mb-12">Billing-level waivers — vary by SIM count, porting vs. new service, or (for fixed) contract term and product. Rules aren't formalised yet; capture what applies in Conditions for now.</p>
      <div id="wv-list">${rows}</div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-sm" id="wv-add-btn">+ Add Waiver</button>`, true);

    document.querySelectorAll('[data-edit-wv]').forEach(b=>{
      const w = waivers.find(x=>x.id===b.dataset.editWv);
      if(w) b.onclick = () => renderForm(w);
    });
    document.querySelectorAll('[data-del-wv]').forEach(b=>{
      const id = b.dataset.delWv;
      b.onclick = () => confirmModal('Delete this waiver?','Cannot be undone.',async()=>{
        waivers = waivers.filter(x=>x.id!==id);
        await dbUpdate('products', product.id, {monthlyWaivers:waivers});
        toast('Waiver deleted.','info');
        onUpdate({...product, monthlyWaivers:waivers});
        renderList();
      });
    });
    document.getElementById('wv-add-btn').onclick = () => renderForm(null);
  }

  function renderForm(existing){
    modal(existing?'Edit Waiver':'Add Waiver', `
      <div class="field"><label>Label*</label><input type="text" id="wf-label" placeholder="e.g. 10+ SIM volume waiver" value="${existing?esc(existing.label):''}"></div>
      <div class="row2">
        <div class="field"><label>Value*</label><input type="number" id="wf-value" value="${existing?existing.value:''}"></div>
        <div class="field"><label>Type</label>
          <select id="wf-type">
            <option value="amount"${existing&&existing.valueType==='amount'?' selected':''}>AED / month</option>
            <option value="percentage"${existing&&existing.valueType==='percentage'?' selected':''}>% off monthly</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Conditions</label><textarea id="wf-cond" rows="3" placeholder="e.g. Applies to accounts with 10+ active SIMs, mobile only">${existing?esc(existing.conditions||''):''}</textarea></div>
      <p id="wf-err" class="err"></p>
      <div class="flex gap-8 mt-12">
        <button class="btn btn-primary" id="wf-save">${existing?'Save Changes':'Add Waiver'}</button>
        <button class="btn btn-ghost" id="wf-cancel">Cancel</button>
      </div>`, true);

    document.getElementById('wf-cancel').onclick = renderList;
    document.getElementById('wf-save').onclick = async () => {
      const label = v('wf-label'), value = Number(v('wf-value')), valueType = v('wf-type');
      const err = document.getElementById('wf-err');
      if(!label){ err.textContent='Label is required.'; return; }
      if(!value){ err.textContent='Value is required.'; return; }
      disable('wf-save','Saving…');
      try{
        const entry = {
          id: existing?existing.id:`w_${Date.now()}`,
          label, value, valueType, conditions: v('wf-cond'),
          createdBy: existing?existing.createdBy:CU.uid,
          createdByName: existing?existing.createdByName:CP.name,
          createdAt: existing?existing.createdAt:now()
        };
        waivers = existing ? waivers.map(w=>w.id===entry.id?entry:w) : [...waivers, entry];
        await dbUpdate('products', product.id, {monthlyWaivers:waivers});
        toast(existing?'Waiver updated.':'Waiver added.');
        onUpdate({...product, monthlyWaivers:waivers});
        renderList();
      }catch(e){ err.textContent=e.message; enable('wf-save', existing?'Save Changes':'Add Waiver'); }
    };
  }

  renderList();
}

// ── CATEGORIES & CONTRACT TERMS CONFIG (manager) — Session B4 Step 3 ───
// Category rename = label edit only; ids are permanent once assigned
// (js/orgConfig.js) — delete is blocked while any product still
// references the id, with the blocking products listed (ARCHITECTURE.md
// §12). Contract-term labels are an optional org-config override on top of
// each product's own stored pricingOption.label (js/orgConfig.js
// termLabel()) — no product data migration needed, renaming just adds/
// updates the override.
//
// saveOrgConfig/withOrgConfigSave now live in js/orgConfig.js (Step 7 added
// a second consumer — the Dashboard's run-rate default toggle — so the
// merge-then-set + graceful-degradation pattern moved to the shared module
// instead of staying a products.js-local helper).

// ── PRODUCT FAMILIES — one-time migration (Session C0, ARCHITECTURE.md
// §14) — a coarser grouping ABOVE categories, for Phase C's rollup
// counters. Unlike B4's category migration (many product/user documents),
// this touches ONE document (orgs/{orgId}): seed the families array if
// missing, and stamp familyId onto any category that doesn't have one yet,
// per DEFAULT_FAMILY_MAPPING (falling back to 'others' for any category id
// not in that mapping — e.g. one a manager already added). Both parts are
// independently idempotent — safe to re-run, skips whatever's already
// migrated. currentFamilies()===DEFAULT_FAMILIES (reference equality) is a
// cheap "families need seeding" check without importing OC directly here.
function computeFamilyMigrationPlan(){
  const familiesNeedSeeding = currentFamilies() === DEFAULT_FAMILIES;
  const categoryOps = currentCategories()
    .filter(c => !c.familyId)
    .map(c => ({ id: c.id, label: c.label, familyId: DEFAULT_FAMILY_MAPPING[c.id] || 'others' }));
  return { familiesNeedSeeding, categoryOps, alreadyMigrated: !familiesNeedSeeding && categoryOps.length===0 };
}

function showFamilyMigrationPreview(onSaved){
  const plan = computeFamilyMigrationPlan();
  modal('Migrate Categories to Families — Preview', `
    <p class="text-dim text-sm mb-12">Dry run only — nothing has been written yet.</p>
    ${plan.familiesNeedSeeding ? `<p>Families config does not exist yet — will be created: ${DEFAULT_FAMILIES.map(f=>esc(f.label)).join(', ')}.</p>` : ''}
    <p style="margin-top:12px"><strong>Categories to assign a family (${plan.categoryOps.length})</strong></p>
    ${plan.categoryOps.length ? `<div class="tbl-wrap"><table><tbody>
      ${plan.categoryOps.map(o=>`<tr><td>${esc(o.label)}</td><td class="td-dim">→ ${esc(familyLabel(o.familyId))}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="text-dim text-xs">None — every category already has a family.</p>'}
    <div class="flex gap-8 mt-12">
      <button class="btn btn-primary" id="btn-family-migration-run" ${plan.alreadyMigrated?'disabled':''}>Run Migration</button>
      <button class="btn btn-ghost" onclick="document.getElementById('modal').style.display='none'">Cancel</button>
    </div>`, true);
  document.getElementById('btn-family-migration-run').onclick = () => runFamilyMigration(plan, onSaved);
}

async function runFamilyMigration(plan, onSaved){
  const runBtn = document.getElementById('btn-family-migration-run');
  if(runBtn){ runBtn.disabled = true; runBtn.textContent = '⏳ Migrating…'; }
  try {
    const patch = {};
    if(plan.familiesNeedSeeding) patch.families = DEFAULT_FAMILIES;
    if(plan.categoryOps.length){
      const opById = Object.fromEntries(plan.categoryOps.map(o=>[o.id,o.familyId]));
      patch.categories = currentCategories().map(c => opById[c.id] ? {...c, familyId: opById[c.id]} : c);
    }
    const ok = await withOrgConfigSave(()=>saveOrgConfig(patch));
    if(ok){
      closeModal();
      toast(`✅ Migrated ${plan.categoryOps.length} categor${plan.categoryOps.length!==1?'ies':'y'} to families.`);
      onSaved();
    } else if(runBtn){ runBtn.disabled=false; runBtn.textContent='Run Migration'; }
  } catch(e){
    toast('Error: '+e.message,'err');
    if(runBtn){ runBtn.disabled=false; runBtn.textContent='Run Migration'; }
  }
}

function showCategoryConfigModal(products, onSaved){
  function countFor(catId){ return products.filter(p=>p.category===catId); }
  // Family delete-blocking: which categories reference this family — same
  // "list the blockers, never a silent cascade" pattern countFor() uses for
  // category delete against products.
  function categoriesInFamily(famId){ return currentCategories().filter(c=>c.familyId===famId); }

  function render(){
    const categories = currentCategories();
    const families = currentFamilies();
    const terms = {}; // term -> a stored label to use as the default/fallback
    products.forEach(p => (p.pricingOptions||[]).forEach(po => { if(terms[po.term]==null) terms[po.term] = po.label; }));
    const termLabels = currentTermLabels();
    const familyMigrationPlan = computeFamilyMigrationPlan();

    modal('Categories & Contract Terms', `
      <p class="text-dim text-sm mb-12">Renaming a label updates it everywhere immediately (products, specialty checklists, dashboards). Category ids are permanent — delete only works once no product uses that category.</p>
      ${!familyMigrationPlan.alreadyMigrated ? `<div class="seed-banner">
        <p>Some categories don't have a product family assigned yet (used by Phase C's reports). This seeds the default family list if needed and assigns each unmapped category — safe to re-run.</p>
        <button class="btn btn-primary btn-sm" id="btn-family-migration">🏷️ Migrate Categories to Families</button>
      </div>` : ''}
      <p><strong>Product Families</strong> <span class="text-dim text-xs">(used by Phase C's reports — each category belongs to one)</span></p>
      <div class="tbl-wrap"><table><tbody>
        ${families.map(f=>{
          const blockers = categoriesInFamily(f.id);
          const n = blockers.length;
          const blockText = n ? `${n} categor${n!==1?'ies':'y'}: ${esc(blockers.map(c=>c.label).join(', '))}` : '—';
          return `<tr>
            <td style="width:35%"><input type="text" class="cc-fam-label" data-id="${f.id}" value="${esc(f.label)}"></td>
            <td class="td-dim text-xs">${blockText}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-ghost btn-xs" data-fam-save="${f.id}">Save</button>
              <button class="btn btn-danger btn-xs" data-fam-del="${f.id}" ${n?'disabled title="In use — cannot delete"':''}>Delete</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody></table></div>
      <div class="row2 mt-8">
        <input type="text" id="cc-new-fam-label" placeholder="New family label">
        <button class="btn btn-ghost btn-sm" id="cc-add-fam">+ Add Family</button>
      </div>
      <div class="divider"></div>
      <p><strong>Categories</strong></p>
      <div class="tbl-wrap"><table><tbody>
        ${categories.map(c=>{
          const blockers = countFor(c.id);
          const n = blockers.length;
          const blockText = n ? `${n} product${n!==1?'s':''}: ${esc(blockers.slice(0,3).map(p=>p.name).join(', '))}${n>3?` +${n-3} more`:''}` : '—';
          return `<tr>
            <td style="width:28%"><input type="text" class="cc-cat-label" data-id="${c.id}" value="${esc(c.label)}"></td>
            <td style="width:20%"><select class="cc-cat-family" data-id="${c.id}">
              ${families.map(f=>`<option value="${f.id}"${c.familyId===f.id?' selected':''}>${esc(f.label)}</option>`).join('')}
            </select></td>
            <td class="td-dim text-xs">${blockText}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-ghost btn-xs" data-cat-save="${c.id}">Save</button>
              <button class="btn btn-danger btn-xs" data-cat-del="${c.id}" ${n?'disabled title="In use — cannot delete"':''}>Delete</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody></table></div>
      <div class="row2 mt-8">
        <input type="text" id="cc-new-cat-label" placeholder="New category label">
        <button class="btn btn-ghost btn-sm" id="cc-add-cat">+ Add Category</button>
      </div>
      <div class="divider"></div>
      <p><strong>Contract Term Labels</strong></p>
      ${Object.keys(terms).length ? `<div class="tbl-wrap"><table><tbody>
        ${Object.entries(terms).map(([term,defaultLabel])=>`<tr>
          <td class="td-dim" style="width:20%">${term==='0'?'No contract':term+' months'}</td>
          <td style="width:50%"><input type="text" class="cc-term-label" data-term="${term}" value="${esc(termLabels[term] ?? defaultLabel)}"></td>
          <td style="text-align:right"><button class="btn btn-ghost btn-xs" data-term-save="${term}">Save</button></td>
        </tr>`).join('')}
      </tbody></table></div>` : '<p class="text-dim text-xs">No pricing terms found on any product yet.</p>'}
      <div class="flex gap-8 mt-12">
        <button class="btn btn-ghost" onclick="document.getElementById('modal').style.display='none'">Close</button>
      </div>`, true);

    document.getElementById('btn-family-migration')?.addEventListener('click', () => showFamilyMigrationPreview(() => { onSaved(); render(); }));

    document.querySelectorAll('[data-fam-save]').forEach(b=>b.addEventListener('click', async ()=>{
      const id = b.dataset.famSave;
      const label = (document.querySelector(`.cc-fam-label[data-id="${id}"]`).value||'').trim();
      if(!label){ toast('Label cannot be empty.','err'); return; }
      const updated = families.map(f=>f.id===id?{...f,label}:f);
      const ok = await withOrgConfigSave(()=>saveOrgConfig({families:updated}));
      if(ok){ toast('Family renamed.'); onSaved(); }
      render();
    }));

    document.querySelectorAll('[data-fam-del]:not([disabled])').forEach(b=>{
      b.addEventListener('click', ()=>{
        const id = b.dataset.famDel;
        confirmModal(`Delete "${families.find(f=>f.id===id)?.label||''}"?`, 'This family is not referenced by any category and will be removed permanently.', async ()=>{
          const updated = families.filter(f=>f.id!==id);
          const ok = await withOrgConfigSave(()=>saveOrgConfig({families:updated}));
          if(ok){ toast('Family deleted.'); onSaved(); }
          render();
        });
      });
    });

    document.getElementById('cc-add-fam').onclick = async () => {
      const label = v('cc-new-fam-label');
      if(!label){ toast('Enter a label first.','err'); return; }
      const id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
      if(!id){ toast('Label must contain letters or numbers.','err'); return; }
      if(families.some(f=>f.id===id)){ toast('A family with this id already exists — use a different label.','err'); return; }
      const updated = [...families, {id, label:label.trim()}];
      const ok = await withOrgConfigSave(()=>saveOrgConfig({families:updated}));
      if(ok){ toast('Family added.'); onSaved(); }
      render();
    };

    // Family dropdown re-parents LIVE — saves immediately on change, unlike
    // the label input's explicit Save button (free text shouldn't autosave
    // on every keystroke; a <select> choice is already a complete, discrete
    // action the moment it fires).
    document.querySelectorAll('.cc-cat-family').forEach(sel=>sel.addEventListener('change', async function(){
      const id = this.dataset.id;
      const familyId = this.value;
      const updated = categories.map(c=>c.id===id?{...c,familyId}:c);
      const ok = await withOrgConfigSave(()=>saveOrgConfig({categories:updated}));
      if(ok){ toast('Category moved to a new family.'); onSaved(); }
      render();
    }));

    document.querySelectorAll('[data-cat-save]').forEach(b=>b.addEventListener('click', async ()=>{
      const id = b.dataset.catSave;
      const label = (document.querySelector(`.cc-cat-label[data-id="${id}"]`).value||'').trim();
      if(!label){ toast('Label cannot be empty.','err'); return; }
      const updated = categories.map(c=>c.id===id?{...c,label}:c);
      const ok = await withOrgConfigSave(()=>saveOrgConfig({categories:updated}));
      if(ok){ toast('Category renamed.'); onSaved(); }
      render();
    }));

    document.querySelectorAll('[data-cat-del]:not([disabled])').forEach(b=>{
      b.addEventListener('click', ()=>{
        const id = b.dataset.catDel;
        confirmModal(`Delete "${categories.find(c=>c.id===id)?.label||''}"?`, 'This category is not used by any product and will be removed permanently.', async ()=>{
          const updated = categories.filter(c=>c.id!==id);
          const ok = await withOrgConfigSave(()=>saveOrgConfig({categories:updated}));
          if(ok){ toast('Category deleted.'); onSaved(); }
          render();
        });
      });
    });

    document.getElementById('cc-add-cat').onclick = async () => {
      const label = v('cc-new-cat-label');
      if(!label){ toast('Enter a label first.','err'); return; }
      const id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
      if(!id){ toast('Label must contain letters or numbers.','err'); return; }
      if(categories.some(c=>c.id===id)){ toast('A category with this id already exists — use a different label.','err'); return; }
      const updated = [...categories, {id, label:label.trim(), familyId:'others'}];
      const ok = await withOrgConfigSave(()=>saveOrgConfig({categories:updated}));
      if(ok){ toast('Category added.'); onSaved(); }
      render();
    };

    document.querySelectorAll('[data-term-save]').forEach(b=>b.addEventListener('click', async ()=>{
      const term = b.dataset.termSave;
      const label = (document.querySelector(`.cc-term-label[data-term="${term}"]`).value||'').trim();
      if(!label){ toast('Label cannot be empty.','err'); return; }
      const updated = { ...termLabels, [term]: label };
      const ok = await withOrgConfigSave(()=>saveOrgConfig({contractTermLabels:updated}));
      if(ok){ toast('Term label updated.'); onSaved(); }
      render();
    }));
  }

  render();
}
