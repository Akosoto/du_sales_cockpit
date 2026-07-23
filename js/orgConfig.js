import { db, OC, setOrgConfig, doc, getDoc } from './state.js';
import { dbSet } from './db.js';
import { toast } from './helpers.js';
import { orgId } from '../config.js';

// ════════════════════════════════════════════════════
// ORG CONFIG (Session B4, ARCHITECTURE.md §3/§12) — the first piece of the
// long-planned `orgs/{orgId}` doc (previously just described in
// ARCHITECTURE.md and hardcoded as ORG_DEFAULTS in state.js) to actually
// become live, manager-editable Firestore data. Doc ID is the org's own
// `orgId` (one org per deployment, matching every other org-scoped
// collection's `orgId` field convention — this one just uses it AS the doc
// ID instead of a field, since there's exactly one such doc per project).
//
// Categories get PERMANENT, IMMUTABLE ids here — the display label is
// editable (Products config panel, step 3), the id never changes once
// assigned. Every reference that used to store the category NAME directly
// (products.category, users.specialties[]) migrates to store the id
// instead (see runCategoryMigration in js/org.js) and resolves the label
// via categoryLabel() at render time — rename becomes one label edit,
// reflected everywhere by construction.
// ════════════════════════════════════════════════════

// Seed/bootstrap default — used both as the fallback when orgs/{orgId}
// doesn't exist yet (pre-migration bootstrap window, same pattern as the
// sameOrg() bootstrap bypass) AND as the payload the migration writes on
// first run. IDs are deliberately the lowercase slug of the CURRENT
// display name — readable or debugging, and happens to already match
// js/products.js's prCatClass() lowercase-string switch with no changes
// needed there.
export const DEFAULT_CATEGORIES = [
  { id: 'starter',   label: 'Starter' },
  { id: 'essential', label: 'Essential' },
  { id: 'ultimate',  label: 'Ultimate' },
  { id: 'mobile',    label: 'Mobile' }
];

// Product FAMILIES (Session C0, ARCHITECTURE.md §14) — a coarser grouping
// ABOVE categories, for Phase C's rollup counters (keyed by family, not
// category). Same permanent-id/editable-label pattern as DEFAULT_CATEGORIES
// above: id never changes once assigned, label is manager-editable. Every
// category gets a `familyId` (js/products.js's family migration/CRUD),
// resolved to a label at render time via familyLabel() — never a name
// string stored anywhere.
export const DEFAULT_FAMILIES = [
  { id: 'fixed',  label: 'Fixed' },
  { id: 'sim',    label: 'SIM Cards' },
  { id: 'others', label: 'Others' }
];

// Default category->family mapping, applied once by the one-time migration
// (js/products.js runFamilyMigration) — any category id not listed here
// (a manager-created category with no explicit assignment) defaults to
// 'others', not left unmapped.
export const DEFAULT_FAMILY_MAPPING = {
  starter: 'fixed', essential: 'fixed', ultimate: 'fixed', mobile: 'sim'
};

// Single get() on a known doc id — always provable for any role once the
// orgs/{orgId} read rule is `isAuth() && sameOrgDoc()`-style (step 8); not
// a list query, so the LIST-query provability question doesn't apply here.
export async function loadOrgConfig(){
  try {
    const snap = await getDoc(doc(db, 'orgs', orgId));
    if(snap.exists()){
      setOrgConfig({ categories: DEFAULT_CATEGORIES, families: DEFAULT_FAMILIES, ...snap.data() });
      return;
    }
  } catch(e){ /* orgs/{orgId} rule may not be published yet, or the doc genuinely doesn't exist — degrade to defaults either way */ }
  setOrgConfig({ categories: DEFAULT_CATEGORIES, families: DEFAULT_FAMILIES });
}

// Resolves a category id to its display label. Falls back to the raw value
// unchanged when it's not a known id — this is what makes the SAME call
// site safe for both migrated data (real ids) and any pre-migration
// leftover (a legacy name-string, which already reads fine as-is) without
// needing to know which shape a given document has.
export function categoryLabel(idOrLegacyValue){
  if(!idOrLegacyValue) return idOrLegacyValue;
  const cats = OC?.categories || DEFAULT_CATEGORIES;
  return cats.find(c => c.id === idOrLegacyValue)?.label || idOrLegacyValue;
}

