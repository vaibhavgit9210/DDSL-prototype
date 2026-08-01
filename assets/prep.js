// Shared upload preparation for both views: turn the user's files into the
// image list the ddsl-brain worker expects ({name, media_type, data_b64}).
// PDFs are rasterised page-by-page in the browser with pdf.js (vendored in
// assets/vendor/ — no CDN), so the worker never has to parse a PDF.

const PREP_TARGET_PX = 2200;      // long edge of a rendered PDF page
const PREP_MAX_PAGES = 24;        // matches the worker's per-request cap

let _pdfjs = null;
async function _loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import('../assets/vendor/pdf.min.mjs');
  _pdfjs.GlobalWorkerOptions.workerSrc =
    new URL('../assets/vendor/pdf.worker.min.mjs', location.href).href;
  return _pdfjs;
}

function _readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

// files: File[]; onStatus: (text) => void. Returns [{name, media_type, data_b64}].
async function prepareFiles(files, onStatus) {
  const out = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.dwg') || lower.endsWith('.dxf')) {
      throw new Error(`${file.name}: the hosted demo can't read CAD files — ` +
        'upload the matching PDF export of this sheet instead.');
    }
    if (lower.endsWith('.pdf')) {
      onStatus?.(`Rendering ${file.name}…`);
      const pdfjs = await _loadPdfjs();
      const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
      const doc = await loadingTask.promise;
      for (let p = 1; p <= doc.numPages; p++) {
        if (out.length >= PREP_MAX_PAGES)
          throw new Error(`too many pages (max ${PREP_MAX_PAGES} per analysis)`);
        onStatus?.(`Rendering ${file.name} — page ${p}/${doc.numPages}…`);
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = PREP_TARGET_PX / Math.max(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const dataUrl = canvas.toDataURL('image/png');
        out.push({
          name: doc.numPages > 1 ? `${file.name} — page ${p}/${doc.numPages}` : file.name,
          media_type: 'image/png',
          data_b64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        });
      }
      loadingTask.destroy();
      continue;
    }
    const type = /jpe?g$/.test(lower) ? 'image/jpeg'
      : lower.endsWith('.webp') ? 'image/webp'
      : lower.endsWith('.png') ? 'image/png' : null;
    if (!type) throw new Error(`${file.name}: unsupported file type — upload PDF, PNG or JPG.`);
    if (out.length >= PREP_MAX_PAGES)
      throw new Error(`too many pages (max ${PREP_MAX_PAGES} per analysis)`);
    const dataUrl = await _readAsDataURL(file);
    out.push({ name: file.name, media_type: type,
               data_b64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
  }
  return out;
}

// Dev/test hook: ?testpdf=<url> fetches a drawing and runs it through the real
// analyze pipeline (used by headless-Chrome checks; harmless otherwise).
async function runTestHook(analyzeFn) {
  const u = new URLSearchParams(location.search).get('testpdf');
  if (!u) return;
  const blob = await (await fetch(u)).blob();
  const name = u.split('/').pop() || 'test.pdf';
  analyzeFn([new File([blob], decodeURIComponent(name), { type: blob.type })]);
}
