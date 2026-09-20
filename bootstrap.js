/* ============================================================
   site-editor — bootstrap loader (ships to every page, tiny).
   Reads window.EDITOR_CONFIG, owns the owner password + "currently editing"
   flag, and lazy-loads the heavy editor (editor.js + editor.css + editor-addons.js)
   ONLY for the authenticated owner. Visitors download just this file.

   WHICH EDITOR BUILD LOADS — three sources, in order:
     1. PINNED: EDITOR_CONFIG.editorBuild names an exact build. Deterministic —
        the named build loads the moment this site's config is fetched. Preferred
        for the live fleet; deploy/hardening/bump-loader.py writes it.
     2. AUTO-UPDATE: otherwise, fetch build.txt (cache-bypassed) from editorBase
        and use whatever it names, so publishing reaches every site with no
        per-site change. Convenient, but build.txt is MUTABLE and jsDelivr's
        edges are eventually consistent (observed serving three values in
        minutes, and moving backwards), so arrival time is unpredictable.
     3. FALLBACK: per-site editorV, when build.txt can't be fetched or editorBase
        is a local path — local / not-yet-migrated sites keep working unchanged.
   The editor files themselves load from an IMMUTABLE @<build>/ URL in cases 1-2,
   so whichever build is chosen, its files are internally consistent.

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

  /* ---- client error reporting --------------------------------------------
     "It didn't work" used to leave no trace anywhere we could look: whatever
     broke in the OWNER'S BROWSER — a loader that won't run, a panel that throws,
     a save that dies before it reaches the server — was invisible to the logs,
     the doctor and us. These errors now go to a capped server-side log the
     nightly doctor reads.
     Scope is deliberately narrow: errors from OUR files, or any error raised
     while the owner is actually editing. A visitor's own site errors are not
     our business and would drown the signal. At most a handful per page-load,
     never the same one twice, and every failure in here is swallowed —
     telemetry must never be able to break the page it is watching. */
  var ERR_SEEN = {}, ERR_SENT = 0, ERR_MAX = 5;
  function reportError(msg, src, line, stack) {
    try {
      if (ERR_SENT >= ERR_MAX || !msg) return;
      var ours = /bootstrap\.js|editor\.js|editor-addons\.js/.test(src || '');
      var editing = false;
      try { editing = !!sessionStorage.getItem(EDIT_ACTIVE); } catch (e) { /* ignore */ }
      if (!ours && !editing) return;
      var k = String(msg) + '|' + (src || '') + '|' + (line || '');
      if (ERR_SEEN[k]) return;
      ERR_SEEN[k] = 1; ERR_SENT++;
      fetch(API + 'client-error', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg: String(msg).slice(0, 300),
          src: String(src || '').slice(0, 200),
          line: line || 0,
          url: String(location.href).slice(0, 200),
          stack: String(stack || '').slice(0, 600),
          build: _lastBuild || '',
        }),
        keepalive: true,                 /* still sends if the page is unloading */
      }).catch(function () { /* never surface telemetry failures */ });
    } catch (e) { /* ignore */ }
  }
  window.__ecReport = reportError;       /* editor.js reports its own caught failures */
  window.addEventListener('error', function (e) {
    /* Resource-load failures (a 404 image) arrive as a bare Event with no
       .message — not our concern, and they would swamp the budget. */
    if (e && e.message) reportError(e.message, e.filename, e.lineno, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    if (r) reportError('unhandled rejection: ' + ((r && r.message) || r), '', 0, r && r.stack);
  });

  /* editor.js reads this global to know what credential to send.
     The stored blob holds BOTH: `tok` is a signed, expiring SESSION TOKEN minted
     by /auth — that is what the editor now sends, so the owner's password stops
     travelling in the body of every save/refine/upload. `pw` is still kept
     because the same-origin owner console (chat_server's /console) reads this
     key directly for its single sign-on and only understands the password; when
     the chat engine learns to accept tokens, `pw` can be dropped entirely.
     Token first, password as the fallback — which also means an older cached
     client, or a backend too old to mint tokens, keeps working unchanged. */
  window.getEditKey = function () {
    try {
      var s = JSON.parse(localStorage.getItem(EDIT_KEY) || 'null');
      if (s && (s.tok || s.pw) && s.exp > Date.now()) return s.tok || s.pw;
      if (s) localStorage.removeItem(EDIT_KEY);
    } catch (e) { /* private mode etc. */ }
    return null;
  };
  function setEditKey(pw, tok) {
    try {
      localStorage.setItem(EDIT_KEY, JSON.stringify({
        pw: pw, tok: tok || null, exp: Date.now() + EDIT_TTL,
      }));
    } catch (e) { /* ignore */ }
  }
  /* Slide the session forward without disturbing the stored password. */
  function refreshToken(tok) {
    if (!tok) return;
    try {
      var s = JSON.parse(localStorage.getItem(EDIT_KEY) || 'null') || {};
      s.tok = tok; s.exp = Date.now() + EDIT_TTL;
      localStorage.setItem(EDIT_KEY, JSON.stringify(s));
    } catch (e) { /* ignore */ }
  }
  function clearEditKey() {
    try { localStorage.removeItem(EDIT_KEY); } catch (e) { /* ignore */ }
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
  var _lastBuild = '';                  /* resolved build id, for error reports */
  /* An explicit, per-site PIN: EDITOR_CONFIG.editorBuild names the exact editor
     build this site runs. Validated against the same charset as build.txt so a
     malformed value can never be pasted into a URL. */
  var PIN = /^[\w.\-]{1,40}$/.test(u.editorBuild || '') ? u.editorBuild : '';
  function getBuild() {
    if (_buildP) return _buildP;
    var fallback = 'v' + V;
    /* PINNED — skip build.txt entirely.
       build.txt is a MUTABLE jsDelivr file, and jsDelivr's edges are only
       eventually consistent: we have watched it serve three different values
       within minutes, and go BACKWARDS. That made every deploy land at an
       unpredictable time, and could pair a freshly-fetched bootstrap with a
       stale editor.js. A pin makes it deterministic — the build named in this
       site's config is the build that loads, the moment the config is fetched.
       Resolution order: pin → build.txt (auto-update) → editorV fallback. */
    if (PIN) { _lastBuild = PIN; _buildP = Promise.resolve(PIN); return _buildP; }
    if (!BASE) { _lastBuild = fallback; _buildP = Promise.resolve(fallback); return _buildP; }
    try {
      _buildP = fetch(BASE + 'build.txt', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (t) { t = (t || '').trim(); return /^[\w.\-]{1,40}$/.test(t) ? t : fallback; })
        .catch(function () { return fallback; })
        .then(function (b) { _lastBuild = b; return b; });
    } catch (e) { _lastBuild = fallback; _buildP = Promise.resolve(fallback); }
    return _buildP;
  }
  /* Prefer an IMMUTABLE jsDelivr URL pinned to the build's git tag
     (cdn.jsdelivr.net/gh/user/repo@<build>/editor.js). Immutable refs are never
     edge-stale and give every build a unique URL, so there's no jsDelivr-POP
     mismatch and no browser-cache trap (the bug where ?b= changes but jsDelivr
     keeps serving an old editor.js, since jsDelivr ignores the query for its edge
     cache). Falls back to the mutable ?b= URL for a local editorBase, the editorV
     fallback build, or if the tag 404s (a build.txt from before tagging). */
  function immBase(build) {
    var m = BASE.match(/^(https:\/\/cdn\.jsdelivr\.net\/gh\/[^@/]+\/[^@/]+)\/?$/);
    return (m && build && build !== ('v' + V)) ? (m[1] + '@' + build + '/') : null;
  }
  function mutUrl(name, build) { return BASE + name + '?b=' + build; }
  function urlFor(name, build) { var ib = immBase(build); return ib ? (ib + name) : mutUrl(name, build); }

  function injectCss(doc, build) {
    if (doc.getElementById('ec-css')) return;
    var l = doc.createElement('link');
    l.id = 'ec-css'; l.rel = 'stylesheet'; l.href = urlFor('editor.css', build);
    l.onerror = function () { if (immBase(build)) l.href = mutUrl('editor.css', build); };
    doc.head.appendChild(l);
  }

  /* Load the full editor for the signed-in owner: CSS + engine + add-ons. The
     add-ons script self-gates (no-ops unless editing) and waits for the editor UI
     itself, so load order between editor.js and editor-addons.js doesn't matter.
     If the immutable @tag URL 404s (stale build.txt → an untagged build), retry
     the same file at the mutable ?b= URL so the editor still loads. */
  function loadEditor(build) {
    injectCss(document, build);
    ['editor.js', 'editor-addons.js'].forEach(function (name) {
      var s = document.createElement('script');
      /* CORS, so window.onerror can actually SEE errors thrown in here. Without
         it the browser reports cross-origin script failures as a bare
         "Script error." with no file, line or stack — which is exactly what our
         telemetry recorded on its first real outing, and it is useless. jsDelivr
         serves Access-Control-Allow-Origin: *, so this costs nothing. */
      s.crossOrigin = 'anonymous';
      s.src = urlFor(name, build);
      s.onerror = function () {
        if (!immBase(build)) return;             // already mutable — nothing to fall back to
        var s2 = document.createElement('script');
        s2.crossOrigin = 'anonymous';
        s2.src = mutUrl(name, build);
        document.body.appendChild(s2);
      };
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
  /* ---- Owner sign-in ------------------------------------------------------
     An IN-PAGE dialog, never window.prompt(). prompt() is blocked outright in a
     cross-origin iframe, stays suppressed for the rest of a page-load once the
     browser's "prevent this page from creating more dialogs" box is ticked, and
     is missing from a number of in-app webviews (tapping your own site from a
     social post). Worse, a blocked prompt() THROWS — which left `arming` stuck
     true and made the ✎ and ?edit silently dead until a reload: the 2026-07-05
     "?edit did nothing" symptom, reachable from a second cause. A real dialog
     also gives a MASKED field that a password manager can fill and save, and
     puts failures inline instead of in an alert() the same switch suppresses.
     Every style is inline so no site CSS can hide or break it. */
  var signInEl = null;                            /* the open dialog, if any */
  var signInKeyHandler = null;

  function node(tag, style, attrs) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (attrs) for (var k in attrs) { if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]); }
    return n;
  }

  /* Non-blocking status pill — alert() replacement (alert is suppressed by the
     same "no more dialogs" switch, and blocks the page besides). */
  function toast(msg, ms) {
    try {
      var host = document.body || document.documentElement;
      var t = node('div', 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:min(90vw,420px);background:#111;color:#fff;font:600 14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
        'padding:11px 18px;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35);text-align:center;');
      t.textContent = msg;
      host.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 5000);
    } catch (e) { /* nothing we can do — never throw out of a failure path */ }
  }

  function closeSignIn() {
    try {
      if (signInKeyHandler) document.removeEventListener('keydown', signInKeyHandler, true);
      if (signInEl && signInEl.parentNode) signInEl.parentNode.removeChild(signInEl);
    } catch (e) { /* ignore */ }
    signInEl = null; signInKeyHandler = null;
  }

  /* POST the password. onFail gets a human message; success closes + opens. */
  function authWith(pw, onFail) {
    return fetch(API + 'auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(function (res) {
      if (res.ok) {
        /* Take the session token if this backend mints one; a 204 from an older
           backend just means we carry on with the password. */
        return res.json().catch(function () { return {}; }).then(function (j) {
          setEditKey(pw, j && j.token);
          closeSignIn(); startEditor();
        });
      }
      onFail(res.status === 401
        ? 'That password is not right — try again.'
        : 'Sign-in failed (' + res.status + '). Try again in a moment.');
    /* Two-arg then, NOT a trailing .catch: a trailing catch also swallows
       anything thrown by the success branch above and would then tell an owner
       who just signed in successfully that the service is unreachable. This
       handler covers the network call and nothing else. */
    }, function () {
      onFail('Edit service is not reachable. Check your connection and try again.');
    });
  }

  /* Build + show the dialog. Returns false if the DOM would not cooperate, so
     the caller can fall back. `note` is an optional line above the field. */
  function showSignIn(note) {
    if (signInEl) {                                /* already open — just refocus */
      try { signInEl.querySelector('input[type=password]').focus(); } catch (e) { /* ignore */ }
      return true;
    }
    try {
      var host = document.body || document.documentElement;
      if (!host) return false;

      var back = node('div', 'position:fixed;inset:0;z-index:2147483647;background:rgba(17,17,17,.55);' +
        'display:flex;align-items:center;justify-content:center;padding:20px;' +
        'font:400 15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased;');

      var form = node('form', 'background:#fff;color:#111;width:100%;max-width:340px;box-sizing:border-box;' +
        'border-radius:16px;padding:22px;box-shadow:0 18px 60px rgba(0,0,0,.4);text-align:left;',
        { autocomplete: 'on', novalidate: 'novalidate' });

      var h = node('div', 'font:700 17px/1.3 inherit;margin:0 0 4px;');
      h.textContent = 'Owner sign-in';
      var sub = node('div', 'font-size:13px;color:#666;margin:0 0 14px;');
      sub.textContent = 'Enter your password to edit this page.';

      form.appendChild(h); form.appendChild(sub);

      if (note) {
        var n = node('div', 'font-size:13px;line-height:1.45;color:#8a5300;background:#fff6e5;' +
          'border:1px solid #f2d9a8;border-radius:10px;padding:9px 11px;margin:0 0 12px;');
        n.textContent = note;
        form.appendChild(n);
      }

      /* A username field (off-screen, not display:none — managers ignore hidden
         ones) so password managers will offer to fill AND save this login. */
      var user = node('input', 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;',
        { type: 'text', name: 'username', value: location.hostname, autocomplete: 'username',
          tabindex: '-1', 'aria-hidden': 'true' });
      form.appendChild(user);

      var pw = node('input', 'width:100%;box-sizing:border-box;font:inherit;padding:11px 12px;' +
        'border:1.5px solid #d4d4d4;border-radius:10px;outline:none;background:#fff;color:#111;',
        { type: 'password', name: 'password', autocomplete: 'current-password',
          placeholder: 'Password', 'aria-label': 'Owner password' });
      form.appendChild(pw);

      var err = node('div', 'font-size:13px;line-height:1.45;color:#b3261e;margin:10px 0 0;display:none;');
      err.setAttribute('role', 'alert');
      form.appendChild(err);

      var row = node('div', 'display:flex;gap:8px;margin:16px 0 0;');
      var cancel = node('button', 'flex:0 0 auto;font:600 14px/1 inherit;padding:11px 14px;border-radius:10px;' +
        'border:1.5px solid #d4d4d4;background:#fff;color:#444;cursor:pointer;', { type: 'button' });
      cancel.textContent = 'Cancel';
      var go = node('button', 'flex:1 1 auto;font:600 14px/1 inherit;padding:11px 14px;border-radius:10px;' +
        'border:1.5px solid #111;background:#111;color:#fff;cursor:pointer;', { type: 'submit' });
      go.textContent = 'Sign in';
      row.appendChild(cancel); row.appendChild(go);
      form.appendChild(row);

      back.appendChild(form);
      host.appendChild(back);
      signInEl = back;

      function fail(msg) {
        err.textContent = msg; err.style.display = 'block';
        go.disabled = false; go.textContent = 'Sign in'; go.style.opacity = '1';
        try { pw.focus(); pw.select(); } catch (e) { /* ignore */ }
      }
      function cancelOut() { closeSignIn(); arming = false; }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = pw.value;
        if (!v) { fail('Enter your password.'); return; }
        err.style.display = 'none';
        go.disabled = true; go.textContent = 'Signing in…'; go.style.opacity = '.7';
        authWith(v, fail);
      });
      cancel.addEventListener('click', cancelOut);
      /* Backdrop click closes; clicks inside the card must not. */
      back.addEventListener('mousedown', function (e) { if (e.target === back) cancelOut(); });

      signInKeyHandler = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelOut(); }
      };
      document.addEventListener('keydown', signInKeyHandler, true);

      /* Let the browser paint before focusing — iOS Safari ignores an immediate
         focus() and then never raises the keyboard. */
      setTimeout(function () { try { pw.focus(); } catch (e) { /* ignore */ } }, 30);
      return true;
    } catch (e) {
      closeSignIn();
      return false;
    }
  }

  /* Ask for the password and authenticate. Shared by first sign-in and the
     stale-key recovery path below. Assumes arming is already true. */
  function promptAndAuth(note) {
    if (showSignIn(note || '')) return;
    /* Dialog could not be built at all (no document yet, DOM blocked). Fall back
       to prompt() — guarded, because a blocked prompt() throws. */
    try {
      var pw = window.prompt(note ? note + '\n\nOwner password:' : 'Owner password:');
      if (!pw) { arming = false; return; }
      authWith(pw, function (msg) { arming = false; toast(msg); });
    } catch (e) {
      arming = false;
      toast('Could not open the sign-in box here. Open the site in a normal browser tab and try again.', 8000);
      /* Both the dialog AND prompt() failed — the owner is locked out of this
         browser entirely. That is exactly the failure nobody could ever report,
         so make sure we hear about it. */
      reportError('sign-in unavailable: ' + (e && e.message), 'bootstrap.js', 0, e && e.stack);
    }
  }
  function enterEditMode() {
    if (arming || document.querySelector('.ec-shell')) return;   /* already opening / open */
    rememberScroll();
    arming = true;
    var existing = window.getEditKey();
    if (!existing) { promptAndAuth(); return; }
    /* Revalidate the REMEMBERED key with the server BEFORE opening. The editor used to
       open optimistically on any stored key — so after a password change/reset the
       editor looked signed-in but every save/SEO/refine/chat silently 401'd (the owner
       hit exactly this). Now a stale key is caught here, cleared, and re-prompted. */
    fetch(API + 'auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: existing }),
    }).then(function (res) {
      if (res.ok) {                                        /* remembered key still valid */
        /* Every /auth mints a fresh token, so an owner who keeps editing never
           walks into an expiry. Fire-and-forget; opening must not wait on it. */
        res.json().then(function (j) { refreshToken(j && j.token); }).catch(function () { /* older backend */ });
        startEditor(); return;
      }
      if (res.status === 401) {                             /* password changed → key is stale */
        clearEditKey();
        /* The reason goes INSIDE the dialog we are about to open — one surface,
           and nothing to dismiss before typing. */
        promptAndAuth('Your saved sign-in is no longer valid (the password may have changed). Please sign in again.');
        return;                                             /* arming stays true through the re-prompt */
      }
      arming = false;                                       /* 429 / other — keep the key, let them retry */
      toast('Edit service busy (' + res.status + '). Try again in a moment.');
    }).catch(function () {
      startEditor();                                        /* transient network blip → open optimistically */
    });
  }
  var btn = document.getElementById('editModeBtn');
  if (btn) {
    btn.addEventListener('click', enterEditMode);
    /* Keep the owner's edit affordance clickable even when host chrome (a fixed
       sticky CTA bar, a cookie banner, a chat FAB…) paints over the footer. The
       button is visually transparent to visitors, so lifting it above such
       overlays has no visible effect for them. */
    try {
      if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
      btn.style.zIndex = '2147483000';
    } catch (e) { /* ignore */ }
  }

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

  /* Extension-proof entry: opening the page with ?edit (or #edit) enters edit mode
     directly — reliable when a browser extension hijacks Cmd/Ctrl+E (e.g. the Claude
     for Chrome side panel) or the ✎ is covered/hard to find. Bookmark yoursite.com/?edit.
     It prompts for the owner password just like the ✎, so it's safe to leave public. */
  if (!IS_EDIT_FRAME && (/(?:^|[?&])edit(?:=[^&]*)?(?:&|$)/.test(location.search) || location.hash === '#edit')) {
    enterEditMode();
  }

  /* Owner is actively editing in this tab → load the editor on demand. */
  if (sessionStorage.getItem(EDIT_ACTIVE) && window.getEditKey() && !IS_EDIT_FRAME) {
    getBuild().then(loadEditor);
  }
})();

/* build 20260920-143220 */