// Case-insensitive label→id lookup — used ONLY by the one-time migration
// script (js/org.js runCategoryMigration) to map old name-strings onto the
// new permanent ids.
export function findCategoryIdByLabel(label){
  const cats = OC?.categories || DEFAULT_CATEGORIES;
  const norm = String(label||'').trim().toLowerCase();
  return cats.find(c => c.label.toLowerCase() === norm)?.id || null;
}

// Current category list for dropdowns/checklists — always an array of
// {id,label}, never raw strings, so every render call site can iterate the
// same shape regardless of whether OC has loaded yet.
export function currentCategories(){
  return OC?.categories || DEFAULT_CATEGORIES;
}

// Resolves a family id to its display label — same fallback-to-raw-value
// behavior as categoryLabel() above, for the same reason (safe at any call
// site regardless of whether the id is recognized).
export function familyLabel(idOrLegacy){
  if(!idOrLegacy) return idOrLegacy;
  const fams = OC?.families || DEFAULT_FAMILIES;
  return fams.find(f => f.id === idOrLegacy)?.label || idOrLegacy;
}

// Case-insensitive label->id lookup — mirrors findCategoryIdByLabel(),
// used by the family config UI to reject a duplicate label on add.
export function findFamilyIdByLabel(label){
  const fams = OC?.families || DEFAULT_FAMILIES;
  const norm = String(label||'').trim().toLowerCase();
  return fams.find(f => f.label.toLowerCase() === norm)?.id || null;
}

// Current family list — always an array of {id,label}, same shape
// guarantee as currentCategories().
export function currentFamilies(){
  return OC?.families || DEFAULT_FAMILIES;
}

// Contract-term display labels (Session B4 Step 3, Products config panel).
// Unlike categories, a pricingOption's label is NOT migrated away from the
// product doc — every product keeps its own free-text label as the
// fallback/default (no data migration needed, nothing breaks if this
// override is never set). org-config only holds an OPTIONAL override keyed
// by term (months), so a manager can rename "12-month contract" once and
// have it reflected on every product that uses that term, without touching
// per-product data. termLabel() is the single resolver every render call
// site should use instead of reading pricingOption.label directly.
export function termLabel(term, fallbackLabel){
  return OC?.contractTermLabels?.[term] ?? fallbackLabel;
}

// Current term-label overrides — always an object (possibly empty), for the
// config panel to render/edit directly.
export function currentTermLabels(){
  return OC?.contractTermLabels || {};
}

// ── SHARED ORG-CONFIG WRITE PATH (Session B4 Steps 3 & 7) ──
// Every write to orgs/{orgId} — from more than one feature now (Products'
// category/term config, the Dashboard's run-rate default toggle) — goes
// through here so they share one merge-then-set pattern instead of each
// hand-rolling it. Always spreads the current OC first and dbSet()s the
// WHOLE doc (never a partial update), so a category edit can't clobber a
// concurrently-set contractTermLabels/runRateDefaultVisible field or vice
// versa.
//
// orgs/{orgId} has no published Firestore rule yet as of Step 3 — it ships
// in Step 8 (PAUSE POINT). withOrgConfigSave() surfaces that as a clear
// "not yet available" toast instead of a raw Firestore error, and never
// blocks whatever else the caller's UI is doing.
export function saveOrgConfig(patch){
  return dbSet('orgs', orgId, { ...(OC||{}), ...patch }, {skipAudit:true});
}
export async function withOrgConfigSave(fn){
  try {
    await fn();
    await loadOrgConfig();
    return true;
  } catch(e){
    const denied = e.code === 'permission-denied' || /insufficient permissions/i.test(e.message||'');
    toast(denied ? "Can't save yet — org config rules ship in Step 8 of this build. Not saved." : 'Error: '+e.message, 'err');
    return false;
  }
}
