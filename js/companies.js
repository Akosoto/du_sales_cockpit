import { db, doc, getDocs, collection, query, where, limit } from './state.js';
import { dbAdd, newBatch, batchSet, batchUpdate, logBulkAudit } from './db.js';

// ════════════════════════════════════════════════════
// COMPANIES — shared logic
// Used by: inline lead creation (leads.js), the Org tab backfill button
// (org.js), and — later — the Data Import Tool. Keep the dedup/normalize
// logic here as the ONE shared implementation so those never drift apart.
// ════════════════════════════════════════════════════

// Lowercase, strip diacritics/punctuation, collapse whitespace — the dedup key.
export function normalizeCompanyName(name){
  return (name||'')
    .toLowerCase()
    .normalize('NFKD').replace(/\p{Mn}/gu,'')
    .replace(/[^\p{L}\p{N}\s]/gu,'')
    .replace(/\s+/g,' ')
    .trim();
}

// Cheap edit-distance check — used only for the "did you mean X" warning on
// entry, not for actual dedup matching (normalizedName equality is that key).
function levenshtein(a,b){
  const m=a.length, n=b.length;
  if(!m) return n; if(!n) return m;
  const dp = Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j-1],dp[i-1][j],dp[i][j-1]);
    }
  }
  return dp[m][n];
}

// Returns the closest match from a small already-fetched `candidates` list —
// NEVER a full collection scan (ARCHITECTURE.md §9: a real partner can carry
// 1,000-3,000+ companies, so fetch-all patterns are banned). `candidates`
// should be whatever searchCompanies() just returned (≤10 docs) — this is a
// cheap nudge ("did you mean X?") operating only on that small set, not a
// dedup mechanism in its own right (normalizedName/accountCode equality is).
export function findFuzzyMatch(name, candidates){
  const norm = normalizeCompanyName(name);
  if(!norm) return null;
  let best = null, bestDist = Infinity;
  candidates.forEach(c => {
    if(c.normalizedName === norm) return; // exact match is handled elsewhere
    const dist = levenshtein(norm, c.normalizedName||'');
    const threshold = Math.max(2, Math.round(norm.length * 0.2));
    if(dist <= threshold && dist < bestDist){ best = c; bestDist = dist; }
  });
  return best;
}

// Full collection scan — deliberately still here for backfillCompanies()
// (step 7d: one-off, manager-only, safe to re-run — a bounded, rare
// operation, not a per-keystroke UI path) and the Org tab's Companies card.
// NEVER call this for a company picker — use searchCompanies() instead.
export async function fetchCompanies(){
  const snap = await getDocs(collection(db,'companies'));
  return snap.docs.map(d=>({id:d.id,...d.data()}));
}

// Type-ahead company search (ARCHITECTURE.md §9) — every company picker uses
// this, never fetchCompanies(). Prefix-range query on normalizedName (min 2
// chars, capped at 10 results) is a single-field range filter, so it needs
// no composite index. Runs a second, parallel exact-match query on
// accountCode when the term contains a digit (account codes are typically
// alphanumeric-with-digits; company names rarely are) — cheap enough to
// just also check rather than trying to guess "looks like a code" more
// precisely.
export async function searchCompanies(term){
  const norm = normalizeCompanyName(term);
  if(norm.length < 2) return [];
  const queries = [
    getDocs(query(collection(db,'companies'),
      where('normalizedName','>=',norm),
      where('normalizedName','<=',norm+''),
      limit(10)))
  ];
  if(/\d/.test(term)){
    queries.push(getDocs(query(collection(db,'companies'), where('accountCode','==',term.trim()), limit(1))));
  }
  const results = await Promise.all(queries);
  const byId = {};
  results.forEach(snap => snap.forEach(d => { byId[d.id] = {id:d.id, ...d.data()}; }));
  return Object.values(byId);
}

// Exact accountCode lookup — a single targeted read, used by the accountCode-
// match nudge in company pickers (distinct from searchCompanies(), which
// searches by name with accountCode only as a side-check).
export async function findCompanyByAccountCode(code){
  if(!code || !code.trim()) return null;
  const snap = await getDocs(query(collection(db,'companies'), where('accountCode','==',code.trim()), limit(1)));
  return snap.empty ? null : {id:snap.docs[0].id, ...snap.docs[0].data()};
}

