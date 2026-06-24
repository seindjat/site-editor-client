/* ============================================================
   site-editor — bootstrap loader (ships to every page, tiny).
   Reads window.EDITOR_CONFIG, owns the owner password + "currently editing"
   flag, and lazy-loads the heavy editor (editor.js + editor.css + editor-addons.js)
   ONLY for the authenticated owner. Visitors download just this file.

   AUTO-UPDATE: when editorBase points at the shared jsDelivr URL, the loader fetches
   a tiny build id (build.txt, cache-bypassed) and loads the editor files at
   ?b=<build>. Publishing a new editor bumps that build id, so every site picks up
   the new version on the next edit — no per-site change. If build.txt can't be
   fetched (or editorBase is a local path), it falls back to the per-site editorV,
   so local / not-yet-migrated sites keep working unchanged.

   Keyboard: Cmd/Ctrl+E enters edit mode (keeps scroll); Cmd/Ctrl+S = Save;
   Cmd/Ctrl+Z = Undo (when not typing).
   ============================================================ */
(function () {
  var u = window.EDITOR_CONFIG || {};
  var API = (u.apiBase || '/__edit/').replace(/\/*$/, '/');
  var PREFIX = u.storePrefix || 'siteEdit';
  var BASE = u.editorBase || '';                 // path/URL prefix for editor.js/.css/-addons
  var V = u.editorV || (window.EDITOR_V || 1);   // fallback cache-bust version
  var EDIT_KEY = PREFIX + 'EditAuth';
  var EDIT_ACTIVE = PREFIX + 'EditActive';
  var SCROLL_KEY = PREFIX + 'EnterScroll';       // remember reader scroll on entry
  var EDIT_TTL = 30 * 24 * 60 * 60 * 1000;       // remember the password 30 days
  var IS_EDIT_FRAME = new URLSearchParams(location.search).has('editframe');

  function isTyping(doc) {
    var ae = doc && doc.activeElement;
    return !!(ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)));
  }

  /* editor.js reads this global to know which password to send. */
  window.getEditKey = function () {
    try {
      var s = JSON.parse(localStorage.getItem(EDIT_KEY) || 'null');
      if (s && s.pw && s.exp > Date.now()) return s.pw;
      if (s) localStorage.removeItem(EDIT_KEY);
    } catch (e) { /* private mode etc. */ }
    return null;
  };
  function setEditKey(pw) {
    try { localStorage.setItem(EDIT_KEY, JSON.stringify({ pw: pw, exp: Date.now() + EDIT_TTL })); } catch (e) { /* ignore */ }
  }

  /* Save where the reader is right now (as a fraction of page height), so edit
     mode can open at the same spot instead of jumping to the top. */
  function rememberScroll() {
    try {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      sessionStorage.setItem(SCROLL_KEY, max > 0 ? (window.pageYOffset / max).toFixed(4) : '0');
    } catch (e) { /* ignore */ }
  }

  /* Resolve the editor build id ONCE. With a remote editorBase (jsDelivr) fetch
     build.txt bypassing the browser cache so a freshly-published build shows up
     immediately; otherwise (local path, or fetch failure) fall back to editorV. */
  var _buildP = null;
  function getBuild() {
    if (_buildP) return _buildP;
    var fallback = 'v' + V;
    if (!BASE) { _buildP = Promise.resolve(fallback); return _buildP; }
    try {
      _buildP = fetch(BASE + 'build.txt', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (t) { t = (t || '').trim(); return /^[\w.\-]{1,40}$/.test(t) ? t : fallback; })
        .catch(function () { return fallback; });
    } catch (e) { _buildP = Promise.resolve(fallback); }
    return _buildP;
  }
  function urlFor(name, build) { return BASE + name + '?b=' + build; }

  function injectCss(doc, build) {
    if (doc.getElementById('ec-css')) return;
    var l = doc.createElement('link');
    l.id = 'ec-css'; l.rel = 'stylesheet'; l.href = urlFor('editor.css', build);
    doc.head.appendChild(l);
  }

  /* Load the full editor for the signed-in owner: CSS + engine + add-ons. The
     add-ons script self-gates (no-ops unless editing) and waits for the editor UI
     itself, so load order between editor.js and editor-addons.js doesn't matter. */
  function loadEditor(build) {
    injectCss(document, build);
    ['editor.js', 'editor-addons.js'].forEach(function (name) {
      var s = document.createElement('script');
      s.src = urlFor(name, build);
      document.body.appendChild(s);
    });
  }

  /* The page renders inside a device-sized iframe while editing. That inner copy
     loads with ?editframe=1 so it skips building another editor — it just needs the
     editor CSS for the editable / hidden-chrome affordances. */
  if (IS_EDIT_FRAME) {
    document.documentElement.classList.add('ec-frame');
    getBuild().then(function (b) { injectCss(document, b); });

    /* Inside the editing surface: Cmd/Ctrl+S saves; Cmd/Ctrl+Z undoes (unless you
       are mid-typing, where the browser's own text undo should win). Buttons live
       in the parent toolbar. */
    document.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      var k = (e.key || '').toLowerCase();
      if (k !== 's' && k !== 'z') return;
      var pdoc; try { pdoc = window.parent.document; } catch (err) { return; }
      if (k === 's') {
        var sv = pdoc.getElementById('ecSave');
        if (sv) { e.preventDefault(); sv.click(); }
      } else if (k === 'z') {
        if (isTyping(document)) return;
        var un = pdoc.getElementById('ecUndo');
        if (un) { e.preventDefault(); un.click(); }
      }
    });
  }

  /* © button: enter edit mode. Skips the prompt while the 30-day password is remembered.
     Opens the editor IN PLACE — no full-page reload round-trip — so the click feels
     immediate; an "Opening editor…" pill gives instant feedback while the editor files
     download from the CDN (the old reload path looked dead until the editor reappeared,
     which led to repeated clicks). An `arming` guard + the .ec-shell check stop a second
     click from double-loading. */
  var arming = false;
  function showOpening() {
    if (document.getElementById('ec-opening')) return;
    var p = document.createElement('div');
    p.id = 'ec-opening';
    p.textContent = 'Opening editor…';
    p.setAttribute('style',
      'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#111;color:#fff;font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'padding:11px 18px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;');
    document.body.appendChild(p);
    var t0 = Date.now();
    var iv = setInterval(function () {
      if (document.querySelector('.ec-shell') || Date.now() - t0 > 12000) {
        clearInterval(iv); if (p.parentNode) p.parentNode.removeChild(p);
      }
    }, 120);
  }
  function startEditor() {
    sessionStorage.setItem(EDIT_ACTIVE, '1');
    showOpening();
    getBuild().then(loadEditor);
  }
  function enterEditMode() {
    if (arming || document.querySelector('.ec-shell')) return;   /* already opening / open */
    rememberScroll();
    if (window.getEditKey()) { arming = true; startEditor(); return; }
    var pw = window.prompt('Owner password:');
    if (!pw) return;
    arming = true;
    fetch(API + 'auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(function (res) {
      if (!res.ok) { arming = false; alert('Wrong password.'); return; }
      setEditKey(pw); startEditor();
    }).catch(function () { arming = false; alert('Edit service is not reachable.'); });
  }
  var btn = document.getElementById('editModeBtn');
  if (btn) btn.addEventListener('click', enterEditMode);

  /* Top-page keyboard shortcuts:
       Cmd/Ctrl+E → enter edit mode (keeps scroll position)
       Cmd/Ctrl+S → Save changes
       Cmd/Ctrl+Z → Undo (when not typing in a field) */
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'e') {
      if (isTyping(document)) return;
      var b = document.getElementById('editModeBtn');
      if (b) { e.preventDefault(); b.click(); }
    } else if (k === 's') {
      var sv = document.getElementById('ecSave');
      if (sv) { e.preventDefault(); sv.click(); }
    } else if (k === 'z') {
      if (isTyping(document)) return;
      var un = document.getElementById('ecUndo');
      if (un) { e.preventDefault(); un.click(); }
    }
  });

  /* Owner is actively editing in this tab → load the editor on demand. */
  if (sessionStorage.getItem(EDIT_ACTIVE) && window.getEditKey() && !IS_EDIT_FRAME) {
    getBuild().then(loadEditor);
  }
})();
