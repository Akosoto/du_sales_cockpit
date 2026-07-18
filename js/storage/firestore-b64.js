import { db, CU, doc, getDoc, getDocs, collection, query, where } from '../state.js';
import { newBatch, batchSet, batchDelete, logBulkAudit } from '../db.js';
import { now } from '../helpers.js';
import { orgId } from '../../config.js';

// ════════════════════════════════════════════════════
// firestore-b64 driver (ARCHITECTURE.md §6) — free-tier document storage.
// One Firestore doc PER PAGE in a top-level `submissionDocs` collection,
// keyed by bundleId+docType+pageIndex (NOT by any individual submission's
// id) — files are shared PER BUNDLE, since company documents (Trade
// License, Emirates ID) attach once per Submit-to-Backend form, not once
// per product line.
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
// pipeline. Returns one ref per page: [{bundleId, docType, pageIndex}, ...].
//
// externalBat: optional — when provided, writes are added to that batch
// WITHOUT committing (the caller commits, e.g. combined atomically with the
// submissions themselves for a small enough upload — see
// createSubmissions()'s own externalBat doc comment). Omit for the normal
// standalone case (commits its own batch).
export async function put({bundleId, docType, pages, agentId, teamId, externalBat}){
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
    const docId = `${bundleId}_${docType}_${page.pageIndex}`;
    batchSet(bat, 'submissionDocs', docId, {
      orgId, bundleId, docType, pageIndex: page.pageIndex,
      mime: page.mime, b64: page.b64, bytes: page.bytes,
      agentId, teamId, uploadedBy: CU.uid, createdAt: now()
    });
    refs.push({ bundleId, docType, pageIndex: page.pageIndex });
  });
  if(!externalBat) await bat.commit();
  return refs;
}

// ref: {bundleId, docType, pageIndex} → { mime, dataURL } for ONE page.
export async function get(ref){
  const docId = `${ref.bundleId}_${ref.docType}_${ref.pageIndex}`;
  const snap = await getDoc(doc(db,'submissionDocs',docId));
  if(!snap.exists()) return null;
  const d = snap.data();
  return { mime: d.mime, dataURL: `data:${d.mime};base64,${d.b64}` };
}

// Deletes every stored page (every docType, every pageIndex) for a bundle —
// the retention sweep's primary tool. Bulk-op pattern (skipAudit per-op +
// one summary logBulkAudit entry, CHUNK 200) since a sweep run can touch
// many pages across many bundles in one pass.
export async function deleteByBundle(bundleId){
  const snap = await getDocs(query(collection(db,'submissionDocs'), where('bundleId','==',bundleId)));
  const docs = snap.docs;
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
  if(deleted) await logBulkAudit(`Deleted ${deleted} submissionDocs page(s) for bundle ${bundleId}`, deleted);
  return deleted;
}
