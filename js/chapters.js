/**
 * chapters.js
 * Shared logic for Teacher (chapter CRUD) & Student (chapter list) views.
 *
 * Page identifies its mode + module via global vars set in the HTML:
 *   window.CH_MODULE = 'conversation' | 'vocabulary'
 *   window.CH_MODE   = 'teacher' | 'student'
 */

(function () {
  const MODULE = window.CH_MODULE;
  const MODE   = window.CH_MODE || 'teacher';

  // Per-module configuration: where "Start" links to
  const PRACTICE_URL = {
    conversation: 'conversation.html',
    vocabulary:   'vocabulary.html'
  }[MODULE];

  const MODULE_LABEL = {
    conversation: 'Conversation Practice',
    vocabulary:   'Vocabulary Practice'
  }[MODULE];

  /* ──────────────────────────────────────────────────────────
     DOM
     ────────────────────────────────────────────────────────── */
  const $list      = document.getElementById('chList');
  const $loading   = document.getElementById('chLoading');
  const $empty     = document.getElementById('chEmpty');
  const $btnNew    = document.getElementById('chBtnNew');
  const $modal     = document.getElementById('chModal');
  const $modalTitle= document.getElementById('chModalTitle');
  const $modalClose= document.getElementById('chModalClose');
  const $form      = document.getElementById('chForm');
  const $fTitle    = document.getElementById('chFieldTitle');
  const $fDesc     = document.getElementById('chFieldDesc');
  const $fPrompt   = document.getElementById('chFieldPrompt');
  const $dropzone  = document.getElementById('chDropzone');
  const $fileInput = document.getElementById('chFileInput');
  const $fileList  = document.getElementById('chFileList');
  const $btnSave   = document.getElementById('chBtnSave');
  const $btnCancel = document.getElementById('chBtnCancel');
  const $pageTitle = document.getElementById('chPageTitle');

  // local state for the editor modal
  let editingId = null;
  let materials = [];    // current edit buffer

  /* ──────────────────────────────────────────────────────────
     UI helpers
     ────────────────────────────────────────────────────────── */
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'ch-toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* ──────────────────────────────────────────────────────────
     API
     ────────────────────────────────────────────────────────── */
  async function api(path, opts) {
    const r = await fetch('tables/chapters' + (path || ''), opts);
    if (!r.ok && r.status !== 204) {
      const body = await r.text();
      throw new Error(`API ${r.status}: ${body.slice(0,200)}`);
    }
    if (r.status === 204) return null;
    return await r.json();
  }

  async function fetchChapters() {
    const data = await api('?limit=500');
    let rows = (data && data.data) || [];
    rows = rows.filter(r => r.module === MODULE && !r.deleted);
    rows.sort((a, b) => {
      const oa = a.order_index ?? 0, ob = b.order_index ?? 0;
      if (oa !== ob) return oa - ob;
      return (a.created_at || 0) - (b.created_at || 0);
    });
    return rows;
  }

  async function createChapter(payload) {
    return await api('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function updateChapter(id, payload) {
    return await api('/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function deleteChapter(id) {
    return await api('/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  /* ──────────────────────────────────────────────────────────
     Rendering
     ────────────────────────────────────────────────────────── */
  function render(chapters) {
    $loading.style.display = 'none';

    if (!chapters.length) {
      $list.style.display  = 'none';
      $empty.style.display = '';
      return;
    }
    $empty.style.display = 'none';
    $list.style.display  = 'grid';
    $list.innerHTML = '';

    chapters.forEach(c => {
      const card = document.createElement('article');
      card.className = 'ch-card';

      const matCount = Array.isArray(c.materials) ? c.materials.length : 0;
      const promptLen = (c.custom_prompt || '').length;

      let actions = '';
      if (MODE === 'teacher') {
        actions = `
          <button class="btn-secondary-ch" data-act="edit">
            <i class="fas fa-pen"></i> Edit
          </button>
          <a href="${PRACTICE_URL}?chapter=${encodeURIComponent(c.id)}" class="btn-primary-ch ch-start">
            <i class="fas fa-play"></i> Preview
          </a>
          <button class="btn-danger-ch" data-act="del" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        `;
      } else {
        actions = `
          <a href="${PRACTICE_URL}?chapter=${encodeURIComponent(c.id)}" class="btn-primary-ch ch-start">
            <i class="fas fa-play"></i> Start
          </a>
        `;
      }

      card.innerHTML = `
        <div class="ch-card-head">
          <h3>${escHtml(c.title || 'Untitled chapter')}</h3>
        </div>
        <p class="ch-desc">${escHtml(c.description || 'No description.')}</p>
        <div class="ch-meta">
          <span><i class="fas fa-file"></i>${matCount} material${matCount===1?'':'s'}</span>
          <span><i class="fas fa-wand-magic-sparkles"></i>${promptLen ? 'Custom prompt' : 'Default prompt'}</span>
        </div>
        <div class="ch-actions">${actions}</div>
      `;

      // bind actions
      if (MODE === 'teacher') {
        card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(c));
        card.querySelector('[data-act="del"]').addEventListener('click', () => {
          if (confirm(`Delete chapter "${c.title}"? This cannot be undone.`)) {
            deleteChapter(c.id)
              .then(() => { toast('Chapter deleted', 'ok'); reload(); })
              .catch(e => toast('Delete failed: ' + e.message, 'err'));
          }
        });
      }

      $list.appendChild(card);
    });
  }

  async function reload() {
    $loading.style.display = '';
    $list.innerHTML = '';
    $empty.style.display = 'none';
    try {
      const rows = await fetchChapters();
      render(rows);
    } catch (e) {
      $loading.innerHTML = `<i class="fas fa-circle-exclamation"></i> Failed to load chapters: ${escHtml(e.message)}`;
    }
  }

  /* ──────────────────────────────────────────────────────────
     Editor modal (Teacher only)
     ────────────────────────────────────────────────────────── */
  function openEditor(chapter) {
    editingId = chapter ? chapter.id : null;
    $modalTitle.textContent = chapter ? 'Edit Chapter' : 'New Chapter';
    $fTitle.value  = chapter?.title || '';
    $fDesc.value   = chapter?.description || '';
    $fPrompt.value = chapter?.custom_prompt || '';
    materials = chapter && Array.isArray(chapter.materials)
      ? JSON.parse(JSON.stringify(chapter.materials))
      : [];
    renderFileList();
    $modal.style.display = 'flex';
    setTimeout(() => $fTitle.focus(), 50);
  }

  function closeEditor() {
    $modal.style.display = 'none';
    editingId = null;
    materials = [];
    $form.reset();
    $fileList.innerHTML = '';
  }

  function renderFileList() {
    $fileList.innerHTML = '';
    if (!materials.length) return;
    materials.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'ch-file-item';
      const icon = FileExtract.fileIconClass(m);

      let meta;
      if (m.kind === 'image') {
        // Show "stored 480 KB · 1600×1200" or with original size if known
        const stored = FileExtract.formatSize(m.size || 0);
        const dims   = m._dims ? ' · ' + m._dims : '';
        const orig   = m._origSize && m._origSize > (m.size || 0)
          ? ' (was ' + FileExtract.formatSize(m._origSize) + ')'
          : '';
        meta = `image · ${stored}${dims}${orig}`;
      } else {
        // Text-bearing doc: show ONLY extracted text length (we no longer store the original)
        const chars = (m.text || '').length;
        meta = chars
          ? `${chars.toLocaleString()} chars extracted`
          : 'no text extracted';
      }

      row.innerHTML = `
        <i class="fas ${icon} f-icon"></i>
        <div class="f-name">${escHtml(m.name)}</div>
        <span class="f-meta">${meta}</span>
        <button type="button" class="f-remove" title="Remove">
          <i class="fas fa-times"></i>
        </button>
      `;
      row.querySelector('.f-remove').addEventListener('click', () => {
        materials.splice(idx, 1);
        renderFileList();
      });
      $fileList.appendChild(row);
    });
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    // show "extracting…" placeholders
    const placeholders = [];
    Array.from(files).forEach(f => {
      const row = document.createElement('div');
      row.className = 'ch-file-item';
      row.innerHTML = `
        <i class="fas fa-spinner fa-spin f-icon"></i>
        <div class="f-name">${escHtml(f.name)}</div>
        <span class="f-extracting">extracting…</span>
      `;
      $fileList.appendChild(row);
      placeholders.push(row);
    });

    const { results, errors } = await FileExtract.extractFiles(files);
    // remove placeholders
    placeholders.forEach(p => p.remove());

    if (errors.length) {
      errors.forEach(e => toast(`✕ ${e.file.name}: ${e.error}`, 'err'));
    }
    if (results.length) {
      materials = materials.concat(results);
      renderFileList();
      toast(`Added ${results.length} file${results.length===1?'':'s'}`, 'ok');
    }
  }

  async function saveChapter(e) {
    e.preventDefault();
    const title = $fTitle.value.trim();
    if (!title) {
      toast('Title is required', 'err');
      $fTitle.focus();
      return;
    }
    const payload = {
      module: MODULE,
      title,
      description: $fDesc.value.trim(),
      custom_prompt: $fPrompt.value.trim(),
      materials,
      order_index: Date.now()
    };

    $btnSave.disabled = true;
    $btnSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';

    try {
      if (editingId) {
        await updateChapter(editingId, payload);
        toast('Chapter updated', 'ok');
      } else {
        await createChapter(payload);
        toast('Chapter created', 'ok');
      }
      closeEditor();
      reload();
    } catch (err) {
      toast('Save failed: ' + err.message, 'err');
    } finally {
      $btnSave.disabled = false;
      $btnSave.innerHTML = '<i class="fas fa-check"></i> Save';
    }
  }

  /* ──────────────────────────────────────────────────────────
     Bind events (Teacher only)
     ────────────────────────────────────────────────────────── */
  if (MODE === 'teacher') {
    $btnNew.addEventListener('click', () => openEditor(null));
    $modalClose.addEventListener('click', closeEditor);
    $btnCancel.addEventListener('click', closeEditor);
    $form.addEventListener('submit', saveChapter);

    // dropzone
    $dropzone.addEventListener('click', () => $fileInput.click());
    $dropzone.addEventListener('dragover', e => {
      e.preventDefault();
      $dropzone.classList.add('dragover');
    });
    $dropzone.addEventListener('dragleave', () => $dropzone.classList.remove('dragover'));
    $dropzone.addEventListener('drop', e => {
      e.preventDefault();
      $dropzone.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });
    $fileInput.addEventListener('change', e => {
      handleFiles(e.target.files);
      e.target.value = '';
    });

    // close modal on background click
    $modal.addEventListener('click', e => {
      if (e.target === $modal) closeEditor();
    });
  }

  /* ──────────────────────────────────────────────────────────
     Boot
     ────────────────────────────────────────────────────────── */
  if ($pageTitle) {
    $pageTitle.textContent = (MODE === 'teacher'
      ? 'Manage ' + MODULE_LABEL + ' Chapters'
      : MODULE_LABEL + ' Chapters');
  }

  reload();
})();
