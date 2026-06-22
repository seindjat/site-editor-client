/* ============================================================
   site-editor — owner editor (loaded on demand for the owner only).
   Reusable engine: everything site-specific comes from window.EDITOR_CONFIG
   (see examples/EDITOR_CONFIG.example.js). Relies on bootstrap globals from
   bootstrap.js: getEditKey(). Defines and runs the editor.

   NOTE: editor.js is ASSEMBLED from the focused source files in client/editor/*.js
   by deploy/build-editor.sh (publish-editor.sh runs it automatically). Edit the
   piece you need under client/editor/ — do NOT hand-edit the built editor.js.
   ============================================================ */
(function () {
  if (window.__ecBuilt) return;
  window.__ecBuilt = true;

  /* ---- per-site configuration (with safe fallbacks) ----
     Anything a site needs to customize lives here; the rest of the engine is generic. */
  const CFG = (function () {
    const u = window.EDITOR_CONFIG || {};
    const heroRatio = u.heroRatio || (3.4 / 4);
    return {
      apiBase: (u.apiBase || API + '').replace(/\/*$/, '/'),
      storePrefix: u.storePrefix || 'metisKitchen',
      editSel: u.editSel || 'h1, h2, h3, h4, p, li, figcaption, blockquote, summary',
      pages: u.pages || [{ file: 'index.html', label: 'Home' }, { file: 'privacy.html', label: 'Privacy' }],
      devices: u.devices || {
        desktop: { w: 1280, label: 'Desktop' }, ipad: { w: 768, label: 'iPad' },
        phoneL: { w: 844, label: 'Phone ↔' }, phoneP: { w: 390, label: 'Phone ↕' },
      },
      linkSkip: u.linkSkip || '.chat-panel, .chat-teaser, .sticky-cta',
      imageSlots: u.imageSlots || {
        'hero-kitchen.webp': { w: 1600, h: 1360, fmt: 'webp', label: 'hero photo 1', ratio: heroRatio },
        'hero-2.webp': { w: 1600, h: 1360, fmt: 'webp', label: 'hero photo 2', ratio: heroRatio },
        'hero-3.webp': { w: 1600, h: 1360, fmt: 'webp', label: 'hero photo 3', ratio: heroRatio },
        'hero-4.webp': { w: 1600, h: 1360, fmt: 'webp', label: 'hero photo 4', ratio: heroRatio },
        'before-1.webp': { w: 1000, h: 750, fmt: 'webp', label: 'before photo 1' },
        'after-1.webp': { w: 1000, h: 750, fmt: 'webp', label: 'after photo 1' },
        'before-2.webp': { w: 1000, h: 750, fmt: 'webp', label: 'before photo 2' },
        'after-2.webp': { w: 1000, h: 750, fmt: 'webp', label: 'after photo 2' },
        'before-3.webp': { w: 1000, h: 750, fmt: 'webp', label: 'before photo 3' },
        'after-3.webp': { w: 1000, h: 750, fmt: 'webp', label: 'after photo 3' },
      },
      heroSlots: u.heroSlots || ['hero-kitchen.webp', 'hero-2.webp', 'hero-3.webp', 'hero-4.webp'],
      brandName: u.brandName || 'your site',
      welcome: u.welcome || null,
      editorBase: u.editorBase || '',         /* path prefix for editor.css/.js (e.g. '/__editor/') */
      editorV: u.editorV || (window.EDITOR_V || 1),  /* cache-bust version */
      /* per-device style edits snap to these max-width breakpoints (align to the site's
         own CSS breakpoints). Devices map: desktop→base, ipad/phoneL→tablet, phoneP→phone. */
      breakpoints: u.breakpoints || { tablet: 1024, phone: 600 },
    };
  })();
  const API = CFG.apiBase;
  const EDIT_SEL = CFG.editSel;
  const EDIT_ACTIVE = CFG.storePrefix + 'EditActive';
  const AI_MODEL_KEY = CFG.storePrefix + 'AiModel';
  /* curated models for the picker; the owner can also paste ANY OpenRouter id.
     Bare id (claude-opus-4-8) = Anthropic direct; "vendor/model" = via OpenRouter. */
  const AI_MODELS = (window.EDITOR_CONFIG && window.EDITOR_CONFIG.aiModels) || [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most reliable (default)' },
    { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku — cheaper (OpenRouter)' },
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini — cheap (OpenRouter)' },
    { id: 'google/gemini-flash-1.5', label: 'Gemini 1.5 Flash — very cheap (OpenRouter)' },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat — very cheap (OpenRouter)' },
  ];
  function getAiModel() { try { return localStorage.getItem(AI_MODEL_KEY) || 'claude-opus-4-8'; } catch { return 'claude-opus-4-8'; } }
  function aiModelLabel(id) { const m = AI_MODELS.find((x) => x.id === id); return m ? m.label.split(' — ')[0] : id; }

  const key = getEditKey();
  const dirty = new Map();      // EDIT_SEL index -> innerHTML
  const linkEdits = new Map();  // editable-link index -> {href, text|null}
  const comments = new Map();   // section index -> {section, device, text}
  let linkMode = false;
  let imgMode = false;
  let secMode = false;
  let sectionsDirty = false;
  let styleMode = false;
  let styleDirty = false;
  /* per-device style overrides: cssPath selector -> { base:{}, tablet:{}, phone:{} } of
     prop->value. Persisted as one <style id="ec-style-overrides"> block in the page head,
     so a change made in (say) the phone view only applies at the phone breakpoint. */
  const styleEdits = new Map();
  let curStyleEl = null;
  /* CSS properties the style panel manages — only these are persisted, so we never
     bake in JS-computed inline styles (e.g. calculator bar widths). */
  const STYLE_PROPS = ['color', 'font-size', 'background-color', 'padding', 'text-align', 'font-weight'];
  let currentDevice = 'desktop';
  let currentPage = 'index.html';
  let frameDoc = null;
  let previewing = false;       // true while showing an un-published AI preview
  let pendingFiles = null;
  let refining = false;         // true while a conversational-refine preview is showing
  let refineDirty = false;      // a refine turn has applied a change (enables Publish)

  const DEVICES = CFG.devices;
  const PAGES = CFG.pages;

  /* Anchors the owner may retarget — every <a> EXCEPT those inside dynamic chrome
     (chat/sticky) whose contents are built by JS, so they'd misalign the index
     between the live iframe and a fresh parse. (CFG.linkSkip, per site.) */
  const LINK_SKIP = CFG.linkSkip;
  function editableLinks(doc) {
    return [...doc.querySelectorAll('a')].filter((a) => !a.closest(LINK_SKIP));
  }

  /* Photos the owner may replace (CFG.imageSlots). Each is cropped to its slot
     aspect and re-encoded as WebP server-side. w/h are the export dimensions;
     ratio (optional) pins the crop shape. */
  const IMAGE_SLOTS = CFG.imageSlots;
  /* the rotating hero slides — replaced via a single modal with a photo picker strip */
  const HERO_SLOTS = CFG.heroSlots;
  /* The device iframe reloads the same URL after every save/undo; without a
     cache-buster the browser can serve a stale copy and the owner thinks their
     change didn't take. A fresh timestamp each (re)load guarantees fresh content. */
  function frameSrc(page) { return page + '?editframe=1&_=' + Date.now(); }

  function imgSlot(img) {
    const m = (img.getAttribute('src') || '').match(/assets\/([^?#"]+)/);
    return m && IMAGE_SLOTS[m[1]] ? m[1] : null;
  }
  function editableImages(doc) {
    return [...doc.querySelectorAll('img')].filter(imgSlot);
  }

  /* Whole page sections the owner can hide/show + reorder (direct <body> children
     only — never the fixed header/footer). */
  function movableSections(doc) {
    return [...doc.querySelectorAll('body > section')];
  }

  document.body.classList.add('ec-open');
  const shell = document.createElement('div');
  shell.className = 'ec-shell';
  shell.innerHTML =
    '<div class="ec-toolbar">' +
      /* ── Row 1: page + device pickers (left), primary actions (right corner) ── */
      '<div class="ec-toolbar-row ec-row-main">' +
        '<div class="ec-pages">' +
          PAGES.map((p) =>
            `<button type="button" data-page="${p.file}" class="ec-page${p.file === 'index.html' ? ' is-active' : ''}">${p.label}</button>`).join('') +
        '</div>' +
        '<div class="ec-devices">' +
          Object.entries(DEVICES).map(([k, d]) =>
            `<button type="button" data-dev="${k}" class="ec-dev${k === 'desktop' ? ' is-active' : ''}">${d.label}</button>`).join('') +
        '</div>' +
        '<span class="ec-dim"></span>' +
        '<div class="ec-row-right">' +
          '<button type="button" class="ec-btn ec-undo" id="ecUndo" title="Undo the last change">↩ Undo</button>' +
          '<button type="button" class="ec-btn ec-history" id="ecHistory" title="Change history & restore points">🕘 History</button>' +
          '<button type="button" class="ec-btn ec-save" id="ecSave">💾 Save changes</button>' +
          '<button type="button" class="ec-btn ec-exit" id="ecExit">Exit</button>' +
        '</div>' +
      '</div>' +
      /* ── Row 2: everything else — title, AI, notes, history, status ── */
      '<div class="ec-toolbar-row ec-row-tools">' +
        '<strong class="ec-title">✏️ Editing</strong>' +
        '<button type="button" class="ec-help" id="ecHelp" title="How to use the editor" aria-label="Help">?</button>' +
        '<span class="ec-sep"></span>' +
        '<button type="button" class="ec-cmt-toggle ec-refine-toggle ec-ai-primary" id="ecRefine" title="Chat with the AI to change the page — &quot;make it bigger&quot;, &quot;now more orange&quot;…">🪄 Refine with AI</button>' +
        '<button type="button" class="ec-help ec-ai-gear" id="ecAiSettings" title="AI model settings" aria-label="AI model settings">⚙</button>' +
        '<button type="button" class="ec-btn ec-mini ec-seo" id="ecSeo" title="Edit the page title, Google search description, and social-share preview text">🔎 SEO</button>' +
        /* Notes group — appears only once the owner has added a note (via a section).
           "Add note" now lives in the section click-menu, not as a toolbar toggle. */
        '<span class="ec-notes-grp" id="ecNotesGroup" style="display:none">' +
          '<span class="ec-sep"></span>' +
          '<span class="ec-grp-label ec-muted">Notes</span>' +
          '<button type="button" class="ec-btn ec-impl ec-mini" id="ecImpl" title="Send your notes to the AI to apply them all at once">🤖 Apply notes</button>' +
          '<span class="ec-cost" id="ecCost"></span>' +
        '</span>' +
        '<span class="ec-status"></span>' +
        /* legacy mode buttons — kept in the DOM (hidden) so their code still resolves */
        '<span class="ec-grp-label ec-legacy">Edit</span>' +
        '<button type="button" class="ec-cmt-toggle ec-link-toggle ec-legacy" id="ecLink" title="Edit where links, the phone number, and buttons point">🔗 Links</button>' +
        '<button type="button" class="ec-cmt-toggle ec-img-toggle ec-legacy" id="ecImg" title="Replace a photo on the page">🖼️ Photos</button>' +
        '<button type="button" class="ec-cmt-toggle ec-style-toggle ec-legacy" id="ecStyle" title="Click any element to change its color, size and spacing">🎨 Style</button>' +
        '<button type="button" class="ec-cmt-toggle ec-sec-toggle ec-legacy" id="ecSec" title="Hide / show and reorder whole sections">📑 Sections</button>' +
      '</div>' +
    '</div>' +
    '<div class="ec-stage"><iframe class="ec-frame-el" id="ecFrame"></iframe></div>';
  document.body.appendChild(shell);

  const stage = shell.querySelector('.ec-stage');
  const frame = shell.querySelector('#ecFrame');
  const dim = shell.querySelector('.ec-dim');
  const status = shell.querySelector('.ec-status');
  const ecSave = shell.querySelector('#ecSave');
  const ecRefine = shell.querySelector('#ecRefine');
  const ecNotesGroup = shell.querySelector('#ecNotesGroup');
  const ecLink = shell.querySelector('#ecLink');
  const ecImg = shell.querySelector('#ecImg');
  const ecStyle = shell.querySelector('#ecStyle');
  const ecSec = shell.querySelector('#ecSec');
  const ecImpl = shell.querySelector('#ecImpl');
  const ecCost = shell.querySelector('#ecCost');

  let serverNotes = 0;          // notes already saved on the server (from any session)
  let baseUsd = 0, perNoteUsd = 0, costUnknown = false;
  function updateCost() {
    const notes = serverNotes + comments.size;
    if (!notes) { ecCost.textContent = ''; return; }
    if (costUnknown) {
      ecCost.textContent = '≈ varies';
      ecCost.title = 'Cost depends on the selected model (' + aiModelLabel(getAiModel()) + ') — exact cost shows after the run';
      return;
    }
    const total = baseUsd + perNoteUsd * notes;
    ecCost.textContent = '≈ $' + total.toFixed(2);
    ecCost.title = 'Estimated AI cost to apply these ' + notes + ' note' + (notes !== 1 ? 's' : '') + ' with ' + aiModelLabel(getAiModel());
  }
  /* (re)fetch the cost estimate for the CURRENTLY-selected model (Claude or OpenRouter) */
  function refreshCostEstimate() {
    fetch(API + 'cost-estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: key, model: getAiModel() }),
    }).then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) { costUnknown = !!d.unknown; baseUsd = d.baseUsd || 0; perNoteUsd = d.perNoteUsd || 0; updateCost(); } })
      .catch(() => {});
  }
  function refreshImplState() {
    const total = serverNotes + comments.size;
    /* the whole Notes group is hidden until there's at least one note (home page only) */
    ecNotesGroup.style.display = (total > 0 && currentPage === 'index.html') ? '' : 'none';
    ecImpl.disabled = total === 0 || previewing || currentPage !== 'index.html';
    ecImpl.title = 'Send your notes to the AI to apply them all at once';
    updateCost();
  }
  function updateStatus() {
    const bits = [`${dirty.size} edit${dirty.size !== 1 ? 's' : ''}`];
    if (linkEdits.size) bits.push(`${linkEdits.size} link${linkEdits.size !== 1 ? 's' : ''}`);
    if (styleDirty) bits.push(`${styleEdits.size} styled`);
    if (sectionsDirty) bits.push('layout changed');
    bits.push(`${comments.size} note${comments.size !== 1 ? 's' : ''}`);
    status.textContent = bits.join(' · ');
    /* Save is only active when there's a NEW change this session (styleDirty, not the
       count of loaded-from-save overrides) */
    ecSave.disabled = !(dirty.size || linkEdits.size || styleDirty || sectionsDirty || comments.size) || previewing;
    refreshImplState();
  }
  /* The AI implement + comment-note flow is home-page-only for now (its prompt is
     index-specific). On other pages, only direct text/link editing is offered. */
  function applyPageScope() {
    const home = currentPage === 'index.html';
    ecRefine.style.display = home ? '' : 'none';
    const seo = shell.querySelector('#ecSeo'); if (seo) seo.style.display = home ? '' : 'none';
    refreshImplState();   /* shows/hides the Notes group by note-count + page */
  }
  ecSave.disabled = true;   /* nothing to save until the owner makes a change */
  refreshImplState(); /* start disabled until we know the note count */
  fetch(API + 'note-count', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: key }),
  }).then((r) => r.ok ? r.json() : { count: 0 })
    .then((d) => { serverNotes = d.count || 0; refreshImplState(); })
    .catch(() => {});
  refreshCostEstimate();

  function applyDevice(k) {
    currentDevice = k;
    frame.style.width = DEVICES[k].w + 'px';
    frame.style.height = (stage.clientHeight - 40) + 'px';
    shell.querySelectorAll('.ec-dev').forEach((b) => b.classList.toggle('is-active', b.dataset.dev === k));
    dim.textContent = DEVICES[k].w + ' px wide';
    if (refining) updateRefineScope();   /* keep the Refine scope label in step with the view */
  }
  shell.querySelectorAll('.ec-dev').forEach((b) => b.addEventListener('click', () => applyDevice(b.dataset.dev)));
  window.addEventListener('resize', () => applyDevice(currentDevice));

  /* ---------- Page switcher (Home / Privacy) ---------- */
  function switchPage(file) {
    if (file === currentPage || previewing) return;
    if (refining && !closeRefine(true)) return;
    if ((dirty.size || linkEdits.size || comments.size || sectionsDirty || styleDirty) &&
        !confirm('You have unsaved changes on this page. Discard them and switch pages?')) return;
    dirty.clear(); linkEdits.clear(); comments.clear(); sectionsDirty = false;
    styleEdits.clear(); styleDirty = false;
    if (linkMode) setLinkMode(false);
    if (imgMode) setImgMode(false);
    if (secMode) setSecMode(false);
    if (styleMode) setStyleMode(false);
    currentPage = file;
    try { sessionStorage.setItem('ecPage', file); } catch { /* ignore */ }
    shell.querySelectorAll('.ec-page').forEach((b) => b.classList.toggle('is-active', b.dataset.page === file));
    applyPageScope();
    frameDoc = null;
    frame.removeAttribute('srcdoc');
    frame.src = frameSrc(currentPage);
    updateStatus();
  }
  shell.querySelectorAll('.ec-page').forEach((b) => b.addEventListener('click', () => switchPage(b.dataset.page)));
  /* resume on the page the owner was last editing (survives the post-save reload) */
  const resumePage = sessionStorage.getItem('ecPage');
  if (resumePage && PAGES.some((p) => p.file === resumePage) && resumePage !== currentPage) {
    currentPage = resumePage;
    shell.querySelectorAll('.ec-page').forEach((b) => b.classList.toggle('is-active', b.dataset.page === currentPage));
  }
  applyPageScope();
  frame.src = frameSrc(currentPage);   /* initial load (cache-busted) */

  /* The device iframe loads each page with ?editframe=1. index.html self-injects
     the editor CSS (via script.js); privacy.html has no script.js, so the parent
     ensures the chrome class + editor stylesheet itself. */
  function ensureFrameChrome(doc) {
    try {
      doc.documentElement.classList.add('ec-frame');
      if (!doc.getElementById('ec-css')) {
        const l = doc.createElement('link');
        l.id = 'ec-css'; l.rel = 'stylesheet';
        l.href = CFG.editorBase + 'editor.css?v=' + CFG.editorV;
        doc.head.appendChild(l);
      }
    } catch { /* cross-origin shouldn't happen (same origin) */ }
  }

  function getSections() { return [...frameDoc.querySelectorAll('section, header.nav, footer.footer')]; }
  function sectionLabel(sec) {
    if (sec.id) return sec.id;
    const h = sec.querySelector('h1, h2');
    if (h) return h.textContent.trim().slice(0, 60);
    const eb = sec.querySelector('.eyebrow, .truststrip-label');
    if (eb) return eb.textContent.trim().slice(0, 60);
    return sec.tagName.toLowerCase();
  }
  /* make a panel draggable by a handle element (used for the note window so the
     owner can pull it aside and see the section behind it) */
  function makeDraggable(panel, handle) {
    let tx = 0, ty = 0, sx = 0, sy = 0, startX = 0, startY = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, textarea, input, a')) return;
      dragging = true; sx = e.clientX; sy = e.clientY; startX = tx; startY = ty;
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      tx = startX + e.clientX - sx; ty = startY + e.clientY - sy;
      panel.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
      /* clamp so the draggable HEADER always stays reachable: keep the top edge on-screen
         and at least ~120px of the window horizontally visible */
      const r = panel.getBoundingClientRect(), edge = 120;
      if (r.top < 8) ty += 8 - r.top;
      else if (r.top > window.innerHeight - 40) ty += (window.innerHeight - 40) - r.top;
      if (r.right < edge) tx += edge - r.right;
      else if (r.left > window.innerWidth - edge) tx += (window.innerWidth - edge) - r.left;
      panel.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  function openNoteModal(label, dev, initial, cb) {
    const ov = document.createElement('div');
    ov.className = 'ec-modal-ov ec-modal-ov-note';   /* see-through backdrop + draggable */
    ov.innerHTML =
      '<div class="ec-modal">' +
        '<h3 title="Drag to move this window">⠿ Note for the “' + label + '” section</h3>' +
        '<p class="ec-modal-sub">' + dev + ' · describe the visual/design change for the AI</p>' +
        '<textarea class="ec-modal-ta" rows="7" placeholder="e.g. Make this headline smaller and the call button bigger on phones; add more space above the photo."></textarea>' +
        '<div class="ec-modal-row">' +
          (initial ? '<button type="button" class="ec-modal-del" id="ecmDel">Remove note</button>' : '<span></span>') +
          '<div><button type="button" class="ec-modal-cancel" id="ecmCancel">Cancel</button>' +
          '<button type="button" class="ec-modal-save" id="ecmSave">Save note</button></div>' +
        '</div>' +
        '<p class="ec-modal-hint">Tip: ⌘/Ctrl + Enter to save · Esc to cancel</p>' +
      '</div>';
    document.body.appendChild(ov);
    const ta = ov.querySelector('.ec-modal-ta');
    ta.value = initial || '';
    const done = (val) => { ov.remove(); cb(val); };
    ov.querySelector('#ecmSave').addEventListener('click', () => done(ta.value));
    ov.querySelector('#ecmCancel').addEventListener('click', () => done(null));
    const del = ov.querySelector('#ecmDel');
    if (del) del.addEventListener('click', () => done(''));
    /* note window has a see-through backdrop & is draggable — no click-outside-to-cancel
       (a stray click on the visible page shouldn't discard a half-written note) */
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') done(ta.value);
      else if (e.key === 'Escape') done(null);
    });
    makeDraggable(ov.querySelector('.ec-modal'), ov.querySelector('h3'));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
  }

  /* notes are keyed by the section ELEMENT (not a positional index) so reordering
     sections can't move a note onto the wrong one. */
  function openComment(sec) {
    const cur = comments.get(sec);
    const dev = currentDevice !== 'desktop' ? DEVICES[currentDevice].label + ' view' : 'Desktop view';
    openNoteModal(sectionLabel(sec), dev, cur ? cur.text : '', (val) => {
      if (val === null) return;
      if (!val.trim()) comments.delete(sec);
      else comments.set(sec, { section: sectionLabel(sec), device: DEVICES[currentDevice].label, text: val.trim() });
      refreshNoteMarks();
      updateStatus();   /* also refreshes the Notes group + cost */
    });
  }
  /* highlight sections that have a pending note (replaces the old comment-mode anchors) */
  function refreshNoteMarks() {
    if (!frameDoc) return;
    getSections().forEach((sec) => sec.classList.toggle('ec-has-note', comments.has(sec)));
  }

  /* ---------- Link / phone / button destination editing ---------- */
  function setTextEditable(on) {
    if (!frameDoc) return;
    frameDoc.querySelectorAll('.ec-editable').forEach((el) => el.setAttribute('contenteditable', on ? 'true' : 'false'));
  }
  function highlightLinks(on) {
    if (!frameDoc) return;
    editableLinks(frameDoc).forEach((a) => a.classList.toggle('ec-link-hl', on));
  }
  function setLinkMode(on) {
    if (on && refining && !closeRefine()) return;
    if (on && imgMode) setImgMode(false);
    if (on && secMode) setSecMode(false);
    if (on && styleMode) setStyleMode(false);
    linkMode = on;
    ecLink.classList.toggle('is-active', on);
    ecLink.textContent = on ? '🔗 Links: ON' : '🔗 Links';
    /* while picking links, freeze text editing so clicks open the link modal
       instead of dropping a text caret */
    setTextEditable(!on);
    highlightLinks(on);
  }
  ecLink.addEventListener('click', () => { if (previewing) return; setLinkMode(!linkMode); });

  /* classify a destination so the modal can show the right helper field */
  function linkKind(href) {
    if (/^tel:/i.test(href)) return 'phone';
    if (/^mailto:/i.test(href)) return 'email';
    if (href.startsWith('#')) return 'section';
    return 'url';
  }
  function sectionOptions(selected) {
    const ids = [...frameDoc.querySelectorAll('[id]')].map((e) => e.id).filter(Boolean);
    return ids.map((id) =>
      `<option value="#${id}"${('#' + id) === selected ? ' selected' : ''}>#${id}</option>`).join('');
  }
  function openLinkModal(a) {
    const idx = editableLinks(frameDoc).indexOf(a);
    if (idx < 0) return;
    const curHref = a.getAttribute('href') || '';
    const plain = a.children.length === 0;       // only retitle pure-text links
    const curText = plain ? a.textContent.trim() : '';
    const kind = linkKind(curHref);
    const label = (a.textContent.trim() || curHref || 'link').slice(0, 50);

    const ov = document.createElement('div');
    ov.className = 'ec-modal-ov';
    ov.innerHTML =
      '<div class="ec-modal">' +
        '<h3>Edit link: “' + escapeHtml(label) + '”</h3>' +
        '<p class="ec-modal-sub">Choose what happens when this is clicked.</p>' +
        '<div class="ec-link-types">' +
          ['url', 'section', 'phone', 'email'].map((k) =>
            `<button type="button" class="ec-lt" data-kind="${k}"${k === kind ? ' aria-pressed="true"' : ''}>` +
            ({ url: '🔗 Web / page', section: '⤓ Page section', phone: '📞 Phone', email: '✉️ Email' }[k]) +
            '</button>').join('') +
        '</div>' +
        '<div class="ec-link-field" id="ecLfWrap"></div>' +
        (plain
          ? '<label class="ec-field-label">Link text<input type="text" class="ec-link-input" id="ecLinkText"></label>'
          : '<p class="ec-modal-hint" style="text-align:left">This link wraps an image/icon, so its text isn’t edited here.</p>') +
        '<div class="ec-modal-row">' +
          '<span></span>' +
          '<div><button type="button" class="ec-modal-cancel" id="ecmCancel">Cancel</button>' +
          '<button type="button" class="ec-modal-save" id="ecmSave">Apply</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const wrap = ov.querySelector('#ecLfWrap');
    const textInput = ov.querySelector('#ecLinkText');
    if (textInput) textInput.value = curText;
    let kindNow = kind;

    function renderField() {
      if (kindNow === 'section') {
        wrap.innerHTML = '<label class="ec-field-label">Jump to section' +
          '<select class="ec-link-input" id="ecLfVal">' + sectionOptions(curHref) + '</select></label>';
      } else if (kindNow === 'phone') {
        const num = curHref.replace(/^tel:/i, '');
        wrap.innerHTML = '<label class="ec-field-label">Phone number (e.g. +1 510 681 0855)' +
          '<input type="text" class="ec-link-input" id="ecLfVal" placeholder="+15106810855"></label>';
        wrap.querySelector('#ecLfVal').value = num;
      } else if (kindNow === 'email') {
        const em = curHref.replace(/^mailto:/i, '');
        wrap.innerHTML = '<label class="ec-field-label">Email address' +
          '<input type="text" class="ec-link-input" id="ecLfVal" placeholder="name@example.com"></label>';
        wrap.querySelector('#ecLfVal').value = em;
      } else {
        wrap.innerHTML = '<label class="ec-field-label">Address (https://… or a page like privacy.html)' +
          '<input type="text" class="ec-link-input" id="ecLfVal" placeholder="https://"></label>' +
          '<div class="ec-link-quick">' +
            '<button type="button" data-q="index.html">🏠 Home page</button>' +
            '<button type="button" data-q="privacy.html">📄 Privacy page</button>' +
          '</div>';
        wrap.querySelector('#ecLfVal').value = /^(tel:|mailto:|#)/i.test(curHref) ? '' : curHref;
        wrap.querySelectorAll('.ec-link-quick button').forEach((b) =>
          b.addEventListener('click', () => { wrap.querySelector('#ecLfVal').value = b.dataset.q; }));
      }
    }
    renderField();
    ov.querySelectorAll('.ec-lt').forEach((b) => b.addEventListener('click', () => {
      kindNow = b.dataset.kind;
      ov.querySelectorAll('.ec-lt').forEach((x) => x.removeAttribute('aria-pressed'));
      b.setAttribute('aria-pressed', 'true');
      renderField();
    }));

    function buildHref() {
      const raw = (ov.querySelector('#ecLfVal')?.value || '').trim();
      if (!raw) return null;
      if (kindNow === 'phone') return 'tel:' + raw.replace(/[^\d+]/g, '');
      if (kindNow === 'email') return 'mailto:' + raw;
      if (kindNow === 'section') return raw.startsWith('#') ? raw : '#' + raw;
      return raw;
    }
    const close = () => ov.remove();
    ov.querySelector('#ecmCancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelector('#ecmSave').addEventListener('click', () => {
      const href = buildHref();
      if (!href) { alert('Please enter a destination.'); return; }
      a.setAttribute('href', href);
      let newText = null;
      if (textInput) {
        const t = textInput.value.trim();
        if (t && t !== curText) { a.textContent = t; newText = t; }
      }
      linkEdits.set(idx, { href, text: newText });
      a.classList.add('ec-link-hl', 'ec-link-changed');
      updateStatus();
      close();
    });
  }

  /* ---------- Image replace + crop ---------- */
  function highlightImages(on) {
    if (!frameDoc) return;
    editableImages(frameDoc).forEach((img) => img.classList.toggle('ec-img-hl', on));
  }
  function setImgMode(on) {
    if (on && refining && !closeRefine()) return;
    if (on && linkMode) setLinkMode(false);
    if (on && secMode) setSecMode(false);
    if (on && styleMode) setStyleMode(false);
    imgMode = on;
    ecImg.classList.toggle('is-active', on);
    ecImg.textContent = on ? '🖼️ Photos: ON' : '🖼️ Photos';
    setTextEditable(!on);   /* clicks select photos, not text, while in image mode */
    if (frameDoc) frameDoc.documentElement.classList.toggle('ec-img-on', on);  /* un-stacks the hero grid only here */
    highlightImages(on);
  }
  ecImg.addEventListener('click', () => { if (previewing) return; setImgMode(!imgMode); });

  function openImageModal(img, slotFile, slotGroup) {
    let curSlot = slotFile;                 /* which photo we'll replace (changeable via the strip) */
    const slot = IMAGE_SLOTS[slotFile];
    /* a selectable thumbnail strip when this photo is one of a set (the rotating hero) —
       so picking which photo + choosing a file + cropping all happen in ONE window */
    const hasStrip = Array.isArray(slotGroup) && slotGroup.length > 1;
    const liveImgs = editableImages(frameDoc);
    const srcFor = (sl) => { const im = liveImgs.find((i) => imgSlot(i) === sl); return (im && im.getAttribute('src')) || ('assets/' + sl); };
    const stripHtml = hasStrip
      ? '<div class="ec-hero-strip" id="ecHeroStrip">' +
          slotGroup.map((sl, i) =>
            `<button type="button" class="ec-hs${sl === curSlot ? ' is-sel' : ''}" data-slot="${sl}" title="Photo ${i + 1}">` +
              `<img class="ec-hs-thumb" src="${srcFor(sl)}" alt="Photo ${i + 1}" draggable="false">` +
              `<span class="ec-hs-num">${i + 1}</span>` +
            '</button>').join('') +
        '</div>'
      : '';
    /* Crop to the photo's ACTUAL on-page proportions (it's object-fit:cover'd into
       a fixed-aspect box), so the frame is WYSIWYG and the page won't re-crop it. */
    const rect = img.getBoundingClientRect();
    /* slot.ratio pins the crop shape (e.g. the rotating hero, which is un-stacked into
       a grid while editing so its measured box wouldn't match the live shape). */
    const dispRatio = slot.ratio || ((rect.width > 4 && rect.height > 4) ? (rect.height / rect.width) : (slot.h / slot.w));
    const VPW = 460, VPH = Math.round(VPW * dispRatio);
    const EXPORT_W = Math.min(1600, slot.w);
    const EXPORT_H = Math.round(EXPORT_W * dispRatio);
    const ov = document.createElement('div');
    ov.className = 'ec-modal-ov';
    ov.innerHTML =
      '<div class="ec-modal ec-img-modal">' +
        '<h3 id="ecImgTitle">' + (hasStrip ? 'Replace a hero photo' : 'Replace the ' + slot.label) + '</h3>' +
        '<p class="ec-modal-sub">' + (hasStrip
          ? 'Pick which photo to replace, choose a new one, then drag to position &amp; zoom.'
          : 'Pick a photo, then drag to position and zoom. It’s cropped to fit this spot and optimized automatically — the live photo updates right away.') + '</p>' +
        stripHtml +
        '<div class="ec-crop-pick"><label class="ec-crop-file">📁 Choose a photo…<input type="file" accept="image/*" id="ecCropFile" hidden></label></div>' +
        '<div class="ec-crop-stage" id="ecCropStage" style="display:none">' +
          '<div class="ec-crop-vp" id="ecCropVp" style="width:' + VPW + 'px;height:' + VPH + 'px"></div>' +
          '<div class="ec-crop-zoom"><span>Zoom</span><input type="range" id="ecCropZoom" min="100" max="300" value="100"></div>' +
        '</div>' +
        '<div class="ec-modal-row"><span class="ec-crop-msg" id="ecCropMsg"></span>' +
          '<div><button type="button" class="ec-modal-cancel" id="ecmCancel">Cancel</button>' +
          '<button type="button" class="ec-modal-save" id="ecmUse" disabled>Use photo</button></div></div>' +
      '</div>';
    document.body.appendChild(ov);
    const fileIn = ov.querySelector('#ecCropFile');
    const stage = ov.querySelector('#ecCropStage');
    const vp = ov.querySelector('#ecCropVp');
    const zoom = ov.querySelector('#ecCropZoom');
    const useBtn = ov.querySelector('#ecmUse');
    const msg = ov.querySelector('#ecCropMsg');
    let imgEl = null, nw = 0, nh = 0, baseScale = 1, offx = 0, offy = 0, objUrl = null;
    const close = () => { if (objUrl) URL.revokeObjectURL(objUrl); ov.remove(); };
    ov.querySelector('#ecmCancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    /* photo-picker strip: switch which photo we're replacing without leaving the modal */
    if (hasStrip) {
      ov.querySelectorAll('.ec-hs').forEach((b) => b.addEventListener('click', () => {
        curSlot = b.dataset.slot;
        ov.querySelectorAll('.ec-hs').forEach((x) => x.classList.toggle('is-sel', x === b));
        ov.querySelector('#ecImgTitle').textContent = 'Replace the ' + IMAGE_SLOTS[curSlot].label;
        /* reset any in-progress crop so it applies to the newly-picked photo */
        if (imgEl || fileIn.value) {
          if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
          imgEl = null; vp.innerHTML = ''; stage.style.display = 'none';
          useBtn.disabled = true; fileIn.value = ''; msg.textContent = '';
        }
      }));
    }

    function place() {
      const s = baseScale * (zoom.value / 100);
      const dw = nw * s, dh = nh * s;
      offx = Math.min(0, Math.max(VPW - dw, offx));
      offy = Math.min(0, Math.max(VPH - dh, offy));
      if (imgEl) { imgEl.style.width = dw + 'px'; imgEl.style.height = dh + 'px'; imgEl.style.left = offx + 'px'; imgEl.style.top = offy + 'px'; }
    }
    fileIn.addEventListener('change', () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return;
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(f);
      const im = new Image();
      im.onload = () => {
        nw = im.naturalWidth; nh = im.naturalHeight;
        baseScale = Math.max(VPW / nw, VPH / nh);
        vp.innerHTML = ''; im.className = 'ec-crop-img'; im.draggable = false;
        vp.appendChild(im); imgEl = im; zoom.value = 100;
        offx = (VPW - nw * baseScale) / 2; offy = (VPH - nh * baseScale) / 2;
        place(); stage.style.display = ''; useBtn.disabled = false; msg.textContent = '';
      };
      im.onerror = () => { msg.textContent = 'Could not read that image.'; };
      im.src = objUrl;
    });
    zoom.addEventListener('input', place);
    let dragging = false, dsx = 0, dsy = 0, ox0 = 0, oy0 = 0;
    vp.addEventListener('pointerdown', (e) => { if (!imgEl) return; dragging = true; dsx = e.clientX; dsy = e.clientY; ox0 = offx; oy0 = offy; try { vp.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
    vp.addEventListener('pointermove', (e) => { if (!dragging) return; offx = ox0 + (e.clientX - dsx); offy = oy0 + (e.clientY - dsy); place(); });
    vp.addEventListener('pointerup', (e) => { dragging = false; try { vp.releasePointerCapture(e.pointerId); } catch { /* ignore */ } });

    useBtn.addEventListener('click', async () => {
      if (!imgEl) return;
      useBtn.disabled = true; useBtn.textContent = 'Working…'; msg.textContent = '';
      try {
        const s = baseScale * (zoom.value / 100);
        const canvas = document.createElement('canvas');
        canvas.width = EXPORT_W; canvas.height = EXPORT_H;
        canvas.getContext('2d').drawImage(imgEl, -offx / s, -offy / s, VPW / s, VPH / s, 0, 0, EXPORT_W, EXPORT_H);
        /* Export JPEG — every browser's canvas can encode it (Safari can't make
           WebP); the server re-encodes to WebP. Quality 0.9 keeps it small. */
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        const r = await fetch(API + 'upload-image', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: key, target: curSlot, dataUrl }),
        });
        const txt = await r.text();
        if (!r.ok) throw new Error(txt || r.status);
        const out = JSON.parse(txt);
        editableImages(frameDoc).forEach((im2) => { if (imgSlot(im2) === curSlot) { im2.setAttribute('src', out.src); if (out.alt) im2.setAttribute('alt', out.alt); } });
        /* alt-text step: the AI proposed a description — let the owner edit it */
        const modal = ov.querySelector('.ec-modal');
        const altv = (out.alt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        modal.innerHTML =
          '<h3>✓ Photo updated</h3>' +
          '<p class="ec-modal-sub">Describe the photo for SEO &amp; screen readers. The AI suggested this from the image — edit if you like.</p>' +
          '<textarea class="ec-link-input" id="ecAltTa" rows="2" maxlength="200" placeholder="e.g. Bright remodeled bathroom with a glass walk-in shower">' + altv + '</textarea>' +
          '<div class="ec-modal-row"><span class="ec-crop-msg" id="ecAltMsg"></span><div>' +
          '<button type="button" class="ec-modal-cancel" id="ecAltSkip">Done</button>' +
          '<button type="button" class="ec-modal-save" id="ecAltSave">Save description</button></div></div>';
        const altTa = modal.querySelector('#ecAltTa'), altMsg = modal.querySelector('#ecAltMsg');
        modal.querySelector('#ecAltSkip').addEventListener('click', close);
        modal.querySelector('#ecAltSave').addEventListener('click', async () => {
          const b = modal.querySelector('#ecAltSave'); b.disabled = true; b.textContent = 'Saving…';
          try {
            const rr = await fetch(API + 'set-alt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: key, target: curSlot, alt: altTa.value }) });
            if (!rr.ok) throw new Error(await rr.text() || rr.status);
            editableImages(frameDoc).forEach((im2) => { if (imgSlot(im2) === curSlot) im2.setAttribute('alt', altTa.value); });
            close();
          } catch (e) { altMsg.textContent = 'Could not save (' + e.message + ')'; b.disabled = false; b.textContent = 'Save description'; }
        });
        setTimeout(() => altTa.focus(), 30);
      } catch (err) {
        msg.textContent = 'Upload failed (' + err.message + ')';
        useBtn.disabled = false; useBtn.textContent = 'Use photo';
      }
    });
  }

  /* ---------- Click-to-style controls ---------- */
  function rgbToHex(rgb) {
    const m = String(rgb).match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return '#000000';
    return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  /* a stable selector for el, rooted at its nearest id-ancestor (or body), using
     nth-of-type so dynamically-injected siblings (chat teaser, etc.) can't shift it */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let node = el;
    const body = frameDoc.body;
    while (node && node.nodeType === 1 && node !== body) {
      if (node.id) { parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id)); break; }
      let n = 1, sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) n++; }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + n + ')');
      node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : null;
  }
  function elDesc(el) {
    const tag = el.tagName.toLowerCase();
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
    return txt ? tag + ' · "' + txt + (el.textContent.trim().length > 32 ? '…' : '') + '"' : tag + (el.className && typeof el.className === 'string' ? ' .' + el.className.split(' ')[0] : '');
  }

  let stylePanel = null;
  /* which breakpoint tier the current device view writes into */
  function deviceTier() {
    const w = (DEVICES[currentDevice] || {}).w || 1280;
    if (w >= CFG.breakpoints.tablet + 1) return 'base';   /* desktop */
    if (w >= CFG.breakpoints.phone + 1) return 'tablet';  /* iPad / landscape phone */
    return 'phone';                                       /* portrait phone */
  }
  function tierLabel(t) { return t === 'phone' ? 'phones' : t === 'tablet' ? 'tablets & down' : 'all devices'; }
  /* serialize all overrides to CSS: base rules, then tablet, then phone (so the
     narrower media query wins at small widths via source order + !important) */
  /* styleEdits is keyed by the live ELEMENT (not a selector string), and the selector
     is computed FRESH at build time — so reordering sections can't stale it. */
  function buildOverrideCss() {
    const decl = (props) => Object.keys(props).map((k) => k + ':' + props[k] + ' !important').join(';');
    const entries = [...styleEdits.entries()]
      .filter(([el]) => el && el.isConnected)          /* drop elements no longer on the page */
      .map(([el, rec]) => [cssPath(el), rec])
      .filter(([sel]) => sel);
    const ruleLines = (tier) => entries
      .filter(([, rec]) => Object.keys(rec[tier]).length)
      .map(([sel, rec]) => sel + '{' + decl(rec[tier]) + '}');
    let css = ruleLines('base').join('\n');
    const tab = ruleLines('tablet'); if (tab.length) css += '\n@media (max-width:' + CFG.breakpoints.tablet + 'px){\n' + tab.join('\n') + '\n}';
    const ph = ruleLines('phone'); if (ph.length) css += '\n@media (max-width:' + CFG.breakpoints.phone + 'px){\n' + ph.join('\n') + '\n}';
    return css.trim();
  }
  /* inject/update the live override <style> in the iframe so the preview is correct
     at the current device width */
  function renderStyleOverrides() {
    if (!frameDoc) return;
    let st = frameDoc.getElementById('ec-style-overrides');
    if (!st) { st = frameDoc.createElement('style'); st.id = 'ec-style-overrides'; frameDoc.head.appendChild(st); }
    st.textContent = buildOverrideCss();
  }
  /* read previously-saved overrides back into styleEdits (keyed by element), so a new
     session MERGES rather than wipes. Parses our own block's text (reliable regardless
     of CSSOM timing); resolves each saved selector to the live element. */
  function loadOverrides() {
    styleEdits.clear();
    const st = frameDoc && frameDoc.getElementById('ec-style-overrides');
    if (!st) return;
    const ingestRule = (sel, decls, tier) => {
      sel = sel.trim();
      if (!sel || sel.charAt(0) === '@') return;
      let el; try { el = frameDoc.querySelector(sel); } catch { el = null; }
      if (!el) return;
      let rec = styleEdits.get(el);
      if (!rec) { rec = { base: {}, tablet: {}, phone: {} }; styleEdits.set(el, rec); }
      decls.split(';').forEach((d) => {
        const i = d.indexOf(':'); if (i < 0) return;
        const prop = d.slice(0, i).trim();
        const val = d.slice(i + 1).replace(/!important/i, '').trim();
        if (prop && val) rec[tier][prop] = val;
      });
    };
    try {
      const text = st.textContent || '';
      let tier = 'base', body = '';
      text.split('\n').forEach((line) => {
        const t = line.trim();
        const med = t.match(/^@media[^(]*\(max-width:\s*(\d+)px\)/);
        if (med) { tier = Number(med[1]) <= CFG.breakpoints.phone ? 'phone' : 'tablet'; return; }
        if (t === '}') { tier = 'base'; return; }   /* close of a @media block */
        body += line + '\n';
        const m = t.match(/^([^{}]+)\{([^{}]*)\}\s*$/);
        if (m) ingestRule(m[1], m[2], tier);
      });
    } catch { /* parse issue — start fresh rather than crash */ }
  }
  function buildStylePanel() {
    if (stylePanel) return stylePanel;
    const p = document.createElement('div');
    p.className = 'ec-style-panel'; p.id = 'ecStylePanel'; p.hidden = true;
    p.innerHTML =
      '<div class="ec-sp-head"><span class="ec-sp-target" id="spTarget"></span>' +
        '<button type="button" class="ec-sp-close" id="spClose" aria-label="Close">✕</button></div>' +
      '<div class="ec-sp-scope" id="spScope"></div>' +
      '<label class="ec-sp-row"><span>Text color</span><input type="color" id="spColor"></label>' +
      '<label class="ec-sp-row"><span>Text size</span><input type="range" id="spSize" min="10" max="80"><b id="spSizeVal"></b></label>' +
      '<label class="ec-sp-row"><span>Background</span><input type="color" id="spBg"><button type="button" class="ec-sp-mini" id="spBgClear">clear</button></label>' +
      '<label class="ec-sp-row"><span>Spacing</span><input type="range" id="spPad" min="0" max="80"><b id="spPadVal"></b></label>' +
      '<div class="ec-sp-row"><span>Align</span><div class="ec-sp-seg" id="spAlign">' +
        '<button type="button" data-al="left">Left</button><button type="button" data-al="center">Center</button><button type="button" data-al="right">Right</button></div></div>' +
      '<div class="ec-sp-row ec-sp-actions"><button type="button" class="ec-sp-mini" id="spBold">Bold</button><button type="button" class="ec-sp-reset" id="spReset">↺ Reset element</button></div>';
    shell.appendChild(p);
    stylePanel = p;
    const set = (prop, val) => {
      if (!curStyleEl) return;
      const tier = deviceTier();
      let rec = styleEdits.get(curStyleEl);
      if (!rec) { rec = { base: {}, tablet: {}, phone: {} }; styleEdits.set(curStyleEl, rec); }
      if (val === '' || val == null) delete rec[tier][prop];
      else rec[tier][prop] = val;
      if (!Object.keys(rec.base).length && !Object.keys(rec.tablet).length && !Object.keys(rec.phone).length) styleEdits.delete(curStyleEl);
      renderStyleOverrides();   /* live preview at the current device width */
      styleDirty = true; updateStatus();
    };
    p.querySelector('#spColor').addEventListener('input', (e) => set('color', e.target.value));
    p.querySelector('#spBg').addEventListener('input', (e) => set('background-color', e.target.value));
    p.querySelector('#spBgClear').addEventListener('click', () => { set('background-color', ''); });
    const size = p.querySelector('#spSize'), sizeVal = p.querySelector('#spSizeVal');
    size.addEventListener('input', (e) => { sizeVal.textContent = e.target.value + 'px'; set('font-size', e.target.value + 'px'); });
    const pad = p.querySelector('#spPad'), padVal = p.querySelector('#spPadVal');
    pad.addEventListener('input', (e) => { padVal.textContent = e.target.value + 'px'; set('padding', e.target.value + 'px'); });
    p.querySelectorAll('#spAlign button').forEach((b) => b.addEventListener('click', () => {
      p.querySelectorAll('#spAlign button').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active'); set('text-align', b.dataset.al);
    }));
    const bold = p.querySelector('#spBold');
    bold.addEventListener('click', () => {
      const on = bold.classList.toggle('is-active');
      set('font-weight', on ? '700' : '');
    });
    p.querySelector('#spReset').addEventListener('click', () => {
      if (!curStyleEl) return;
      styleEdits.delete(curStyleEl);   /* clear this element's overrides (all tiers) */
      renderStyleOverrides();
      styleDirty = true; populateStylePanel(curStyleEl); updateStatus();
    });
    p.querySelector('#spClose').addEventListener('click', () => deselectStyleEl());
    return p;
  }
  function populateStylePanel(el) {
    const p = stylePanel, cs = frameDoc.defaultView.getComputedStyle(el);
    p.querySelector('#spTarget').textContent = elDesc(el);
    p.querySelector('#spScope').textContent = 'Changes apply to: ' + tierLabel(deviceTier());
    p.querySelector('#spColor').value = rgbToHex(cs.color);
    const sz = parseInt(cs.fontSize) || 16;
    p.querySelector('#spSize').value = Math.min(80, Math.max(10, sz)); p.querySelector('#spSizeVal').textContent = sz + 'px';
    const bg = cs.backgroundColor;
    const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    p.querySelector('#spBg').value = hasBg ? rgbToHex(bg) : '#ffffff';
    const pad = parseInt(cs.paddingTop) || 0;
    p.querySelector('#spPad').value = Math.min(80, pad); p.querySelector('#spPadVal').textContent = pad + 'px';
    p.querySelectorAll('#spAlign button').forEach((b) => b.classList.toggle('is-active', b.dataset.al === cs.textAlign));
    p.querySelector('#spBold').classList.toggle('is-active', (parseInt(cs.fontWeight) || 400) >= 600);
  }
  function selectStyleEl(el) {
    if (!el || el === frameDoc.body || el === frameDoc.documentElement || el.closest('.ec-cmt-anchor, .ec-sec-anchor, .hero-dots')) return;
    deselectStyleEl(true);
    curStyleEl = el; el.classList.add('ec-style-selected');
    buildStylePanel();
    populateStylePanel(el);
    stylePanel.hidden = false;
  }
  function deselectStyleEl(keepPanel) {
    if (curStyleEl) curStyleEl.classList.remove('ec-style-selected');
    curStyleEl = null;
    if (!keepPanel && stylePanel) stylePanel.hidden = true;
  }
  function setStyleMode(on) {
    if (on && refining && !closeRefine()) return;
    if (on && linkMode) setLinkMode(false);
    if (on && imgMode) setImgMode(false);
    if (on && secMode) setSecMode(false);
    styleMode = on;
    ecStyle.classList.toggle('is-active', on);
    ecStyle.textContent = on ? '🎨 Style: ON' : '🎨 Style';
    setTextEditable(!on);
    if (frameDoc) frameDoc.documentElement.classList.toggle('ec-style-on', on);
    if (!on) { deselectStyleEl(); if (frameDoc) frameDoc.querySelectorAll('.ec-style-hover').forEach((e) => e.classList.remove('ec-style-hover')); }
  }
  ecStyle.addEventListener('click', () => { if (previewing) return; setStyleMode(!styleMode); });

  /* ---------- Section show/hide + reorder ---------- */
  function refreshSecBars() {
    const secs = movableSections(frameDoc);
    secs.forEach((sec, i) => {
      const bar = sec.querySelector(':scope > .ec-sec-anchor');
      if (!bar) return;
      const up = bar.querySelector('.ec-sec-up'), dn = bar.querySelector('.ec-sec-down');
      if (up) up.disabled = i === 0;
      if (dn) dn.disabled = i === secs.length - 1;
    });
  }
  function moveSection(sec, dir) {
    const secs = movableSections(frameDoc);
    const i = secs.indexOf(sec), j = i + dir;
    if (j < 0 || j >= secs.length) return;
    const ref = secs[j];
    if (dir < 0) ref.parentNode.insertBefore(sec, ref);
    else ref.parentNode.insertBefore(sec, ref.nextSibling);
    sectionsDirty = true;
    renderStyleOverrides();   /* recompute style selectors for the new section order */
    refreshNoteMarks();       /* keep note highlights on the right sections */
    refreshSecBars(); updateStatus();
  }
  function toggleHideSection(sec, btn) {
    const wasHidden = sec.hasAttribute('hidden');
    if (wasHidden) sec.removeAttribute('hidden'); else sec.setAttribute('hidden', '');
    btn.textContent = wasHidden ? '🙈 Hide' : '👁 Show';
    sectionsDirty = true; updateStatus();
  }
  function enterSecMode() {
    movableSections(frameDoc).forEach((sec) => {
      let anchor = sec.querySelector(':scope > .ec-sec-anchor');
      if (!anchor) {
        anchor = frameDoc.createElement('div');
        anchor.className = 'ec-sec-anchor';
        anchor.innerHTML =
          '<div class="ec-sec-bar">' +
            '<span class="ec-sec-label"></span>' +
            '<button type="button" class="ec-sec-up" title="Move up">↑</button>' +
            '<button type="button" class="ec-sec-down" title="Move down">↓</button>' +
            '<button type="button" class="ec-sec-hide"></button>' +
          '</div>';
        anchor.querySelector('.ec-sec-up').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); moveSection(sec, -1); });
        anchor.querySelector('.ec-sec-down').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); moveSection(sec, 1); });
        anchor.querySelector('.ec-sec-hide').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleHideSection(sec, e.currentTarget); });
        sec.insertBefore(anchor, sec.firstChild);
      }
      anchor.querySelector('.ec-sec-label').textContent = sectionLabel(sec);
      anchor.querySelector('.ec-sec-hide').textContent = sec.hasAttribute('hidden') ? '👁 Show' : '🙈 Hide';
    });
    refreshSecBars();
  }
  function exitSecMode() {
    if (frameDoc) frameDoc.querySelectorAll('.ec-sec-anchor').forEach((a) => a.remove());
  }
  function setSecMode(on) {
    if (on && refining && !closeRefine()) return;
    if (on && linkMode) setLinkMode(false);
    if (on && imgMode) setImgMode(false);
    if (on && styleMode) setStyleMode(false);
    secMode = on;
    ecSec.classList.toggle('is-active', on);
    ecSec.textContent = on ? '📑 Sections: ON' : '📑 Sections';
    setTextEditable(!on);
    if (on) enterSecMode(); else exitSecMode();
  }
  ecSec.addEventListener('click', () => { if (previewing) return; setSecMode(!secMode); });

  /* ===== Contextual "click anything" edit bar =====================================
     The owner clicks any element on the page; a small floating bar appears with only
     the actions that make sense for what they clicked (Replace photo / Link / Style /
     section controls). It reuses the same modals & panels as the old mode buttons. */
  let ctxBar = null, ctxTarget = null;
  function hideCtxBar() { if (ctxBar) ctxBar.style.display = 'none'; ctxTarget = null; }
  function ctxToggleHideSection(sec) {
    if (sec.hasAttribute('hidden')) sec.removeAttribute('hidden'); else sec.setAttribute('hidden', '');
    sectionsDirty = true; updateStatus();
  }
  function ctxActionsFor(el) {
    const acts = [];
    const slot = el.tagName === 'IMG' ? imgSlot(el) : null;
    if (slot) {
      if (HERO_SLOTS.indexOf(slot) !== -1) {     /* part of the hero set → photo-picker strip */
        const group = HERO_SLOTS.filter((s) => IMAGE_SLOTS[s]);
        acts.push({ label: '🖼️ Replace photo', fn: () => {
          const first = editableImages(frameDoc).find((i) => imgSlot(i) === group[0]) || el;
          openImageModal(first, group[0], group);   /* one window: pick which photo + crop */
        } });
      } else acts.push({ label: '🖼️ Replace photo', fn: () => openImageModal(el, slot) });
    }
    const a = el.closest('a');
    if (a && !a.closest(LINK_SKIP)) acts.push({ label: '🔗 Link', fn: () => openLinkModal(a) });
    if (el !== frameDoc.body && el !== frameDoc.documentElement && !el.closest(LINK_SKIP)) {
      acts.push({ label: '🎨 Style', fn: () => selectStyleEl(el) });
    }
    const sec = el.closest('body > section');
    if (sec) {
      acts.push({ sep: true });
      /* Add/Edit note for the AI — home page only (the AI implement flow is index-specific) */
      if (currentPage === 'index.html') {
        acts.push({ label: comments.has(sec) ? '💬 Edit note' : '💬 Add note', fn: () => openComment(sec) });
      }
      acts.push({ label: sec.hasAttribute('hidden') ? '👁 Show section' : '🙈 Hide section', fn: () => ctxToggleHideSection(sec) });
      acts.push({ label: '↑', title: 'Move this section up', fn: () => moveSection(sec, -1) });
      acts.push({ label: '↓', title: 'Move this section down', fn: () => moveSection(sec, 1) });
    }
    return acts;
  }
  function showCtxBar(el) {
    if (!el || el.nodeType !== 1 || el === frameDoc.body || el === frameDoc.documentElement) { hideCtxBar(); return; }
    if (el.closest('.ec-cmt-anchor, .ec-sec-anchor, .hero-dots, .ec-style-panel')) { hideCtxBar(); return; }
    const acts = ctxActionsFor(el);
    if (!acts.length) { hideCtxBar(); return; }
    if (!ctxBar) { ctxBar = document.createElement('div'); ctxBar.className = 'ec-ctx'; shell.appendChild(ctxBar); }
    ctxTarget = el;
    ctxBar.innerHTML = '';
    acts.forEach((a) => {
      if (a.sep) { const s = document.createElement('span'); s.className = 'ec-ctx-sep'; ctxBar.appendChild(s); return; }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ec-ctx-btn'; b.textContent = a.label;
      if (a.title) b.title = a.title;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); hideCtxBar(); a.fn(); });
      ctxBar.appendChild(b);
    });
    ctxBar.style.display = 'flex';
    ctxBar.style.visibility = 'hidden';
    const fr = frame.getBoundingClientRect(), r = el.getBoundingClientRect();
    const bw = ctxBar.offsetWidth, bh = ctxBar.offsetHeight;
    let x = fr.left + r.left;
    let y = fr.top + r.top - bh - 8;
    if (y < fr.top + 4) y = Math.min(fr.bottom - bh - 4, fr.top + r.bottom + 8);
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    ctxBar.style.left = x + 'px';
    ctxBar.style.top = y + 'px';
    ctxBar.style.visibility = 'visible';
  }
  /* dismiss on outside click (in the editor chrome) or Escape */
  document.addEventListener('click', (e) => { if (ctxBar && (!e.target.closest || !e.target.closest('.ec-ctx'))) hideCtxBar(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxBar(); });

  function wireFrame(doc) {
    frameDoc = doc;
    /* tag sections with their file-order index — a stable key for persisting
       reorder/hide onto a fresh server copy at save time */
    movableSections(doc).forEach((sec, i) => sec.setAttribute('data-ec-idx', i));
    [...doc.querySelectorAll(EDIT_SEL)].forEach((el, i) => {
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'true');   /* browser red-underlines typos while editing */
      el.classList.add('ec-editable');
      el.addEventListener('input', () => { dirty.set(i, el.innerHTML); updateStatus(); });
    });
    doc.addEventListener('click', (e) => {
      if (e.target.closest('.ec-cmt-btn')) { hideCtxBar(); return; }
      if (e.target.closest('.ec-style-panel')) return;
      /* --- legacy mode routing (buttons are hidden; these stay inert but safe) --- */
      if (styleMode) { e.preventDefault(); e.stopPropagation(); selectStyleEl(e.target); return; }
      if (imgMode) {
        const im = e.target.closest('img');
        if (im && imgSlot(im)) { e.preventDefault(); e.stopPropagation(); openImageModal(im, imgSlot(im)); return; }
      }
      if (linkMode) {
        const la = e.target.closest('a');
        if (la && !la.closest(LINK_SKIP)) { e.preventDefault(); e.stopPropagation(); openLinkModal(la); return; }
      }
      /* --- DEFAULT: contextual "click anything" editing --- */
      /* contextual editing — text caret + click-menu (notes now live in the section menu) */
      const a = e.target.closest('a');
      if (a) e.preventDefault();   /* don't navigate links while editing */
      showCtxBar(e.target);        /* text still gets a caret for inline typing */
    }, true);
    /* hover outline so the owner sees what's clickable (default edit state only).
       Editable text already has its own .ec-editable:hover outline — skip it here so
       we only hint at the non-text actionables (photos, buttons, boxes). */
    doc.addEventListener('mouseover', (e) => {
      if (linkMode || imgMode || styleMode || secMode) return;
      const el = e.target;
      if (!el || el === doc.body || el === doc.documentElement || el.isContentEditable) return;
      if (el.closest('.ec-cmt-anchor, .ec-sec-anchor, .hero-dots, .ec-style-panel, .ec-ctx, [contenteditable]')) return;
      el.classList.add('ec-ctx-hover');
    });
    doc.addEventListener('mouseout', (e) => { if (e.target.classList) e.target.classList.remove('ec-ctx-hover'); });
    doc.addEventListener('scroll', hideCtxBar, true);
    refreshNoteMarks();   /* mark any sections that already have a pending note */
    loadOverrides();      /* round-trip any previously-saved per-device style overrides */
    if (linkMode) { setTextEditable(false); highlightLinks(true); }
    if (imgMode) { setTextEditable(false); doc.documentElement.classList.add('ec-img-on'); highlightImages(true); }
    if (secMode) { setTextEditable(false); enterSecMode(); }
    if (styleMode) { setTextEditable(false); doc.documentElement.classList.add('ec-style-on'); }
    const sc = sessionStorage.getItem('ecScroll');
    if (sc) {
      sessionStorage.removeItem('ecScroll');
      const y = Number(sc) || 0;
      const apply = () => { try { doc.defaultView.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch { /* ignore */ } };
      apply(); [60, 150, 350, 700].forEach((d) => setTimeout(apply, d));   /* retries for late layout/images */
    }
  }
  /* live scroll position of whatever the device iframe is showing (editable page OR srcdoc preview) */
  function frameScrollY() {
    try { return frame.contentWindow.scrollY || (frame.contentDocument.scrollingElement || {}).scrollTop || 0; } catch { return 0; }
  }
  function saveScroll() {
    try { sessionStorage.setItem('ecScroll', String(frameScrollY())); } catch { /* ignore */ }
  }
  /* set the iframe srcdoc (refine preview) WITHOUT jumping to the top — restore scroll after load */
  function setFrameSrcdoc(srcdoc, y) {
    frame.addEventListener('load', function once() {
      frame.removeEventListener('load', once);
      const s = () => { try { frame.contentWindow.scrollTo(0, y); } catch { /* ignore */ } };
      s(); [80, 250, 500].forEach((d) => setTimeout(s, d));
    });
    frame.srcdoc = srcdoc;
  }
  frame.addEventListener('load', () => {
    if (previewing || refining) return;   /* a static preview is showing — don't wire/edit it */
    ensureFrameChrome(frame.contentDocument);
    wireFrame(frame.contentDocument); applyDevice(currentDevice); updateStatus();
  });

  /* ---------- Save text edits + queue notes ---------- */
  ecSave.addEventListener('click', async () => {
    if (previewing) return;
    const hasHtml = dirty.size || linkEdits.size || sectionsDirty || styleDirty;
    if (!hasHtml && !comments.size) { alert('No changes or notes yet.'); return; }
    /* guard: don't let pending AI notes go unnoticed on Save */
    if (comments.size && !confirm(
      'You have ' + comments.size + ' note' + (comments.size !== 1 ? 's' : '') + ' for the AI.\n\n' +
      'Saving will queue them — then use “🤖 Apply notes” to have the AI make those changes.\n\n' +
      'Save now? (Cancel to apply your notes first.)'
    )) return;
    ecSave.disabled = true; ecSave.textContent = 'Saving…';
    try {
      if (hasHtml) {
        /* rebuild the page off a fresh server copy so we never serialize the
           editor-polluted iframe DOM — apply text edits by EDIT_SEL index and
           link edits by editable-link index (both stable vs the static file) */
        const src = await (await fetch(currentPage, { cache: 'no-store' })).text();
        const doc = new DOMParser().parseFromString(src, 'text/html');
        const targets = doc.querySelectorAll(EDIT_SEL);
        dirty.forEach((html, i) => { if (targets[i]) targets[i].innerHTML = html; });
        const links = editableLinks(doc);
        linkEdits.forEach((v, i) => {
          const el = links[i];
          if (!el) return;
          el.setAttribute('href', v.href);
          if (v.text != null) el.textContent = v.text;
        });
        if (sectionsDirty) {
          /* read the live arrangement (display order + hidden state) and apply it
             to the fresh copy by each section's stable file-order index */
          const arrangement = movableSections(frameDoc).map((s) => ({
            idx: Number(s.getAttribute('data-ec-idx')), hidden: s.hasAttribute('hidden'),
          }));
          const fresh = movableSections(doc);
          const footer = doc.querySelector('body > footer');
          arrangement.forEach((a) => {
            const el = fresh[a.idx];
            if (!el) return;
            if (a.hidden) el.setAttribute('hidden', ''); else el.removeAttribute('hidden');
          });
          /* re-order the sections into the owner's chosen order. Anchor before the footer
             if there is one; otherwise move each to the end of <body> in order (so reorder
             still persists on pages with no <body > footer>). */
          arrangement.forEach((a) => {
            const el = fresh[a.idx];
            if (!el) return;
            if (footer) el.parentNode.insertBefore(el, footer); else doc.body.appendChild(el);
          });
        }
        if (styleDirty) {
          /* persist all per-device overrides as a single <style> block in <head>;
             base rules + @media tiers keep each change on the right device view */
          let st = doc.getElementById('ec-style-overrides');
          if (!st) { st = doc.createElement('style'); st.id = 'ec-style-overrides'; doc.head.appendChild(st); }
          const css = buildOverrideCss();
          if (css) st.textContent = css; else st.remove();
        }
        const out = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        const r = await fetch(API + 'save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: key, page: currentPage, html: out }),
        });
        if (!r.ok) throw new Error('page — ' + (await r.text() || r.status));
      }
      if (comments.size) {
        const r = await fetch(API + 'comment', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: key, comments: [...comments.values()] }),
        });
        if (!r.ok) throw new Error('notes — ' + (await r.text() || r.status));
      }
      alert('Saved ✓' +
        (dirty.size ? '\n• Text changes are live.' : '') +
        (linkEdits.size ? '\n• Link changes are live.' : '') +
        (styleEdits.size ? '\n• Style changes are live.' : '') +
        (sectionsDirty ? '\n• Section layout is live.' : '') +
        (comments.size ? '\n• Your design notes were sent to the AI queue.' : ''));
      saveScroll();
      location.reload();
    } catch (err) {
      alert('Save failed (' + err.message + ')');
      ecSave.disabled = false; ecSave.textContent = 'Save changes';
    }
  });

  /* ---------- Implement (preview, then publish) ---------- */
  ecImpl.addEventListener('click', async () => {
    if (ecImpl.disabled || previewing) return;
    if (refining && !closeRefine()) return;
    ecImpl.disabled = true; const orig = ecImpl.textContent; ecImpl.textContent = 'AI working…';
    try {
      if (comments.size) {
        const r0 = await fetch(API + 'comment', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: key, comments: [...comments.values()] }),
        });
        if (!r0.ok) throw new Error('notes — ' + (await r0.text() || r0.status));
        serverNotes += comments.size; comments.clear(); updateStatus();
      }
      const r = await fetch(API + 'implement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: key, model: getAiModel() }),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(txt || r.status);
      const data = JSON.parse(txt);
      ecImpl.textContent = orig;
      if (!data.files) {
        /* the AI couldn't do it as a text/style change — tell the owner plainly,
           don't open a (broken) preview */
        ecImpl.disabled = false; refreshImplState();
        const why = (data.cannot && data.cannot.length) ? data.cannot : ['This change can’t be done as a text or styling edit.'];
        alert('🤖 I can’t make this change:\n\n• ' + why.join('\n\n• ') +
          '\n\nThis kind of change needs a developer to add — nothing was changed on your page.');
        return;
      }
      startPreview(data.files, data.summary, data.changes || [], data.cost, data.cannot);
    } catch (err) {
      alert('AI request failed (' + err.message + ') — nothing was changed.');
      ecImpl.textContent = orig; ecImpl.disabled = false; refreshImplState();
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /* Build a static srcdoc preview of proposed files. Scripts are stripped (we never
     run the page's JS in a srcdoc); this page fades sections in via JS on scroll and
     builds the chat/sticky chrome in JS, so we force revealed content visible + hide
     JS-only chrome — exactly like the live editing iframe (html.ec-frame). Shared by
     the AI implement preview and the conversational-refine preview. */
  async function buildPreviewSrcdoc(files) {
    const indexHTML = files['index.html'] || await (await fetch('index.html', { cache: 'no-store' })).text();
    const cssText = files['styles.css'] || await (await fetch('styles.css', { cache: 'no-store' })).text();
    const origin = location.origin + '/';
    const previewFix = '<style>.reveal{opacity:1 !important;transform:none !important}' +
      '.chat-fab,.chat-panel,.chat-teaser,.sticky-cta{display:none !important}</style>';
    return indexHTML
      .replace(/<head(\s[^>]*)?>/i, (m) => m + '\n<base href="' + origin + '">')
      .replace(/<link[^>]*href="styles\.css[^"]*"[^>]*>/i, '<style>\n' + cssText + '\n</style>')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '')
      .replace(/<\/head>/i, previewFix + '</head>');
  }

  async function startPreview(files, summary, changes, cost, cannot) {
    previewing = true; pendingFiles = files;
    frame.srcdoc = await buildPreviewSrcdoc(files);

    let bar = shell.querySelector('.ec-preview-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'ec-preview-bar';
      bar.innerHTML =
        '<span class="ec-pv-label"></span>' +
        '<button type="button" class="ec-pv-discard" id="ecPvDiscard">✗ Discard</button>' +
        '<button type="button" class="ec-pv-approve" id="ecPvApprove">✓ Approve &amp; publish</button>';
      shell.insertBefore(bar, stage);
      bar.querySelector('#ecPvApprove').addEventListener('click', approvePreview);
      bar.querySelector('#ecPvDiscard').addEventListener('click', discardPreview);
    }
    const n = (changes || []).length;
    const skipped = (cannot || []).length;
    const lbl = bar.querySelector('.ec-pv-label');
    lbl.textContent =
      '👁 Preview (' + summary + ', ' + n + ' change' + (n !== 1 ? 's' : '') + (cost != null ? ', cost $' + Number(cost).toFixed(2) : '') + ') — NOT live yet.' +
      (skipped ? '  ⚠️ ' + skipped + ' note' + (skipped !== 1 ? 's' : '') + ' skipped (needs a developer).' : '');
    if (skipped) lbl.title = 'Skipped:\n• ' + cannot.join('\n• '); else lbl.removeAttribute('title');
    bar.style.display = 'flex';
    refreshImplState();
  }
  async function approvePreview() {
    const ap = shell.querySelector('#ecPvApprove');
    ap.disabled = true; ap.textContent = 'Publishing…';
    try {
      const r = await fetch(API + 'publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: key, files: pendingFiles }),
      });
      const msg = await r.text();
      if (!r.ok) throw new Error(msg || r.status);
      saveScroll();
      location.reload();
    } catch (err) {
      alert('Publish failed (' + err.message + ')');
      ap.disabled = false; ap.textContent = '✓ Approve & publish';
    }
  }
  function discardPreview() {
    previewing = false; pendingFiles = null;
    const bar = shell.querySelector('.ec-preview-bar');
    if (bar) bar.style.display = 'none';
    saveScroll();
    frame.removeAttribute('srcdoc');
    frame.src = frameSrc(currentPage);   /* reload the live editable page */
    refreshImplState();
  }

  /* ---------- Conversational refine (chat with the AI) ---------- */
  let refinePanel = null;
  function buildRefinePanel() {
    if (refinePanel) return refinePanel;
    const p = document.createElement('div');
    p.className = 'ec-refine-panel'; p.hidden = true;
    p.innerHTML =
      '<div class="ec-rf-head"><strong>🪄 Refine with AI</strong>' +
        '<span class="ec-rf-cost" id="ecRfCost"></span>' +
        '<button type="button" class="ec-rf-x" id="ecRfClose" aria-label="Close">✕</button></div>' +
      '<div class="ec-rf-msgs" id="ecRfMsgs"></div>' +
      '<div class="ec-rf-scope" id="ecRfScope"></div>' +
      '<div class="ec-rf-row"><textarea class="ec-rf-input" id="ecRfInput" rows="2" ' +
        'placeholder="Tell me what to change… e.g. “make the headline bigger”"></textarea>' +
        '<button type="button" class="ec-rf-send" id="ecRfSend">Send</button></div>' +
      '<div class="ec-rf-foot">' +
        '<button type="button" class="ec-rf-discard" id="ecRfDiscard">✗ Discard</button>' +
        '<button type="button" class="ec-rf-publish" id="ecRfPublish" disabled>💾 Save changes</button></div>';
    shell.appendChild(p);
    refinePanel = p;
    const input = p.querySelector('#ecRfInput');
    p.querySelector('#ecRfSend').addEventListener('click', sendRefine);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRefine(); } });
    p.querySelector('#ecRfClose').addEventListener('click', () => closeRefine());
    p.querySelector('#ecRfDiscard').addEventListener('click', () => closeRefine());
    p.querySelector('#ecRfPublish').addEventListener('click', publishRefine);
    return p;
  }
  function addRefineMsg(role, text) {
    const m = document.createElement('div');
    m.className = 'ec-rf-msg ec-rf-' + role;
    m.textContent = text;
    const list = refinePanel.querySelector('#ecRfMsgs');
    list.appendChild(m); list.scrollTop = list.scrollHeight;
    return m;
  }
  function fmtCost(c) {
    c = Number(c) || 0;
    if (c <= 0) return '$0.00';
    if (c >= 0.01) return '$' + c.toFixed(2);
    return '$' + c.toFixed(3);   /* sub-penny edits still show a real number */
  }
  /* which device view the next Refine message will target (matches the Style-panel tiers) */
  function refineScopeInfo() {
    const tier = deviceTier();
    const maxWidth = tier === 'phone' ? CFG.breakpoints.phone : tier === 'tablet' ? CFG.breakpoints.tablet : 0;
    return { tier, maxWidth, label: (DEVICES[currentDevice] || {}).label || 'Desktop' };
  }
  function updateRefineScope() {
    if (!refinePanel) return;
    const el = refinePanel.querySelector('#ecRfScope');
    if (el) el.textContent = '📐 Your next message changes: ' + tierLabel(deviceTier()) + ' (' + refineScopeInfo().label + ' view)';
  }
  async function openRefine() {
    if (linkMode) setLinkMode(false);
    if (imgMode) setImgMode(false);
    if (secMode) setSecMode(false);
    if (styleMode) setStyleMode(false);
    refining = true; refineDirty = false;
    /* the page isn't manually editable while refining, so the toolbar Save does nothing —
       hide it so there's only ONE "Save changes" (the panel's) visible at a time */
    ecSave.style.display = 'none';
    ecRefine.classList.add('is-active'); ecRefine.textContent = '🪄 Refine: ON';
    buildRefinePanel();
    refinePanel.querySelector('#ecRfMsgs').innerHTML = '';
    refinePanel.querySelector('#ecRfCost').textContent = '';
    refinePanel.querySelector('#ecRfPublish').disabled = true;
    addRefineMsg('ai', 'Hi! Tell me what to tweak — e.g. “make the headline bigger”, then “now more orange”. I’ll show each change right here. Nothing goes live until you press 💾 Save changes.');
    refinePanel.hidden = false;
    updateRefineScope();
    /* show the current page as a static preview we’ll update each turn — keep scroll */
    const y = frameScrollY();
    setFrameSrcdoc(await buildPreviewSrcdoc({}), y);
    setTimeout(() => refinePanel.querySelector('#ecRfInput').focus(), 60);
  }
  function closeRefine(skipReload) {
    if (refineDirty && !confirm('Discard the unsaved AI changes?')) return false;
    refining = false;
    ecSave.style.display = '';   /* bring the toolbar Save back */
    ecRefine.classList.remove('is-active'); ecRefine.textContent = '🪄 Refine with AI';
    if (refinePanel) refinePanel.hidden = true;
    fetch(API + 'refine/discard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: key }),
    }).catch(() => {});
    refineDirty = false;
    if (!skipReload) { saveScroll(); frame.removeAttribute('srcdoc'); frame.src = frameSrc(currentPage); }
    return true;
  }
  async function sendRefine() {
    const input = refinePanel.querySelector('#ecRfInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; input.disabled = true;
    const sendBtn = refinePanel.querySelector('#ecRfSend'); sendBtn.disabled = true;
    const scope = refineScopeInfo();   /* device this message targets, captured at send time */
    const om = addRefineMsg('owner', text);
    const tag = document.createElement('div'); tag.className = 'ec-rf-scopetag';
    tag.textContent = '→ ' + tierLabel(scope.tier);
    om.appendChild(tag);
    const thinking = addRefineMsg('ai', '…');
    thinking.classList.add('ec-rf-thinking');
    try {
      const r = await fetch(API + 'refine/message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: key, text, device: scope.label, tier: scope.tier, maxWidth: scope.maxWidth, model: getAiModel() }),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(txt || r.status);
      const data = JSON.parse(txt);
      thinking.remove();
      const msg = addRefineMsg('ai', data.reply || 'Done.');
      if (!data.applied && data.cannot && data.cannot.length) msg.classList.add('ec-rf-cannot');
      if (data.cost != null && Number(data.cost) > 0) {
        const tag = document.createElement('div');
        tag.className = 'ec-rf-cost-tag';
        tag.textContent = (data.applied ? 'this change ≈ ' : 'this reply ≈ ') + fmtCost(data.cost);
        msg.appendChild(tag);
      }
      if (data.files) { const y = frameScrollY(); setFrameSrcdoc(await buildPreviewSrcdoc(data.files), y); }
      if (data.totalCost != null) refinePanel.querySelector('#ecRfCost').textContent = 'Total ≈ ' + fmtCost(data.totalCost);
      if (data.dirty) { refineDirty = true; refinePanel.querySelector('#ecRfPublish').disabled = false; }
    } catch (err) {
      thinking.remove();
      const m = err.message || '';
      const msg = /credit|402/i.test(m)
        ? '💳 Your OpenRouter account is out of credits. Add credits at openrouter.ai/settings/credits — or open ⚙ and switch back to the default Claude model.'
        : '⚠️ Something went wrong (' + m + '). Try again.';
      addRefineMsg('ai', msg).classList.add('ec-rf-cannot');
    } finally {
      input.disabled = false; sendBtn.disabled = false; input.focus();
    }
  }
  async function publishRefine() {
    const btn = refinePanel.querySelector('#ecRfPublish');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch(API + 'refine/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: key }),
      });
      if (!r.ok) throw new Error(await r.text() || r.status);
      refining = false; refineDirty = false;
      saveScroll();
      location.reload();
    } catch (err) {
      alert('Save failed (' + err.message + ')');
      btn.disabled = false; btn.textContent = '💾 Save changes';
    }
  }
  ecRefine.addEventListener('click', () => {
    if (previewing) return;
    if (refining) closeRefine(); else openRefine();
  });

  /* ---------- History & restore points ---------- */
  shell.querySelector('#ecHistory').addEventListener('click', async () => {
    if (previewing) { alert('Discard the current preview first.'); return; }
    let data;
    try {
      const r = await fetch(API + 'history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: key }),
      });
      if (!r.ok) throw new Error(await r.text() || r.status);
      data = await r.json();
    } catch (err) { alert('Could not load history (' + err.message + ')'); return; }

    const ov = document.createElement('div');
    ov.className = 'ec-modal-ov';
    const rows = (data.points || []).map((p) =>
      '<div class="ec-hist-row"><span class="ec-hist-when">' + p.when +
      (p.where === 'undone' ? ' <em>(undone)</em>' : '') + '</span>' +
      '<button type="button" class="ec-hist-restore" data-stamp="' + p.stamp + '">Restore</button></div>').join('')
      || '<p class="ec-modal-sub">No restore points yet.</p>';
    ov.innerHTML =
      '<div class="ec-modal">' +
        '<h3>Change history</h3>' +
        '<p class="ec-modal-sub">AI spend: $' + (data.spendUsd || 0).toFixed(2) + ' over ' + (data.runs || 0) + ' AI edit' + (data.runs === 1 ? '' : 's') + '. Pick a point to roll the page back to it.</p>' +
        '<div class="ec-hist-list">' + rows + '</div>' +
        '<div class="ec-modal-row"><span></span><div><button type="button" class="ec-modal-cancel" id="ecHistClose">Close</button></div></div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('#ecHistClose').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelectorAll('.ec-hist-restore').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Roll the page back to this point? (You can undo this too.)')) return;
      b.disabled = true; b.textContent = 'Restoring…';
      try {
        const r = await fetch(API + 'restore-to', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: key, stamp: b.dataset.stamp }),
        });
        if (!r.ok) throw new Error(await r.text() || r.status);
        saveScroll();
        location.reload();
      } catch (err) { alert('Restore failed (' + err.message + ')'); b.disabled = false; b.textContent = 'Restore'; }
    }));
  });

  /* ---------- Undo ---------- */
  shell.querySelector('#ecUndo').addEventListener('click', async () => {
    if (previewing) { alert('Discard the current preview first.'); return; }
    if (!confirm('Undo the last change and restore the previous version of the page?')) return;
    const btn = shell.querySelector('#ecUndo');
    btn.disabled = true; btn.textContent = 'Reverting…';
    try {
      const r = await fetch(API + 'revert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: key }),
      });
      if (r.status === 400) { alert('Nothing to undo yet.'); btn.disabled = false; btn.textContent = '↩ Undo'; return; }
      if (!r.ok) throw new Error(await r.text() || r.status);
      alert('Reverted to the previous version.');
      saveScroll();
      location.reload();
    } catch (err) {
      alert('Undo failed (' + err.message + ')');
      btn.disabled = false; btn.textContent = '↩ Undo';
    }
  });

  /* ---------- Exit ---------- */
  shell.querySelector('#ecExit').addEventListener('click', () => {
    const pendingEdits = dirty.size || linkEdits.size || sectionsDirty || styleDirty || refineDirty || previewing;
    if (comments.size && !pendingEdits) {
      if (!confirm('Discard your ' + comments.size + ' unsaved note' + (comments.size !== 1 ? 's' : '') + ' and exit? (They were never sent — Save or Apply notes first to keep them.)')) return;
    } else if (pendingEdits || comments.size) {
      if (!confirm('Discard unsaved changes/notes and exit?')) return;
    }
    if (refining) fetch(API + 'refine/discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: key }) }).catch(() => {});
    sessionStorage.removeItem(EDIT_ACTIVE);   /* leave edit mode; stay logged in for 30 days */
    sessionStorage.removeItem('ecPage');      /* next entry starts on the home page */
    location.href = location.pathname;
  });

  /* ---------- Help + first-run welcome ---------- */
  function openHelp() {
    const ov = document.createElement('div');
    ov.className = 'ec-modal-ov';
    ov.innerHTML =
      '<div class="ec-modal ec-help-modal">' +
        '<h3>How to edit your page</h3>' +
        '<ul class="ec-help-list">' +
          '<li><b>Edit text</b> — click any words and type. That’s it.</li>' +
          '<li><b>Click anything else</b> — a photo, a button, a heading, a box — and a little menu pops up with what you can do to it:</li>' +
          '<li style="list-style:none;padding-left:8px">• <b>🖼️ Replace photo</b> — swap and crop a picture.<br>' +
            '• <b>🔗 Link</b> — change where a button or link goes.<br>' +
            '• <b>🎨 Style</b> — change its color, size, or spacing.<br>' +
            '• <b>🙈 Hide / ↑ ↓</b> — hide or reorder a whole section.<br>' +
            '• <b>💬 Add note</b> — (on a section) jot a change for the AI, then press <b>🤖 Apply notes</b>.</li>' +
          '<li><b>🪄 Refine with AI</b> — just chat: “make the headline bigger”, “now more orange”. See each change, then press <b>💾 Save changes</b>.</li>' +
          '<li><b>↩ Undo / 🕘 History</b> — step back, or jump to any earlier version.</li>' +
        '</ul>' +
        '<p class="ec-help-foot">Most changes go live when you press <b>💾 Save changes</b>. Switch <b>Desktop / Phone</b> at the top to check how it looks on each. Nothing is permanent — Undo always has your back.</p>' +
        '<div class="ec-modal-row"><span></span><div><button type="button" class="ec-modal-save" id="ecHelpOk">Got it</button></div></div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('#ecHelpOk').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  }
  shell.querySelector('#ecHelp').addEventListener('click', openHelp);

  /* ---------- AI model settings (model picker + OpenRouter key) ---------- */
  function openAiSettings() {
    const cur = getAiModel();
    const isCustom = !AI_MODELS.some((m) => m.id === cur);
    const ov = document.createElement('div');
    ov.className = 'ec-modal-ov';
    ov.innerHTML =
      '<div class="ec-modal ec-ai-modal">' +
        '<h3>AI model</h3>' +
        '<p class="ec-modal-sub">Which model the AI editor (Refine + Apply notes) uses. The default is most reliable; cheaper models suit small tweaks.</p>' +
        '<select class="ec-ai-select" id="ecAiSel">' +
          AI_MODELS.map((m) => `<option value="${m.id}"${m.id === cur && !isCustom ? ' selected' : ''}>${m.label}</option>`).join('') +
          `<option value="__custom"${isCustom ? ' selected' : ''}>Custom — any OpenRouter model id…</option>` +
        '</select>' +
        `<input type="text" class="ec-link-input ec-ai-custom" id="ecAiCustom" placeholder="e.g. openai/gpt-4.1-mini  (from openrouter.ai/models)" value="${isCustom ? cur : ''}"${isCustom ? '' : ' style="display:none"'}>` +
        '<hr class="ec-ai-hr">' +
        '<p class="ec-modal-sub">OpenRouter API key <b id="ecKeyStatus" class="ec-key-status"></b></p>' +
        '<p class="ec-modal-hint">Only needed for non-Claude models. Get one at openrouter.ai → Keys. Stored on your server; never shown back here.</p>' +
        '<div class="ec-ai-keyrow"><input type="password" class="ec-link-input" id="ecOrKey" placeholder="sk-or-…" autocomplete="off">' +
          '<button type="button" class="ec-sp-mini" id="ecOrSave">Save key</button></div>' +
        '<button type="button" class="ec-sp-mini ec-or-change" id="ecOrChange" style="display:none">Change OpenRouter key</button>' +
        '<div class="ec-modal-row"><span class="ec-ai-msg" id="ecAiMsg"></span>' +
          '<div><button type="button" class="ec-modal-cancel" id="ecAiClose">Close</button>' +
          '<button type="button" class="ec-modal-save" id="ecAiUse">Use this model</button></div></div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    const sel = ov.querySelector('#ecAiSel'), custom = ov.querySelector('#ecAiCustom'), msg = ov.querySelector('#ecAiMsg');
    sel.addEventListener('change', () => { custom.style.display = sel.value === '__custom' ? '' : 'none'; if (sel.value === '__custom') custom.focus(); });
    ov.querySelector('#ecAiClose').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    /* key status — when a key is already saved, hide the input and show "Change key" */
    const keyStatus = ov.querySelector('#ecKeyStatus');
    const keyRow = ov.querySelector('.ec-ai-keyrow');
    const changeBtn = ov.querySelector('#ecOrChange');
    function setKeyUI(set, fromEnv) {
      keyStatus.textContent = set ? (fromEnv ? '✓ set (server)' : '✓ saved') : '— not set';
      keyStatus.classList.toggle('is-set', !!set);
      if (fromEnv) { keyRow.style.display = 'none'; changeBtn.style.display = 'none'; }        /* env key: can't change here */
      else if (set) { keyRow.style.display = 'none'; changeBtn.style.display = ''; }            /* saved: show "Change key" */
      else { keyRow.style.display = 'flex'; changeBtn.style.display = 'none'; }                 /* none: show the input */
    }
    fetch(API + 'ai/key-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: key }) })
      .then((r) => r.json()).then((d) => setKeyUI(d.set, d.fromEnv)).catch(() => { keyStatus.textContent = ''; });
    changeBtn.addEventListener('click', () => { keyRow.style.display = 'flex'; changeBtn.style.display = 'none'; ov.querySelector('#ecOrKey').focus(); });
    ov.querySelector('#ecOrSave').addEventListener('click', async () => {
      const kf = ov.querySelector('#ecOrKey'); const k = kf.value.trim();
      msg.textContent = 'Saving…';
      try {
        const r = await fetch(API + 'ai/save-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: key, key: k }) });
        if (!r.ok) throw new Error(await r.text() || r.status);
        const d = await r.json();
        kf.value = ''; msg.textContent = 'Key ' + (d.set ? 'saved.' : 'cleared.');
        setKeyUI(d.set, false);
      } catch (err) { msg.textContent = 'Could not save (' + err.message + ')'; }
    });
    ov.querySelector('#ecAiUse').addEventListener('click', () => {
      let m = sel.value === '__custom' ? custom.value.trim() : sel.value;
      m = m.replace(/[^\w.\-:/]/g, '');
      if (!m) { msg.textContent = 'Pick a model or enter an id.'; return; }
      try { localStorage.setItem(AI_MODEL_KEY, m); } catch { /* ignore */ }
      updateAiGear();
      refreshCostEstimate();   /* note-cost estimate now reflects the chosen model */
      if (refining) updateRefineScope();
      close();
    });
  }
  function updateAiGear() {
    const g = shell.querySelector('#ecAiSettings');
    if (g) g.title = 'AI model: ' + aiModelLabel(getAiModel()) + ' — click to change';
  }
  shell.querySelector('#ecAiSettings').addEventListener('click', openAiSettings);
  updateAiGear();

  /* ---------- SEO / sharing (title, search description, social text) ---------- */
  function seoField(id, label, hint, val, rows, max) {
    const v = (val || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const input = rows
      ? '<textarea class="ec-link-input ec-seo-in" id="' + id + '" rows="' + rows + '" maxlength="' + max + '">' + v + '</textarea>'
      : '<input type="text" class="ec-link-input ec-seo-in" id="' + id + '" maxlength="' + max + '" value="' + v + '">';
    return '<label class="ec-seo-row"><span class="ec-seo-label">' + label + ' <em>' + hint + '</em></span>' + input +
           '<span class="ec-seo-count" id="' + id + 'c"></span></label>';
  }
  function openSeo() {
    if (previewing || refining) { alert('Finish the current preview first.'); return; }
    const ov = document.createElement('div');
    ov.className = 'ec-modal-ov';
    ov.innerHTML = '<div class="ec-modal ec-seo-modal"><h3>Search &amp; social</h3>' +
      '<p class="ec-modal-sub">How your page looks in Google results and when shared on social media. Changes go live on Save.</p>' +
      '<div id="ecSeoBody" class="ec-seo-body">Loading…</div>' +
      '<div class="ec-modal-row"><span class="ec-ai-msg" id="ecSeoMsg"></span><div>' +
      '<button type="button" class="ec-modal-cancel" id="ecSeoCancel">Cancel</button>' +
      '<button type="button" class="ec-modal-save" id="ecSeoSave" disabled>Save</button></div></div></div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('#ecSeoCancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const body = ov.querySelector('#ecSeoBody'), saveBtn = ov.querySelector('#ecSeoSave'), msg = ov.querySelector('#ecSeoMsg');
    fetch(API + 'seo/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: key }) })
      .then((r) => r.ok ? r.json() : null).then((d) => {
        if (!d) { body.textContent = 'Could not load.'; return; }
        body.innerHTML =
          seoField('ecSeoTitle', 'Page title', '(browser tab + Google headline · ~60 chars)', d.title, 0, 200) +
          seoField('ecSeoDesc', 'Search description', '(the grey text under your Google result · ~155 chars)', d.description, 3, 400) +
          '<hr class="ec-ai-hr"><p class="ec-seo-section">When shared on social media</p>' +
          seoField('ecSeoOgTitle', 'Social title', '', d.ogTitle, 0, 200) +
          seoField('ecSeoOgDesc', 'Social description', '', d.ogDescription, 2, 400);
        const ids = ['ecSeoTitle', 'ecSeoDesc', 'ecSeoOgTitle', 'ecSeoOgDesc'];
        const counts = { ecSeoTitle: 60, ecSeoDesc: 155, ecSeoOgTitle: 60, ecSeoOgDesc: 200 };
        ids.forEach((id) => {
          const inp = ov.querySelector('#' + id), c = ov.querySelector('#' + id + 'c');
          const upd = () => { c.textContent = inp.value.length + (counts[id] ? '/' + counts[id] : ''); c.classList.toggle('over', counts[id] && inp.value.length > counts[id]); saveBtn.disabled = false; };
          inp.addEventListener('input', upd); upd();
        });
        saveBtn.disabled = true;
      }).catch(() => { body.textContent = 'Could not load.'; });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const r = await fetch(API + 'seo/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: key,
            title: ov.querySelector('#ecSeoTitle').value,
            description: ov.querySelector('#ecSeoDesc').value,
            ogTitle: ov.querySelector('#ecSeoOgTitle').value,
            ogDescription: ov.querySelector('#ecSeoOgDesc').value,
          }),
        });
        if (!r.ok) throw new Error(await r.text() || r.status);
        close(); saveScroll(); location.reload();
      } catch (err) { msg.textContent = 'Save failed (' + err.message + ')'; saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
  }
  shell.querySelector('#ecSeo').addEventListener('click', openSeo);

  /* one-time welcome tip the first time the owner opens the editor */
  try {
    if (!localStorage.getItem(CFG.storePrefix + 'Welcomed')) {
      const tip = document.createElement('div');
      tip.className = 'ec-welcome';
      tip.innerHTML = '👋 <b>Welcome!</b> Click any text to edit it — or click a photo, button or section and a little menu shows what you can change. Prefer to just ask? Use <b>🪄 Refine</b>. Press <b>💾 Save</b> when done.' +
        '<button type="button" class="ec-welcome-x" id="ecWelcomeOk">Got it</button>';
      shell.insertBefore(tip, shell.querySelector('.ec-stage'));
      tip.querySelector('#ecWelcomeOk').addEventListener('click', () => { tip.remove(); try { localStorage.setItem(CFG.storePrefix + 'Welcomed', '1'); } catch { /* ignore */ } });
    }
  } catch { /* private mode */ }
})();
