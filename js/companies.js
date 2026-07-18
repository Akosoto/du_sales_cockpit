import { db, doc, getDocs, collection } from './state.js';
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

// Returns the closest existing company if the typed name is CLOSE (not exact)
// to it — a cheap nudge to reduce future duplicates without blocking entry.
export function findFuzzyMatch(name, companies){
  const norm = normalizeCompanyName(name);
  if(!norm) return null;
  let best = null, bestDist = Infinity;
  companies.forEach(c => {
    if(c.normalizedName === norm) return; // exact match is handled elsewhere
    const dist = levenshtein(norm, c.normalizedName||'');
    const threshold = Math.max(2, Math.round(norm.length * 0.2));
    if(dist <= threshold && dist < bestDist){ best = c; bestDist = dist; }
  });
  return best;
}

export async function fetchCompanies(){
  const snap = await getDocs(collection(db,'companies'));
  return snap.docs.map(d=>({id:d.id,...d.data()}));
}

// The one shared function for turning a typed/imported name into a companyId.
// Pass `knownCompanies` (already-fetched list) to avoid a redundant read when
// the caller already has one, e.g. the lead modal's picker.
//
// accountCode dedup (ARCHITECTURE.md §3 company enrichment) is checked FIRST,
// ahead of normalizedName — it's a stronger identity signal (an exact du
// account reference) than a name match, which two genuinely different
// companies could coincidentally share/collide on.
export async function findOrCreateCompany(name, extra = {}, knownCompanies = null){
  const norm = normalizeCompanyName(name);
  const companies = knownCompanies || await fetchCompanies();

  if(extra.accountCode){
    const byCode = companies.find(c => c.accountCode && c.accountCode === extra.accountCode);
    if(byCode) return byCode.id;
  }

  const existing = companies.find(c => c.normalizedName === norm);
  if(existing) return existing.id;

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