// The one shared function for turning a typed/imported name into a companyId.
// Two targeted reads instead of a full scan (ARCHITECTURE.md §9) — at most 2
// document reads regardless of collection size, vs. the old fetchCompanies()
// pattern which cost one read PER EXISTING COMPANY on every single lead
// creation.
//
// accountCode dedup (ARCHITECTURE.md §3 company enrichment) is checked FIRST,
// ahead of normalizedName — it's a stronger identity signal (an exact du
// account reference) than a name match, which two genuinely different
// companies could coincidentally share/collide on.
export async function findOrCreateCompany(name, extra = {}){
  const norm = normalizeCompanyName(name);

  if(extra.accountCode){
    const byCodeSnap = await getDocs(query(collection(db,'companies'), where('accountCode','==',extra.accountCode), limit(1)));
    if(!byCodeSnap.empty) return byCodeSnap.docs[0].id;
  }

  const byNameSnap = await getDocs(query(collection(db,'companies'), where('normalizedName','==',norm), limit(1)));
  if(!byNameSnap.empty) return byNameSnap.docs[0].id;

  const ref = await dbAdd('companies', {
    name: name.trim(),
    normalizedName: norm,
    industry: extra.industry||'', city: extra.city||'',
    accountCode: extra.accountCode || null,
    hasDuAccount: false,
    mergedInto: null
  });
  return ref.id;
}

// ── One-time backfill: group existing leads by normalized company name,
// create one companies doc per unique group (skipping any that already
// exist — safe to re-run), write companyId back onto each lead.
export async function backfillCompanies(leadsToFix){
  const companies = await fetchCompanies();
  const byNorm = {}; companies.forEach(c => { byNorm[c.normalizedName] = c.id; });

  const groups = {};
  leadsToFix.forEach(l => {
    const norm = normalizeCompanyName(l.company);
    if(!norm) return;
    (groups[norm] ||= []).push(l);
  });

  // Pre-generate refs for any normalized name not already a known company —
  // doc() allocates an id client-side with no network round-trip, so we can
  // resolve every companyId up front and then just flatten writes below.
  const newCompanyDocs = [];
  Object.keys(groups).forEach(norm => {
    if(!byNorm[norm]){
      const ref = doc(collection(db,'companies'));
      byNorm[norm] = ref.id;
      newCompanyDocs.push({ ref, norm, sample: groups[norm][0] });
    }
  });

  const allOps = [];
  newCompanyDocs.forEach(({ref,norm,sample}) => {
    allOps.push({ kind:'set', collectionName:'companies', id:ref.id, data:{
      name: sample.company, normalizedName: norm,
      industry: sample.industry||'', city: sample.city||'',
      hasDuAccount:false, mergedInto:null
    }});
  });
  let leadsUpdated = 0;
  leadsToFix.forEach(l => {
    const norm = normalizeCompanyName(l.company);
    if(!norm) return;
    allOps.push({ kind:'update', collectionName:'leads', id:l.id, data:{ companyId: byNorm[norm] } });
    leadsUpdated++;
  });

  // CHUNK=200 + skipAudit:true per-op: each op would otherwise ALSO write an
  // auditLog doc (js/db.js), doubling writes-per-op and blowing Firestore's
  // 500-write batch cap well below the old 400-op chunk size. One summary
  // auditLog entry for the whole run replaces the per-op trail.
  const CHUNK = 200;
  for(let i=0;i<allOps.length;i+=CHUNK){
    const bat = newBatch();
    allOps.slice(i,i+CHUNK).forEach(op => {
      if(op.kind==='set') batchSet(bat, op.collectionName, op.id, op.data, {skipAudit:true});
      else batchUpdate(bat, op.collectionName, op.id, op.data, {skipAudit:true});
    });
    await bat.commit();
  }
  if(allOps.length) await logBulkAudit(`backfillCompanies: ${newCompanyDocs.length} companies created, ${leadsUpdated} leads linked`, allOps.length);

  return { companiesCreated: newCompanyDocs.length, leadsUpdated };
}
