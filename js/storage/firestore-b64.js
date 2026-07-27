import { db, CU, doc, getDoc, getDocs, collection, query, where, getCountFromServer } from '../state.js';
import { newBatch, batchSet, batchDelete, logBulkAudit } from '../db.js';
import { now } from '../helpers.js';
import { orgId } from '../../config.js';

// ════════════════════════════════════════════════════
// firestore-b64 driver (ARCHITECTURE.md §6) — free-tier document storage.
// One Firestore doc PER PAGE in a top-level `submissionDocs` collection,
// keyed by bundleId+docType+version+pageIndex (NOT by any individual
// submission's id) — files are shared PER BUNDLE, since company documents
// (Trade License, Emirates ID) attach once per Submit-to-Backend form, not
// once per product line.
//
// Versioning (step 4, ARCHITECTURE.md §5's rejected→fix-and-resubmit loop):
// pages are immutable and deletes are manager-only, so replacing a rejected
// document needs a new CREATE, not an edit. docIds carry a version segment
// (`{bundleId}_{docType}_v{n}_{pageIndex}`); `bundleId` is still stored as
// its own FIELD (not just parsed from the id), so the retention sweep's
// existing `where('bundleId','==',...)` query already catches every version
// with no changes needed there. Old versions are deliberately never deleted
// individually — they're evidence a disputed original can't be erased by
// the person who uploaded it — only the whole-bundle retention sweep clears
// them, once every sibling submission has gone terminal.
//
// Docs written before this existed have no version segment at all (plain
// `{bundleId}_{docType}_{pageIndex}`) — get() falls back to that shape when
// version 1 isn't found under the new id, rather than migrating the handful
// of pre-existing docs.
//
// Never call this module directly from feature code — go through
// js/storage/index.js, which picks the active driver from
// config.storageDriver.
// ════════════════════════════════════════════════════

// Firestore's hard per-document limit is ~1MiB; 900KB leaves headroom for
// the doc's other fields (orgId, bundleId, docType, pageIndex, mime, bytes,
// agentId, teamId, uploadedBy, createdAt) plus Firestore's own per-document
// storage overhead. Checked against the ENCODED base64 string length (what
// actually gets stored), not the raw compressed blob's byte size — base64
// inflates size by ~33%, so this is the number that actually matters here.
const HARD_CEILING_CHARS = 900 * 1024;

function blobToBase64(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]); // strip the "data:<mime>;base64," prefix
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsDataURL(blob);
  });
}

// pages: [{pageIndex, mime, blob, bytes}] from js/documents.js's capture
// pipeline. version defaults to 1 (a fresh upload's first version — the
// Fix & Resubmit flow passes the next version number explicitly). Returns
// one ref per page: [{bundleId, docType, version, pageIndex}, ...].
//
// externalBat: optional — when provided, writes are added to that batch
// WITHOUT committing (the caller commits, e.g. combined atomically with the
// submissions themselves for a small enough upload — see
// createSubmissions()'s own externalBat doc comment). Omit for the normal
// standalone case (commits its own batch).
export async function put({bundleId, docType, pages, agentId, teamId, version, externalBat}){
  const v = version || 1;
  const encoded = await Promise.all(pages.map(async page => {
    const b64 = await blobToBase64(page.blob);
    if(b64.length > HARD_CEILING_CHARS){
      throw new Error(`${docType} page ${page.pageIndex+1} is ${Math.round(b64.length/1024)}KB encoded — exceeds the ${Math.round(HARD_CEILING_CHARS/1024)}KB per-page storage limit even after compression. Try a lower-resolution scan.`);
    }
    return { ...page, b64 };
  }));

  const bat = externalBat || newBatch();
  const refs = [];
  encoded.forEach(page => {
    const docId = `${bundleId}_${docType}_v${v}_${page.pageIndex}`;
    batchSet(bat, 'submissionDocs', docId, {
      orgId, bundleId, docType, version: v, pageIndex: page.pageIndex,
      mime: page.mime, b64: page.b64, bytes: page.bytes,
      agentId, teamId, uploadedBy: CU.uid, createdAt: now()
    });
    refs.push({ bundleId, docType, version: v, pageIndex: page.pageIndex });
  });
  if(!externalBat) await bat.commit();
  return refs;
}

