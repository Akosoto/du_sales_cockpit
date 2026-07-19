// ════════════════════════════════════════════════════
// COMBINED-PDF EXPORT (ARCHITECTURE.md §5, step 5a) — compiles every
// document type's LATEST version pages for a bundle into one PDF via
// jsPDF, one stored page per PDF page, with a labeled header per doc type.
// Available to backend, manager, and the submitting agent (js/leads.js's
// Submission Timeline and js/queue.js's action panel both call this).
// ════════════════════════════════════════════════════
import * as storage from './storage/index.js';

// Pinned deliberately — same reasoning as js/documents.js's pdf.js import:
// never track "latest" for a CDN dependency loaded at runtime with no
// build step to lock a version otherwise.
const JSPDF_VERSION = '2.5.2';
const JSPDF_URL = `https://cdn.jsdelivr.net/npm/jspdf@${JSPDF_VERSION}/dist/jspdf.es.min.js`;

let jsPDFPromise = null;
function loadJsPDF(){
  if(!jsPDFPromise) jsPDFPromise = import(JSPDF_URL).then(lib => lib.jsPDF);
  return jsPDFPromise;
}

// lines: every submission doc belonging to the bundle. Siblings share a
// bundleId but each carries its OWN requiredDocs copy (ARCHITECTURE.md §5 —
// a rejected submission's fix+resubmit only touches THAT submission, not
// its siblings) — a partial rejection+fix can leave siblings pointing at
// different versions of the SAME docType, so this takes the highest
// version seen across all of them as the one true "latest".
function latestDocsForBundle(lines){
  const byType = {};
  lines.forEach(l => (l.requiredDocs||[]).forEach(rd => {
    if(!rd.storageRef) return;
    const existing = byType[rd.type];
    if(!existing || (rd.storageRef.version||1) > (existing.storageRef.version||1)) byType[rd.type] = rd;
  }));
  return Object.values(byType);
}

function imageDimensions(dataURL){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to measure an image page.'));
    img.src = dataURL;
  });
}

export async function downloadBundlePdf(bundleId, lines, filenamePrefix){
  const docs = latestDocsForBundle(lines);
  if(!docs.length) throw new Error('No documents to export for this bundle.');

  const jsPDF = await loadJsPDF();
  const pdf = new jsPDF();
  let firstPage = true;

  for(const rd of docs){
    const ref = rd.storageRef;
    for(let i=0; i<ref.pageCount; i++){
      const page = await storage.get({ bundleId: ref.bundleId, docType: ref.docType, version: ref.version, pageIndex: i });
      if(!page) continue;
      if(!firstPage) pdf.addPage(); else firstPage = false;

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      pdf.setFontSize(11);
      pdf.text(`${rd.type} — page ${i+1} of ${ref.pageCount}`, 10, 10);

      const dims = await imageDimensions(page.dataURL);
      const maxW = pageWidth - 20, maxH = pageHeight - 25;
      const scale = Math.min(maxW/dims.w, maxH/dims.h);
      pdf.addImage(page.dataURL, 'JPEG', 10, 15, dims.w*scale, dims.h*scale);
    }
  }

  pdf.save(`${filenamePrefix||'bundle'}-${bundleId}.pdf`);
}
