/* ============================================================
   site-editor — bootstrap loader (ships to every page, tiny).
   Reads window.EDITOR_CONFIG, owns the owner password + "currently editing"
   flag, and lazy-loads the heavy editor (editor.js + editor.css) ONLY for the
   authenticated owner. Visitors download just this file and never the editor.

   Add to a site's <head>, before this script:
     <script>window.EDITOR_CONFIG = { apiBase:'/__edit/', editorV: 1, ... }</script>
     <script src="/__editor/bootstrap.js?v=1" defer></script>
   The site's #editModeBtn (a ✎ button) toggles edit mode.
   ============================================================ */
(function () {
  var u = window.EDITOR_CONFIG || {};
  var API = (u.apiBase || '/__edit/').replace(/\/*$/, '/');
  var PREFIX = u.storePrefix || 'siteEdit';
  var BASE = u.editorBase || '';                 // path prefix for editor.js/.css
  var V = u.editorV || (window.EDITOR_V || 1);   // cache-bust version
  var EDIT_KEY = PREFIX + 'EditAuth';
  var EDIT_ACTIVE = PREFIX + 'EditActive';
  var EDIT_TTL = 30 * 24 * 60 * 60 * 1000;       // remember the password 30 days
  var IS_EDIT_FRAME = new URLSearchParams(location.search).has('editframe');

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

  function injectCss(doc) {
    if (doc.getElementById('ec-css')) return;
    var l = doc.createElement('link');
    l.id = 'ec-css'; l.rel = 'stylesheet'; l.href = BASE + 'editor.css?v=' + V;
    doc.head.appendChild(l);
  }

  /* The page renders inside a device-sized iframe while editing. That inner copy
     loads with ?editframe=1 so it skips building another editor — it just needs the
     editor CSS for the editable / hidden-chrome affordances. */
  if (IS_EDIT_FRAME) { document.documentElement.classList.add('ec-frame'); injectCss(document); }

  /* ✎ button: enter edit mode. Skips the prompt while the 30-day password is remembered. */
  var btn = document.getElementById('editModeBtn');
  if (btn) {
    btn.addEventListener('click', function () {
      if (window.getEditKey()) { sessionStorage.setItem(EDIT_ACTIVE, '1'); location.reload(); return; }
      var pw = window.prompt('Owner password:');
      if (!pw) return;
      fetch(API + 'auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      }).then(function (res) {
        if (!res.ok) { alert('Wrong password.'); return; }
        setEditKey(pw); sessionStorage.setItem(EDIT_ACTIVE, '1'); location.reload();
      }).catch(function () { alert('Edit service is not reachable.'); });
    });
  }

  /* Owner is actively editing in this tab → load the editor on demand. */
  if (sessionStorage.getItem(EDIT_ACTIVE) && window.getEditKey() && !IS_EDIT_FRAME) {
    injectCss(document);
    var s = document.createElement('script');
    s.src = BASE + 'editor.js?v=' + V;
    document.body.appendChild(s);
  }
})();
