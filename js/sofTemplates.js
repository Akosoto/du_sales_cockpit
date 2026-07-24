import { db, doc, getDoc, getDocs, collection, query, where } from './state.js';
import { newBatch, batchAdd, batchSet, batchUpdate, batchDelete, logBulkAudit } from './db.js';

// ════════════════════════════════════════════════════
// SOF TEMPLATE LIBRARY (Session S1, ARCHITECTURE.md §17) — managers upload
// blank Service Order Forms (fillable PDF/Excel the CUSTOMER must be able
// to type into); every role sees + downloads only the LATEST version of
// each named form; managers see full version history + can delete a
// superseded version. RAW ORIGINAL FILE BYTES only, base64-chunked —
// deliberately NOT js/storage/firestore-b64.js's driver (that pipeline
// client-side recompresses submission evidence to JPEG pages, which would
// destroy a fillable form's actual field structure — the opposite of this
// feature's purpose). No shared code, no shared schema with that driver.
// ════════════════════════════════════════════════════

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB, RAW size, pre-encode

// ≤700KB per chunk, arithmetic done ENTIRELY on the ENCODED base64 string
// length — NOT the original file's raw bytes, and NOT an echo of
// js/storage/firestore-b64.js's unrelated 900KB convention (that driver
// chunks already-recompressed image pages, a different job). Firestore's
// hard per-document limit is ~1MiB; base64 inflates raw bytes by ~4/3
// (~33%), and every chunk doc also carries orgId/isLatest field overhead
// on top of `data`. "700KB raw, then encode" would land at ~933KB encoded,
// leaving under 100KB of margin — the one failure mode this design can't
// tolerate is a write that only fails on a manager's LARGEST file, exactly
// where the 5MB cap is meant to still work. Sizing chunks so their ENCODED
// form itself is ≤700KB (700*1024 = 716,800 characters) leaves ~324KB of
// headroom under the 1MiB ceiling.
const CHUNK_CHARS = 700 * 1024;

const ALLOWED_TYPES = [
  { ext:'pdf',  mime:'application/pdf', fileType:'pdf' },
  { ext:'xlsx', mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileType:'xlsx' },
  { ext:'xls',  mime:'application/vnd.ms-excel', fileType:'xls' }
];
const MIME_BY_TYPE = Object.fromEntries(ALLOWED_TYPES.map(t=>[t.fileType,t.mime]));

// Validates BOTH extension and MIME — a renamed file with a spoofed MIME
// is rejected by extension; a correctly-typed file under the wrong
// extension is rejected by MIME. Some browsers report an empty/generic
// MIME for legacy .xls files — only a MISMATCHED non-empty MIME is
// rejected, never an absent one, to avoid false positives on real files.
export function validateSofFile(file){
  if(!file || !file.size){
    throw new Error(`"${file?.name||'file'}" appears to be empty.`);
  }
  if(file.size > MAX_FILE_BYTES){
    throw new Error(`"${file.name}" is ${(file.size/1024/1024).toFixed(1)}MB — the limit is 5MB.`);
  }
  const ext = (file.name.split('.').pop()||'').toLowerCase();
  const byExt = ALLOWED_TYPES.find(t => t.ext === ext);
  if(!byExt){
    throw new Error(`"${file.name}" — only PDF and Excel (.xlsx/.xls) files are allowed.`);
  }
  if(file.type && !ALLOWED_TYPES.some(t => t.mime === file.type)){
    throw new Error(`"${file.name}"'s file type (${file.type}) doesn't match a .${ext} file.`);
  }
  return byExt.fileType;
}

function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]); // strip "data:<mime>;base64,"
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

// Slices the FULL encoded string directly at CHUNK_CHARS character
// boundaries — not aligned to base64's 3-byte/4-char groups, and that's
// fine: chunks are only ever decoded AFTER full reassembly (all pieces
// concatenated in order, then ONE atob() call), never decoded
// individually, so a mid-group split has no effect on correctness.
function sliceIntoChunks(b64){
  const chunks = [];
  for(let i=0; i<b64.length; i+=CHUNK_CHARS) chunks.push(b64.slice(i, i+CHUNK_CHARS));
  return chunks;
}

export const normSofName = s => (s||'').trim().toLowerCase();

// ── Reads (ARCHITECTURE.md §17.3) ──

// The ONE list query every non-manager role's Forms tab needs:
// where('isLatest','==',true) — matches the read rule's own non-manager
// condition (resource.data.isLatest == true) exactly, so it's provable for
// every role, not just manager.
export async function fetchLatestForms(){
  const snap = await getDocs(query(collection(db,'sofTemplates'), where('isLatest','==',true)));
  return snap.docs.map(d=>({id:d.id, ...d.data()})).sort((a,b)=> (a.name||'').localeCompare(b.name||''));
}