// ref: {bundleId, docType, pageIndex, version} → { mime, dataURL } for ONE
// page. version defaults to 1 (the common case before any resubmission).
//
// Firestore denies (throws permission-denied) rather than resolving with an
// exists()===false snapshot when a get() target doesn't exist and the
// read rule's non-manager/backend clauses reference resource.data — those
// clauses error out on a null resource instead of evaluating to false, and
// an evaluation error denies the whole rule regardless of what a LATER `||`
// branch would have allowed. That makes "probe the new id shape, fall back
// to the legacy one if it's not there" throw instead of gracefully missing
// for any role whose OWN clause needs resource.data (agent, team_lead) —
// only manager/backend's clauses don't touch resource.data at all, so only
// they got a clean miss. Caught here instead of relying on rule wording,
// since a denied get() throws for every role the same way regardless.
async function tryGetDoc(docId){
  try {
    return await getDoc(doc(db,'submissionDocs',docId));
  } catch(e){
    return null;
  }
}
export async function get(ref){
  const version = ref.version || 1;
  const docId = `${ref.bundleId}_${ref.docType}_v${version}_${ref.pageIndex}`;
  let snap = await tryGetDoc(docId);
  if((!snap || !snap.exists()) && version === 1){
    // Pre-versioning docs used the old id shape with no version segment.
    const legacyId = `${ref.bundleId}_${ref.docType}_${ref.pageIndex}`;
    snap = await tryGetDoc(legacyId);
  }
  if(!snap || !snap.exists()) return null;
  const d = snap.data();
  return { mime: safeMime(d.mime), dataURL: `data:${safeMime(d.mime)};base64,${d.b64}` };
}

// Session P0 (ARCHITECTURE.md §18). `mime` is a STORED field, and
// submissionDocs create is open to the uploading agent — so the value here
// is attacker-controlled for anyone who writes a page document through the
// API instead of through the app. It used to be interpolated straight into
// `data:${d.mime};base64,…`, and that dataURL straight into
// `<img src="${…}">` at four render sites (js/leads.js's timeline viewer and
// js/queue.js's action panel — i.e. onto the screens of the backend reviewer,
// the TL and the manager). A mime of `x" onerror="…` closed the src attribute
// and injected an event handler, with no `<` anywhere for esc() to catch even
// after esc() was taught to escape quotes.
//
// Those render sites now escape the dataURL too, but the real fix is here:
// the capture pipeline (js/documents.js) recompresses EVERYTHING to JPEG —
// images via canvas.toBlob('image/jpeg', …), PDF pages via pdf.js render →
// canvas → the same JPEG path — so `image/jpeg` is the only value this
// driver can legitimately ever have written. Anything else is either
// pre-existing data from an older pipeline or forged, and in both cases
// rendering it as JPEG is correct: the browser sniffs the actual bytes for
// an <img> regardless of what the data URL claims.
const ALLOWED_MIMES = ['image/jpeg','image/png','image/webp'];
function safeMime(m){ return ALLOWED_MIMES.includes(m) ? m : 'image/jpeg'; }

// Deletes every stored page (every docType, every pageIndex) for a bundle —
// used when a single Submit-to-Backend attempt fails partway (cleanup after
// pages were already written but the submissions themselves couldn't be
// created — see js/leads.js's showSubmitModal). One summary logBulkAudit
// entry per call, since a single failed submit is its own discrete event.
export async function deleteByBundle(bundleId){
  return deleteByBundles([bundleId], `Cleaned up submissionDocs for bundle ${bundleId} (submit failure rollback)`);
}

// Deletes every stored page across MULTIPLE bundles in one pass — the
// retention sweep's primary tool (js/org.js runDocumentRetentionSweep).
// Firestore's 'in' operator caps at 30 values, so bundleIds are queried in
// chunks of 30; the resulting docs are deleted in the usual skipAudit +
// CHUNK-200 bulk pattern. Exactly ONE summary logBulkAudit entry for the
// WHOLE run (not one per bundle) — a sweep across many bundles is one
// discrete operation, not N of them.
export async function deleteByBundles(bundleIds, description){
  if(!bundleIds.length) return 0;
  const ID_CHUNK = 30;
  const docs = [];
  for(let i=0; i<bundleIds.length; i+=ID_CHUNK){
    const snap = await getDocs(query(collection(db,'submissionDocs'), where('bundleId','in',bundleIds.slice(i,i+ID_CHUNK))));
    docs.push(...snap.docs);
  }
  const CHUNK = 200;
  let deleted = 0;
  for(let i=0; i<docs.length; i+=CHUNK){
    const bat = newBatch();
    docs.slice(i,i+CHUNK).forEach(d => {
      batchDelete(bat, 'submissionDocs', d.id, {skipAudit:true});
      deleted++;
    });
    await bat.commit();
  }
  if(deleted) await logBulkAudit(description || `Deleted ${deleted} submissionDocs page(s) across ${bundleIds.length} bundle(s)`, deleted);
  return deleted;
}

// Cheap pre-count (getCountFromServer-style aggregation, NOT a full doc
// fetch) for the retention sweep's confirm dialog — "show counts before
// executing". Same chunked 'in' pattern as deleteByBundles.
export async function countPagesForBundles(bundleIds){
  if(!bundleIds.length) return 0;
  const ID_CHUNK = 30;
  let total = 0;
  for(let i=0; i<bundleIds.length; i+=ID_CHUNK){
    const agg = await getCountFromServer(query(collection(db,'submissionDocs'), where('bundleId','in',bundleIds.slice(i,i+ID_CHUNK))));
    total += agg.data().count;
  }
  return total;
}
