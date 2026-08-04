/**
 * file-extract.js
 * Browser-side extraction of teaching materials.
 *
 * Strategy:
 *   - PDF / DOC(X) / TXT / MD  →  text only (original file is discarded)
 *                                  Upload limit: 50 MB
 *   - Images (JPG/PNG/GIF/WEBP) →  auto-compressed to ≤ 1 MB JPEG, longest
 *                                  side capped at 1600 px, quality 0.85
 *                                  Upload limit: 20 MB
 *
 * Returned normalized "material" object:
 *   { name, mime, size, kind: 'text'|'image', text?, dataUrl? }
 *   - For text kinds, `dataUrl` is intentionally absent (saves DB space).
 *   - For images, `dataUrl` is the COMPRESSED dataUrl and `size` reflects
 *     the compressed byte count.
 */

(function (global) {
  /* ── Size limits ───────────────────────────────────────── */
  const TEXT_MAX_BYTES  = 50 * 1024 * 1024;   // 50 MB raw upload for text-bearing docs
  const IMAGE_MAX_BYTES = 20 * 1024 * 1024;   // 20 MB raw upload for images (compressed after)
  const IMAGE_TARGET_BYTES = 1 * 1024 * 1024; // aim for ≤ 1 MB after compression
  const MAX_TEXT_CHARS  = 15000;              // cap extracted text per file (~3k tokens)

  /* ── Image compression knobs ───────────────────────────── */
  const IMG_MAX_EDGE_PX     = 1600;
  const IMG_JPEG_QUALITY    = 0.85;
  const IMG_MIN_QUALITY     = 0.45;     // floor when iteratively re-compressing
  const IMG_QUALITY_STEP    = 0.08;

  /* ── Helpers ───────────────────────────────────────────── */
  function fileToArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload  = () => resolve(r.result);
      r.readAsArrayBuffer(file);
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload  = () => resolve(r.result);
      r.readAsDataURL(file);
    });
  }

  function fileToText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload  = () => resolve(r.result);
      r.readAsText(file);
    });
  }

  function trimText(s) {
    if (!s) return '';
    s = s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (s.length > MAX_TEXT_CHARS) {
      s = s.slice(0, MAX_TEXT_CHARS) + '\n…[truncated]';
    }
    return s;
  }

  function dataUrlByteSize(dataUrl) {
    // base64 payload after the comma
    const idx = dataUrl.indexOf(',');
    if (idx < 0) return 0;
    const b64 = dataUrl.slice(idx + 1);
    // 4 base64 chars = 3 bytes; strip padding
    const padding = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    return Math.floor(b64.length * 3 / 4) - padding;
  }

  /* ── PDF (pdf.js) ──────────────────────────────────────── */
  async function ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    return window.pdfjsLib;
  }

  async function extractPdf(file) {
    const lib = await ensurePdfJs();
    const buf = await fileToArrayBuffer(file);
    const pdf = await lib.getDocument({ data: buf }).promise;
    const out = [];
    const maxPages = Math.min(pdf.numPages, 50);     // text-only extraction is cheap, allow more pages
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const txt = content.items.map(it => it.str).join(' ');
      out.push(txt);
      if (out.join('\n').length > MAX_TEXT_CHARS) break;
    }
    return trimText(out.join('\n\n'));
  }

  /* ── DOCX (mammoth.js) ─────────────────────────────────── */
  async function ensureMammoth() {
    if (window.mammoth) return window.mammoth;
    await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js');
    return window.mammoth;
  }

  async function extractDocx(file) {
    const m = await ensureMammoth();
    const buf = await fileToArrayBuffer(file);
    const result = await m.extractRawText({ arrayBuffer: buf });
    return trimText(result.value || '');
  }

  /* ── Image compression (canvas) ────────────────────────── */
  function loadImageBitmapFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to decode image')); };
      img.src = url;
    });
  }

  function canvasToDataUrl(canvas, mime, quality) {
    return canvas.toDataURL(mime, quality);
  }

  /**
   * Compress an image File to a JPEG dataUrl that is:
   *   - longest side ≤ IMG_MAX_EDGE_PX
   *   - byte size ≤ IMAGE_TARGET_BYTES (iteratively lowers quality if needed)
   * GIF/animated images lose animation; that's acceptable for our use case.
   */
  async function compressImage(file) {
    const img = await loadImageBitmapFromFile(file);

    // Compute target dimensions
    let { width: w, height: h } = img;
    const longest = Math.max(w, h);
    if (longest > IMG_MAX_EDGE_PX) {
      const scale = IMG_MAX_EDGE_PX / longest;
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    // Draw to canvas
    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // White background so PNG transparency becomes white in JPEG (avoids ugly black bg)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    // Try progressive quality reduction until size fits
    let quality = IMG_JPEG_QUALITY;
    let dataUrl = canvasToDataUrl(canvas, 'image/jpeg', quality);
    let bytes   = dataUrlByteSize(dataUrl);

    while (bytes > IMAGE_TARGET_BYTES && quality > IMG_MIN_QUALITY) {
      quality = Math.max(IMG_MIN_QUALITY, quality - IMG_QUALITY_STEP);
      dataUrl = canvasToDataUrl(canvas, 'image/jpeg', quality);
      bytes   = dataUrlByteSize(dataUrl);
    }

    // If still too big at min quality, shrink dimensions and retry once
    if (bytes > IMAGE_TARGET_BYTES) {
      const shrink = Math.sqrt(IMAGE_TARGET_BYTES / bytes) * 0.95;   // small safety margin
      const w2 = Math.max(320, Math.round(w * shrink));
      const h2 = Math.max(320, Math.round(h * shrink));
      const c2 = document.createElement('canvas');
      c2.width = w2; c2.height = h2;
      const ctx2 = c2.getContext('2d');
      ctx2.fillStyle = '#ffffff';
      ctx2.fillRect(0, 0, w2, h2);
      ctx2.drawImage(img, 0, 0, w2, h2);
      dataUrl = canvasToDataUrl(c2, 'image/jpeg', IMG_JPEG_QUALITY);
      bytes   = dataUrlByteSize(dataUrl);
    }

    return { dataUrl, bytes, width: w, height: h, quality };
  }

  /* ── Dynamic script loader ─────────────────────────────── */
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${url}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Failed to load ' + url)));
        return;
      }
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => { s.dataset.loaded = 'true'; resolve(); };
      s.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
  }

  /* ── Public: extract a single file ─────────────────────── */
  async function extractFile(file) {
    const name = file.name;
    const mime = (file.type || '').toLowerCase();
    const lower = name.toLowerCase();
    const isImage = mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/i.test(lower);

    // Per-type size limit
    const limit = isImage ? IMAGE_MAX_BYTES : TEXT_MAX_BYTES;
    if (file.size > limit) {
      const limitMb = (limit / 1024 / 1024).toFixed(0);
      throw new Error(`"${name}" is too large (max ${limitMb} MB).`);
    }

    // ── Image branch — compress to ≤ 1 MB JPEG dataUrl
    if (isImage) {
      let compressed;
      try {
        compressed = await compressImage(file);
      } catch (e) {
        throw new Error(`Could not process image "${name}": ${e.message}`);
      }
      return {
        name,
        mime: 'image/jpeg',
        size: compressed.bytes,
        kind: 'image',
        dataUrl: compressed.dataUrl,
        // helpful debug info, not required by the AI
        _origSize: file.size,
        _dims: `${compressed.width}×${compressed.height}`,
        _quality: compressed.quality
      };
    }

    // ── PDF — extract text only
    if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
      const text = await extractPdf(file);
      if (!text) throw new Error(`Could not extract text from "${name}" (scanned PDF?). Please use a text-based PDF.`);
      return {
        name, mime: 'application/pdf', size: file.size,
        kind: 'text', text
      };
    }

    // ── DOCX — extract text only
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || lower.endsWith('.docx')) {
      const text = await extractDocx(file);
      if (!text) throw new Error(`Could not extract text from "${name}". Is the file empty?`);
      return {
        name,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: file.size, kind: 'text', text
      };
    }

    // ── Legacy .doc — not supported
    if (mime === 'application/msword' || lower.endsWith('.doc')) {
      throw new Error(`Legacy .doc format is not supported. Please save "${name}" as .docx and re-upload.`);
    }

    // ── Plain text / markdown
    if (mime.startsWith('text/') || /\.(txt|md|markdown)$/i.test(lower)) {
      const txt = await fileToText(file);
      return {
        name, mime: mime || 'text/plain', size: file.size,
        kind: 'text', text: trimText(txt)
      };
    }

    throw new Error(`Unsupported file type: ${name}`);
  }

  /* ── Public: extract multiple files (sequential) ───────── */
  async function extractFiles(fileList, onProgress) {
    const results = [];
    const errors  = [];
    const files = Array.from(fileList);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (onProgress) onProgress({ index: i, total: files.length, file: f, status: 'start' });
      try {
        const item = await extractFile(f);
        results.push(item);
        if (onProgress) onProgress({ index: i, total: files.length, file: f, status: 'done' });
      } catch (e) {
        errors.push({ file: f, error: e.message });
        if (onProgress) onProgress({ index: i, total: files.length, file: f, status: 'error', error: e.message });
      }
    }
    return { results, errors };
  }

  /* ── Helper: format size ───────────────────────────────── */
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
    return (bytes/1024/1024).toFixed(2) + ' MB';
  }

  /* ── Helper: nice icon class per kind ──────────────────── */
  function fileIconClass(material) {
    if (material.kind === 'image') return 'fa-image';
    const m = (material.mime || '').toLowerCase();
    if (m.includes('pdf')) return 'fa-file-pdf';
    if (m.includes('word') || m.includes('officedocument')) return 'fa-file-word';
    return 'fa-file-lines';
  }

  /* ── Export ────────────────────────────────────────────── */
  global.FileExtract = {
    extractFile,
    extractFiles,
    formatSize,
    fileIconClass,
    TEXT_MAX_BYTES,
    IMAGE_MAX_BYTES,
    IMAGE_TARGET_BYTES,
    MAX_TEXT_CHARS,
  };
})(window);