// Manager-only: EVERY version of EVERY form, bare/unfiltered — provable via
// the manager clause's request-time-only role() escape (§12/§17.3), not the
// isLatest condition. Caller groups by name + sorts versions client-side.
export async function fetchAllTemplatesForManager(){
  const snap = await getDocs(collection(db,'sofTemplates'));
  return snap.docs.map(d=>({id:d.id, ...d.data()}))
    .sort((a,b)=> (a.name||'').localeCompare(b.name||'') || (b.version-a.version));
}

// ── Upload (ARCHITECTURE.md §17.2) ──

// priorLatest: {id, version, chunkCount} of the name's CURRENTLY-latest
// version, if the manager's typed/selected name case-insensitively matches
// an entry already in their already-fetched forms list (fetchLatestForms()
// or fetchAllTemplatesForManager()) — the CALLER supplies this; no extra
// query is run here to check for a name collision (§17.2/§17.3 — the only
// two list-query shapes this feature needs are the two functions above).
// Omit for a brand-new form name (version starts at 1, nothing to flip).
//
// One atomic batch: new parent + all new chunks, AND (if priorLatest) flip
// isLatest:false on the prior parent + every one of its chunks — never
// partially applied. A 5MB file is at most ~10 new chunks; flipping a
// prior version of similar size adds at most ~10 more updates — far under
// Firestore's 500-op batch cap.
export async function uploadSofTemplate({ file, name, priorLatest }){
  const fileType = validateSofFile(file);
  const b64 = await fileToBase64(file);
  const chunks = sliceIntoChunks(b64);
  const version = priorLatest ? (Number(priorLatest.version)||0) + 1 : 1;

  const bat = newBatch();
  const parentRef = batchAdd(bat, 'sofTemplates', {
    name: (name||'').trim(), fileName: file.name, fileType,
    version, isLatest: true, sizeBytes: file.size, chunkCount: chunks.length
  });
  chunks.forEach((data,i) => {
    batchSet(bat, `sofTemplates/${parentRef.id}/chunks`, `chunk-${i}`, { data, isLatest:true });
  });

  if(priorLatest){
    batchUpdate(bat, 'sofTemplates', priorLatest.id, { isLatest:false });
    for(let i=0; i<(Number(priorLatest.chunkCount)||0); i++){
      batchUpdate(bat, `sofTemplates/${priorLatest.id}/chunks`, `chunk-${i}`, { isLatest:false });
    }
  }

  await bat.commit();
  return { id: parentRef.id, version, chunkCount: chunks.length };
}

// ── Download (ARCHITECTURE.md §17.5) ──

// Direct gets by index, chunk-0..chunk-(chunkCount-1) — NEVER a list query
// on the chunks subcollection (§17.3). Reassembles byte-identical to the
// upload: concatenate every chunk's base64 string in order, decode ONCE,
// wrap in a Blob with the original MIME, save under the ORIGINAL fileName.
export async function downloadSofTemplate(template){
  const { id, chunkCount, fileType, fileName } = template;
  const parts = [];
  for(let i=0; i<chunkCount; i++){
    const snap = await getDoc(doc(db,'sofTemplates',id,'chunks',`chunk-${i}`));
    if(!snap.exists()) throw new Error(`Missing chunk ${i+1} of ${chunkCount} — the file may be corrupted.`);
    parts.push(snap.data().data);
  }
  const b64 = parts.join('');
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for(let i=0; i<byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: MIME_BY_TYPE[fileType] || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName || 'form';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ── Delete (manager-only, ARCHITECTURE.md §17.5) ──

// Blocked outright when the target is the CURRENT latest version — a form
// name must never be left with zero versions or a silently-missing
// latest; upload a replacement instead. skipAudit + one summary
// logBulkAudit entry (mirrors js/storage/firestore-b64.js's
// deleteByBundles — many doc deletes collapsed into one logical action),
// not per-chunk audit entries (unlike upload, which mirrors that same
// driver's put() — a create is one doc per meaningful new fact, a
// whole-version delete is one bulk cleanup action).
export async function deleteSofVersion(template){
  if(template.isLatest){
    throw new Error('This is the latest version — upload a replacement instead of deleting it.');
  }
  const bat = newBatch();
  let count = 0;
  for(let i=0; i<(Number(template.chunkCount)||0); i++){
    batchDelete(bat, `sofTemplates/${template.id}/chunks`, `chunk-${i}`, {skipAudit:true});
    count++;
  }
  batchDelete(bat, 'sofTemplates', template.id, {skipAudit:true});
  count++;
  await bat.commit();
  await logBulkAudit(`Deleted SOF template version ${template.version} of "${template.name}" (${template.fileName})`, count);
}
