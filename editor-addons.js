/* Transparent Builder — editor add-ons (TB-local; loads after the CDN editor).
   Adds features on top of the site-editor engine without modifying it.
     • 🩺 Review      — AI copy/SEO/UX review of the current page
     • 📱 Visibility  — show/hide each section per Desktop / Tablet / Phone
     • ✨ AI image    — generate a photo with AI and replace one on the page */
(function () {
  if (new URLSearchParams(location.search).has('editframe')) return;
  var CFG = window.EDITOR_CONFIG || {};
  var PREFIX = CFG.storePrefix || 'siteEdit';
  if (!sessionStorage.getItem(PREFIX + 'EditActive')) return;
  var API = (CFG.apiBase || '/__edit/').replace(/\/*$/, '/');
  var DEVICES = [['desktop', '🖥', 'Desktop'], ['tablet', '▭', 'Tablet'], ['phone', '📱', 'Phone']];

  function key() { try { return window.getEditKey && window.getEditKey(); } catch (e) { return null; } }
  function curPage() {
    /* follow the editor's iframe (the page actually being edited), not the tab URL */
    try { var d = frameDoc(); if (d && d.location) { var n = d.location.pathname.split('/').pop(); if (n && /\.html$/.test(n)) return n; } } catch (e) {}
    try { var f = document.querySelector('iframe'); if (f) { var s = (f.getAttribute('src') || '').split('?')[0].split('/').pop(); if (s && /\.html$/.test(s)) return s; } } catch (e) {}
    return location.pathname.split('/').pop() || 'index.html';
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function frameDoc() { var f = document.querySelector('iframe'); try { return f && f.contentDocument; } catch (e) { return null; } }
  function restoreScroll() {
    /* the loader stored where the owner was when they pressed ⌘E; re-apply it to the
       editing iframe a few times to beat the editor's init reset — but STOP the moment the
       owner scrolls/clicks, so it never fights manual scrolling. */
    var k = PREFIX + 'EnterScroll';
    var f = sessionStorage.getItem(k);
    if (f === null) return;
    sessionStorage.removeItem(k);
    var frac = parseFloat(f) || 0;
    if (frac <= 0.02) return;
    var done = false, attached = false;
    function stop() { done = true; }
    var EVS = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    EVS.forEach(function (ev) { window.addEventListener(ev, stop, { passive: true }); });
    var n = 0;
    var iv = setInterval(function () {
      n++;
      if (done || n > 8) { clearInterval(iv); return; }   // ~3.2s max, or until the user acts
      var ifr = document.querySelector('iframe');
      var w = ifr && ifr.contentWindow, d = ifr && ifr.contentDocument;
      if (d && w && d.documentElement) {
        if (!attached) { attached = true; EVS.forEach(function (ev) { try { d.addEventListener(ev, stop, { passive: true }); } catch (e) {} }); }
        try { d.documentElement.style.scrollBehavior = 'auto'; } catch (e) {}
        var max = d.documentElement.scrollHeight - (ifr.clientHeight || w.innerHeight || 800);
        if (max > 40) w.scrollTo(0, Math.round(frac * max));
      }
    }, 400);
  }
  function selectCurrentPage() {
    /* open the editor on the page the owner is actually viewing (not the default Home) */
    try {
      var sel = document.getElementById('ecPageSel');
      if (!sel) return;
      var want = location.pathname.split('/').pop() || 'index.html';
      var has = [].some.call(sel.options || [], function (o) { return o.value === want; });
      if (has && sel.value !== want) {
        sel.value = want;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (e) {}
  }
  function forceDesktop() {
    /* the engine sometimes opens in a phone/tablet view; default to Desktop once */
    try {
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return /^desktop$/i.test((x.textContent || '').trim()); })[0];
      if (b && !/\b(active|is-active|on|selected)\b/.test(b.className)) b.click();
    } catch (e) {}
  }

  var tries = 0;
  var iv = setInterval(function () {
    if (++tries > 150) { clearInterval(iv); return; }
    var save = document.getElementById('ecSave');
    if (!save) return;
    clearInterval(iv);
    addStyle();
    selectCurrentPage();
    forceDesktop();
    restoreScroll();
    wireImageAI();
    if (!document.getElementById('tbReviewBtn')) inject(save, 'tbReviewBtn', '🩺 Review', 'AI review: copy, SEO & clarity suggestions', runReview);
    if (!document.getElementById('tbVisBtn')) inject(save, 'tbVisBtn', '📱 Visibility', 'Show or hide sections per device', openVis);
    if (!document.getElementById('tbGenBtn')) inject(save, 'tbGenBtn', '✨ AI image', 'Generate a photo with AI and replace one on the page', openGen);
  }, 400);

  function inject(save, id, label, title, fn) {
    var b = document.createElement('button');
    b.id = id; b.type = 'button';
    b.className = (save.className || 'ec-btn').replace(/\bec-save\b/, '').trim() || 'ec-btn';
    b.textContent = label; b.title = title;
    save.parentNode.insertBefore(b, save);
    b.addEventListener('click', fn);
  }

  /* ---------------- 🩺 Review ---------------- */
  function runReview() {
    var k = key(); if (!k) { alert('Please sign in to the editor first.'); return; }
    panel('🩺 Review — ' + curPage(), '<div class="tbpv-spin">Estimating cost…</div>');
    fetch(API + 'cost-estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: k }) })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (c) {
        var est = (c && typeof c.baseUsd === 'number') ? ('≈ $' + c.baseUsd.toFixed(2)) : '≈ a few cents';
        var p = document.getElementById('tbReviewPanel');
        p.querySelector('.tbpv-body').innerHTML =
          '<p>Run an AI review of <b>' + esc(curPage()) + '</b>?</p>' +
          '<p class="tbvz-help">Estimated cost: <b>' + est + '</b> (uses your Claude API key)</p>' +
          '<button id="tbGoReview" class="tbg-run">Run review</button>';
        document.getElementById('tbGoReview').addEventListener('click', doReview);
      })
      .catch(function () { doReview(); });
  }
  function doReview() {
    var k = key();
    panel('🩺 Reviewing “' + curPage() + '” …', '<div class="tbpv-spin">Asking the AI to review this page… (~10–20s)</div>');
    fetch(API + 'ai/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: k, page: curPage() }) })
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); }); })
      .then(function (d) {
        var cost = (typeof d.cost === 'number') ? ('<p class="tbvz-help" style="margin-top:10px">Actual AI cost: $' + d.cost.toFixed(3) + '</p>') : '';
        panel('🩺 Review — ' + (d.page || curPage()), renderMd(d.review || '(no suggestions)') + cost);
      })
      .catch(function (e) { panel('Review failed', '<div style="color:#a83232">' + esc(e.message || e) + '</div>'); });
  }
  function renderMd(md) {
    var lines = String(md).split(/\r?\n/), out = [], inList = false;
    function close() { if (inList) { out.push('</ul>'); inList = false; } }
    lines.forEach(function (line) {
      var t = line.trim(); if (!t) return;
      if (/^#{1,6}\s/.test(t)) { close(); out.push('<h4 class="tbpv-h">' + esc(t.replace(/^#{1,6}\s/, '')) + '</h4>'); }
      else if (/^[-*]\s/.test(t)) { if (!inList) { out.push('<ul class="tbpv-ul">'); inList = true; } out.push('<li>' + esc(t.replace(/^[-*]\s/, '')) + '</li>'); }
      else { close(); out.push('<p>' + esc(t) + '</p>'); }
    });
    close(); return out.join('');
  }

  /* ---------------- 📱 Visibility ---------------- */
  function openVis() {
    var d = frameDoc();
    if (!d) { alert('Open a page in the editor first.'); return; }
    var secs = [].slice.call(d.querySelectorAll('[data-ec-sec]'));
    if (!secs.length) { panel('📱 Visibility', '<p>No sections found on this page.</p>'); return; }
    var rows = secs.map(function (sec) {
      var id = sec.getAttribute('data-ec-sec');
      var h = sec.querySelector('.eyebrow, h1, h2, .s-title, h3');
      var label = (h ? h.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 40) || ('Section ' + id);
      var chips = DEVICES.map(function (dv) {
        var hidden = sec.classList.contains('ec-hide-' + dv[0]);
        return '<button class="tbvz-chip' + (hidden ? ' hidden' : '') + '" data-sec="' + id + '" data-dev="' + dv[0] + '" title="' + (hidden ? 'HIDDEN' : 'Shown') + ' on ' + dv[2] + ' — click to toggle">' + dv[1] + '</button>';
      }).join('');
      return '<div class="tbvz-row"><span class="tbvz-label" data-sec="' + id + '">' + esc(label) + '</span><span class="tbvz-chips">' + chips + '</span></div>';
    }).join('');
    panel('📱 Section visibility — ' + curPage(),
      '<p class="tbvz-help">Gold = hidden on that screen size. Saves instantly.</p>' + rows +
      '<p class="tbvz-help" style="margin-top:10px">🖥 Desktop · ▭ Tablet · 📱 Phone</p>');
    var p = document.getElementById('tbReviewPanel');
    p.querySelectorAll('.tbvz-chip').forEach(function (chip) { chip.addEventListener('click', onToggle); });
    p.querySelectorAll('.tbvz-label').forEach(function (lb) { lb.addEventListener('mouseenter', function () { flash(lb.getAttribute('data-sec')); }); });
  }
  function flash(secId) {
    var d = frameDoc(); if (!d) return;
    var sec = d.querySelector('[data-ec-sec="' + secId + '"]'); if (!sec) return;
    try { sec.scrollIntoView({ block: 'start' }); var o = sec.style.outline; sec.style.outline = '3px solid #B68A3E'; setTimeout(function () { sec.style.outline = o; }, 700); } catch (e) {}
  }
  function onToggle(e) {
    var chip = e.currentTarget, k = key();
    if (!k) { alert('Sign in first.'); return; }
    var secId = chip.getAttribute('data-sec'), dev = chip.getAttribute('data-dev');
    var willHide = !chip.classList.contains('hidden');
    chip.disabled = true;
    fetch(API + 'section-visibility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: k, page: curPage(), sec: secId, device: dev, hidden: willHide }) })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); }); return r.json(); })
      .then(function () {
        chip.classList.toggle('hidden', willHide);
        chip.title = (willHide ? 'HIDDEN' : 'Shown') + ' on ' + dev + ' — click to toggle';
        var d = frameDoc(); var sec = d && d.querySelector('[data-ec-sec="' + secId + '"]');
        if (sec) sec.classList.toggle('ec-hide-' + dev, willHide);
        chip.disabled = false;
      })
      .catch(function (err) { chip.disabled = false; alert('Could not save: ' + (err.message || err)); });
  }

  /* ---------------- ✨ AI image ---------------- */
  function openGen() {
    var d = frameDoc();
    if (!d) { alert('Open a page in the editor first.'); return; }
    var seen = {}, items = [];
    [].slice.call(d.querySelectorAll('img')).forEach(function (im) {
      var src = im.getAttribute('src') || '';
      if (!/assets\//.test(src)) return;
      var f = src.split('?')[0].split('/').pop();
      if (f && !seen[f]) { seen[f] = 1; items.push({ file: f, w: im.naturalWidth, h: im.naturalHeight, src: src }); }
    });
    var thumbs = items.map(function (it, i) { return '<button class="tbg-thumb" data-i="' + i + '" title="' + esc(it.file) + '"><img src="' + esc(it.src) + '" loading="lazy"></button>'; }).join('');
    panel('✨ AI image — ' + curPage(),
      '<p class="tbvz-help">1 · Pick the photo to replace</p>' +
      '<div class="tbg-grid">' + (thumbs || '<span class="tbvz-help">No replaceable photos on this page.</span>') + '</div>' +
      '<p class="tbvz-help" style="margin-top:12px">2 · Describe the new image</p>' +
      '<textarea id="tbgPrompt" class="tbg-ta" placeholder="e.g. bright modern kitchen, white marble waterfall island, warm evening light"></textarea>' +
      '<p class="tbvz-help" style="margin:6px 0 0">Cost: ≈ $0.03 per image (AI generation)</p>' +
      '<button id="tbgRun" class="tbg-run" disabled>✨ Generate &amp; replace</button>' +
      '<div id="tbgStatus" class="tbvz-help" style="margin-top:8px"></div>');
    var p = document.getElementById('tbReviewPanel');
    var sel = { i: null };
    var ta = document.getElementById('tbgPrompt');
    var run = document.getElementById('tbgRun');
    function refresh() { run.disabled = !(sel.i !== null && ta.value.trim().length > 2); }
    p.querySelectorAll('.tbg-thumb').forEach(function (btn) {
      btn.addEventListener('click', function () {
        p.querySelectorAll('.tbg-thumb').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on'); sel.i = +btn.getAttribute('data-i'); refresh();
      });
    });
    ta.addEventListener('input', refresh);
    run.addEventListener('click', function () {
      if (sel.i === null) return;
      var it = items[sel.i];
      doGen(it.file, ta.value.trim(), it.w, it.h, run, document.getElementById('tbgStatus'), p);
    });
  }

  /* generate + replace one image (shared by the panel picker and the click-an-image flow) */
  function doGen(file, prompt, w, h, run, st, panelEl) {
    var k = key();
    if (!k || !file || (prompt || '').trim().length < 3) return;
    run.disabled = true; st.innerHTML = '<span class="tbpv-spin">Generating with AI… (about 10–40s)</span>';
    fetch(API + 'ai/genimage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: k, target: file, prompt: prompt.trim(), w: w || 0, h: h || 0 }) })
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); }); })
      .then(function (res) {
        st.innerHTML = '<span style="color:#3a5a40">Replaced ✓</span>';
        var d2 = frameDoc();
        if (d2) [].slice.call(d2.querySelectorAll('img')).forEach(function (im) {
          if ((im.getAttribute('src') || '').split('?')[0].split('/').pop() === file) im.src = res.src;
        });
        if (panelEl) { var th = panelEl.querySelector('.tbg-thumb.on img'); if (th) th.src = res.src; }
        run.disabled = false;
      })
      .catch(function (e) { st.innerHTML = '<span style="color:#a83232">' + esc(e.message || e) + '</span>'; run.disabled = false; });
  }

  /* AI panel pre-targeted to one image (opened from clicking a photo on the page) */
  function openGenFor(file) {
    var d = frameDoc(), w = 0, h = 0;
    if (d) { var im = [].slice.call(d.querySelectorAll('img')).filter(function (x) { return (x.getAttribute('src') || '').split('?')[0].split('/').pop() === file; })[0]; if (im) { w = im.naturalWidth; h = im.naturalHeight; } }
    panel('✨ AI image — ' + file,
      '<p class="tbvz-help">Replacing <b>' + esc(file) + '</b> with an AI-generated photo.</p>' +
      '<textarea id="tbgPrompt" class="tbg-ta" placeholder="Describe the new image… e.g. modern open-plan living room, floor-to-ceiling windows, warm light"></textarea>' +
      '<p class="tbvz-help" style="margin:6px 0 0">Cost: ≈ $0.03 per image (AI generation)</p>' +
      '<button id="tbgRun" class="tbg-run" disabled>✨ Generate &amp; replace</button>' +
      '<div id="tbgStatus" class="tbvz-help" style="margin-top:8px"></div>');
    var run = document.getElementById('tbgRun'), ta = document.getElementById('tbgPrompt');
    ta.addEventListener('input', function () { run.disabled = ta.value.trim().length < 3; });
    run.addEventListener('click', function () { doGen(file, ta.value, w, h, run, document.getElementById('tbgStatus'), null); });
    ta.focus();
  }

  /* add a "✨ AI image" entry to the editor's click-an-element context menu, for images */
  var aiWiredDoc = null, lastImgFile = null;
  function wireImageAI() {
    var ifr = document.querySelector('iframe');
    if (!ifr) { setTimeout(wireImageAI, 300); return; }   // wait for the editor to build its frame
    function attach() {
      try { var d = ifr.contentDocument; if (d && d !== aiWiredDoc) { aiWiredDoc = d; d.addEventListener('click', onImgClick, true); } } catch (e) {}
    }
    ifr.addEventListener('load', attach);   // re-attach on every page/preview (re)load — no forever-poll
    attach();                                // and the doc that's already there
  }
  function onImgClick(e) {
    var img = e.target && e.target.closest && e.target.closest('img');
    if (!img) return;
    var file = (img.getAttribute('src') || '').split('?')[0].split('/').pop();
    if (!/\.(jpe?g|png|webp)$/i.test(file)) return;   // skip SVG icons etc.
    lastImgFile = file;
    setTimeout(injectCtxAI, 140);   // let the editor build its .ec-ctx menu first
  }
  function injectCtxAI() {
    if (!lastImgFile) return;
    var ctx = document.querySelector('.ec-ctx'); if (!ctx) return;
    var existing = ctx.querySelector('.tb-ctx-ai');
    if (existing) { existing.setAttribute('data-file', lastImgFile); return; }
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ec-ctx-btn tb-ctx-ai'; b.textContent = '✨ AI image';
    b.setAttribute('data-file', lastImgFile);
    b.addEventListener('click', function (ev) { ev.stopPropagation(); openGenFor(b.getAttribute('data-file')); });
    ctx.appendChild(b);
  }

  /* ---------------- shared panel ---------------- */
  function panel(title, bodyHtml) {
    addStyle();
    var p = document.getElementById('tbReviewPanel');
    if (!p) {
      p = document.createElement('div'); p.id = 'tbReviewPanel';
      p.innerHTML = '<div class="tbpv-head"><span class="tbpv-title"></span><button class="tbpv-x" type="button" aria-label="Close">&times;</button></div><div class="tbpv-body"></div>';
      document.body.appendChild(p);
      p.querySelector('.tbpv-x').addEventListener('click', function () { p.remove(); });
      makeDraggable(p, p.querySelector('.tbpv-head'));
    }
    p.querySelector('.tbpv-title').textContent = title;
    p.querySelector('.tbpv-body').innerHTML = bodyHtml;
  }
  function makeDraggable(p, handle) {
    if (!handle) return;
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('.tbpv-x')) return;        // not when clicking the close button
      var r = p.getBoundingClientRect();
      p.style.left = r.left + 'px'; p.style.top = r.top + 'px';
      p.style.right = 'auto'; p.style.bottom = 'auto';
      var sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
      e.preventDefault();
      /* attach move/up only WHILE dragging and remove on release, so closing + reopening
         the panel never piles up permanent document listeners */
      function move(ev) {
        var nx = Math.max(4, Math.min(window.innerWidth - 80, ox + (ev.clientX - sx)));
        var ny = Math.max(4, Math.min(window.innerHeight - 30, oy + (ev.clientY - sy)));
        p.style.left = nx + 'px'; p.style.top = ny + 'px';
      }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  function addStyle() {
    if (document.getElementById('tbpv-css')) return;
    var s = document.createElement('style'); s.id = 'tbpv-css';
    s.textContent =
      '#tbReviewPanel{position:fixed;right:18px;bottom:18px;width:400px;max-height:78vh;background:#fff;border:1px solid #d8c9ad;border-radius:12px;box-shadow:0 18px 50px -16px rgba(0,0,0,.45);z-index:2147483600;display:flex;flex-direction:column;font:14px/1.55 -apple-system,Segoe UI,Helvetica,sans-serif;color:#2B2620;overflow:hidden}'
      + '#tbReviewPanel .tbpv-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:#2B2620;color:#fbf3e5}'
      + '#tbReviewPanel .tbpv-title{font-weight:600;font-size:13px}'
      + '#tbReviewPanel .tbpv-x{background:none;border:none;color:#fbf3e5;font-size:22px;line-height:1;cursor:pointer;padding:0 2px}'
      + '#tbReviewPanel .tbpv-body{padding:12px 16px;overflow:auto}'
      + '#tbReviewPanel .tbpv-h{margin:14px 0 4px;font-size:12px;color:#8A6A2E;text-transform:uppercase;letter-spacing:.6px;font-weight:700}'
      + '#tbReviewPanel .tbpv-h:first-child{margin-top:0}'
      + '#tbReviewPanel .tbpv-ul{margin:0 0 6px;padding-left:18px}'
      + '#tbReviewPanel li{margin:5px 0}'
      + '#tbReviewPanel .tbpv-spin{color:#6E6557}'
      + '#tbReviewPanel .tbvz-help{font-size:12px;color:#6E6557;margin:0 0 8px}'
      + '#tbReviewPanel .tbvz-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #efe7d7}'
      + '#tbReviewPanel .tbvz-label{font-size:13px;cursor:default;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '#tbReviewPanel .tbvz-chips{display:flex;gap:6px;flex:none}'
      + '#tbReviewPanel .tbvz-chip{position:relative;width:30px;height:28px;border:1px solid #d8c9ad;background:#fff;border-radius:7px;cursor:pointer;font-size:14px;line-height:1}'
      + '#tbReviewPanel .tbvz-chip.hidden{opacity:.45;border-color:#c2542e;background:#fbece7}'
      + '#tbReviewPanel .tbvz-chip.hidden::after{content:"\\2715";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c2542e;font-weight:700;font-size:16px}'
      + '#tbReviewPanel .tbg-grid{display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow:auto;padding:2px}'
      + '#tbReviewPanel .tbg-thumb{padding:0;border:2px solid transparent;border-radius:8px;cursor:pointer;background:none;width:78px;height:58px;overflow:hidden}'
      + '#tbReviewPanel .tbg-thumb img{width:100%;height:100%;object-fit:cover;display:block;border-radius:6px}'
      + '#tbReviewPanel .tbg-thumb.on{border-color:#B68A3E}'
      + '#tbReviewPanel .tbg-ta{width:100%;min-height:64px;border:1px solid #d8c9ad;border-radius:8px;padding:8px 10px;font:inherit;resize:vertical}'
      + '#tbReviewPanel .tbg-run{margin-top:8px;width:100%;padding:10px;border:none;border-radius:8px;background:#B68A3E;color:#241d10;font-weight:600;cursor:pointer}'
      + '#tbReviewPanel .tbg-run:disabled{opacity:.5;cursor:default}';
    document.head.appendChild(s);
  }
})();

/* build 20260706-213815 */
