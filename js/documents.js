// ════════════════════════════════════════════════════
// DOCUMENT CAPTURE PIPELINE (ARCHITECTURE.md §6) — compresses images and
// converts PDF pages to images client-side, BEFORE anything reaches the
// StorageAdapter (js/storage/index.js). No raw PDF bytes are ever stored —
// only rendered JPEG pages, exactly like a scanned image.
// ════════════════════════════════════════════════════

const MAX_EDGE = 1200;
const TARGET_BYTES = 300 * 1024;
const MIN_QUALITY = 0.4;
export const PDF_PAGE_CAP = 10;

// Pinned deliberately — never track "latest" for a CDN dependency loaded at
// runtime with no build step to lock a version otherwise.
//
// Session P0 (ARCHITECTURE.md §18): was 4.0.379, which predates the
// CVE-2024-4367 fix in 4.2.67 — arbitrary JavaScript execution in the
// hosting origin when a crafted PDF is opened with the default
// isEvalSupported:true. Reachable by anyone who can attach a document to a
// submission, since backend staff open agent-uploaded PDFs through
// captureFile(). Upgraded and re-verified against tools/pdfjs-capture-test.html,
// which asserts not just that capture resolves but that each produced JPEG
// contains actual ink — a pdf.js major upgrade's real failure mode is a
// silently blank page, not a thrown error.
//
// 6.x exists (6.1.200 at time of writing) but is deliberately not taken:
// nothing in it is required to close this CVE, and a second major jump would
// widen the API-break surface for no security gain. Revisit on the next
// advisory.
export const PDFJS_VERSION = '5.7.284';
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfjsLibPromise = null;
function loadPdfJs(){
  if(!pdfjsLibPromise){
    pdfjsLibPromise = import(PDFJS_URL).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
  }
  return pdfjsLibPromise;
}

// Draws `source` (an <img> or a rendered PDF-page canvas) onto a NEW canvas
// resized so its longer edge is <= MAX_EDGE, then compresses to JPEG,
// stepping quality down toward MIN_QUALITY until under TARGET_BYTES — a
// best-effort target, not a hard requirement (the StorageAdapter's own
// 900KB-encoded ceiling, checked after this, is the real gate).
async function resizeAndCompress(source, sourceWidth, sourceHeight){
  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  let quality = 0.72;
  let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  while(blob.size > TARGET_BYTES && quality > MIN_QUALITY){
    quality = Math.max(MIN_QUALITY, quality - 0.1);
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  return blob;
}

function loadImage(file){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // HEIC decoding in <img>/canvas is Safari-only in practice — every
      // other browser fires onerror on a HEIC file, which looks identical
      // to a genuinely corrupt file from here, hence the explicit mention.
      reject(new Error(`Could not read "${file.name}" — the file may be corrupt, or (for HEIC) unsupported by this browser. Try converting to JPG/PNG.`));
    };
    img.src = url;
  });
}

// One image file → exactly one stored page.
async function captureImage(file){
  const img = await loadImage(file);
  const blob = await resizeAndCompress(img, img.naturalWidth, img.naturalHeight);
  URL.revokeObjectURL(img.src);
  return [{ pageIndex: 0, mime: 'image/jpeg', blob, bytes: blob.size }];
}

// One PDF file → up to PDF_PAGE_CAP stored pages, each rendered at ~150 DPI
// then run through the SAME resize+compress pipeline as a scanned image.
// pdf.js viewport scale is relative to the PDF's native 72-DPI point size.
async function capturePdf(file){
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  // isEvalSupported:false is the mitigation the CVE-2024-4367 advisory names
  // in its own right, independent of version — it is what actually stops a
  // crafted font program from reaching eval() in this origin. Kept alongside
  // the version bump rather than instead of it, so this code path is not
  // relying on a single control: if a future pdf.js regression reopens the
  // same class of bug, this flag still holds. The only thing it costs is an
  // eval-based fast path for font rendering, which is irrelevant here —
  // these pages are rasterized to JPEG once and never displayed as live PDF.
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pageCount = Math.min(pdf.numPages, PDF_PAGE_CAP);
  const truncated = pdf.numPages > PDF_PAGE_CAP;

  const pages = [];
  const DPI_SCALE = 150 / 72;
  for(let i=1; i<=pageCount; i++){
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: DPI_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await resizeAndCompress(canvas, canvas.width, canvas.height);
    pages.push({ pageIndex: i-1, mime: 'image/jpeg', blob, bytes: blob.size });
  }
  return { pages, truncated, totalPages: pdf.numPages };
}

// The one entry point the Submit-to-Backend modal calls. Returns
// { pages: [{pageIndex, mime, blob, bytes}], truncated, totalPages } —
// `truncated`/`totalPages` are only meaningful for PDFs; a single image is
// always exactly one page, never truncated.
export async function captureFile(file){
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if(isPdf) return capturePdf(file);
  const pages = await captureImage(file);
  return { pages, truncated: false, totalPages: 1 };
}
