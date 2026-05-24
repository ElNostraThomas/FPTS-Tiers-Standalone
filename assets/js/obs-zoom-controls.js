/* ════════════════════════════════════════════════════════════════════════
   OBS ZOOM CONTROLS — shared floating widget for OBS Browser Source
   ════════════════════════════════════════════════════════════════════════

   OBS Browser Source's Interactive mode doesn't forward Ctrl+wheel or
   Ctrl+plus/minus to the iframed page — streamers have no in-band way to
   zoom the site. This widget renders a tiny top-right pill with
   [ − ]  zoom%  [ + ]  ⟲  so the streamer can step body { zoom } up/down
   or reset to the adaptive default in brand.css.

   Hard guarantee: only renders when iframed (window.self !== window.top).
   Direct browser visitors (desktop AND mobile) see nothing.

   History: a mobile-direct-browser branch was added in commit abf4d72
   then reverted in commit (this one) after a mobile user reported the
   widget broke native pinch-zoom + scroll. CSS `body { zoom: N }` is a
   non-standard property and composes poorly with mobile browsers' native
   pinch + smooth-scroll machinery — the moment we set inline body zoom
   from JS, iOS Safari / mobile Chrome stop recognizing pinch gestures
   until full reload. Native pinch-zoom works fine on mobile (viewport
   meta allows it — no user-scalable=no restriction), so the widget is
   a net regression there. Reverted to OBS-only.

   Mounted on document.documentElement (NOT document.body) so the widget
   itself doesn't visually scale when body { zoom } changes. CSS vars
   (--red, --white, etc.) still resolve because they're declared on :root
   (which IS the html element).

   Zoom ladder: 1.0 / 1.25 / 1.5 / 1.75 / 2.0. Override persists in
   localStorage('fpts-obs-zoom'); reset clears it and restores brand.css's
   @media adaptive default.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  // ── IFRAME-ONLY GUARD ─────────────────────────────────────────────────
  // OBS Browser Source = iframed context. Direct browser visitors (desktop
  // AND mobile) bail. Mobile was previously included (abf4d72) but the
  // widget broke native pinch-zoom + scroll on mobile browsers — see the
  // doc comment above for the full history. Native pinch-zoom is the
  // right mechanism on mobile.
  // Cross-origin parents throw SecurityError on window.top access — treat
  // as "embedded" and fall through (same pattern as iframe-scroll-fix.js).
  try {
    if (window.self === window.top) return;
  } catch (_e) {
    // Cross-origin parent — we ARE embedded. Proceed.
  }

  var STORAGE_KEY = 'fpts-obs-zoom';
  var LADDER = [1.0, 1.25, 1.5, 1.75, 2.0];

  // ── Persistence + zoom application ────────────────────────────────────
  function readOverride() {
    try {
      var v = parseFloat(localStorage.getItem(STORAGE_KEY));
      if (isFinite(v) && v > 0) return v;
    } catch (_e) {}
    return null;
  }
  function saveOverride(v) {
    try {
      if (v == null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(v));
    } catch (_e) {}
  }
  function applyZoom(v) {
    if (!document.body) return;
    // Empty string removes the inline declaration entirely, restoring
    // the brand.css @media adaptive default cascade.
    document.body.style.zoom = (v == null) ? '' : String(v);
  }
  function effectiveZoom() {
    // Current applied zoom — override if set, else read what brand.css's
    // @media adaptive rule resolved to via getComputedStyle.
    var override = readOverride();
    if (override != null) return override;
    try {
      var v = parseFloat(getComputedStyle(document.body).zoom);
      if (isFinite(v) && v > 0) return v;
    } catch (_e) {}
    return 1.0;
  }
  function nearestLadderIndex(v) {
    var best = 0;
    var bestDist = Math.abs(LADDER[0] - v);
    for (var i = 1; i < LADDER.length; i++) {
      var d = Math.abs(LADDER[i] - v);
      if (d < bestDist) { best = i; bestDist = d; }
    }
    return best;
  }
  function stepZoom(delta) {
    var idx = nearestLadderIndex(effectiveZoom());
    var nextIdx = Math.max(0, Math.min(LADDER.length - 1, idx + delta));
    var v = LADDER[nextIdx];
    saveOverride(v);
    applyZoom(v);
    render();
  }
  function resetZoom() {
    saveOverride(null);
    applyZoom(null);
    render();
  }

  // ── Widget construction ───────────────────────────────────────────────
  var widget;

  function makeBtn(label, title, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    Object.assign(b.style, {
      width: '28px',
      height: '28px',
      borderRadius: '50%',
      border: 'none',
      background: 'transparent',
      color: 'var(--white)',
      fontFamily: "'Kanit', sans-serif",
      fontSize: '16px',
      fontWeight: '800',
      lineHeight: '1',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      transition: 'background .15s, color .15s',
    });
    b.addEventListener('mouseenter', function () {
      b.style.background = 'var(--red)';
      b.style.color = '#111111';
    });
    b.addEventListener('mouseleave', function () {
      b.style.background = 'transparent';
      b.style.color = 'var(--white)';
      render();   // re-apply reset-button dim styling if applicable
    });
    b.addEventListener('click', onClick);
    return b;
  }

  function createWidget() {
    var w = document.createElement('div');
    w.id = 'fpts-obs-zoom-controls';
    Object.assign(w.style, {
      position: 'fixed',
      top: '70px',
      right: '18px',
      zIndex: '150',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 6px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '999px',
      boxShadow: '0 4px 12px rgba(0,0,0,.4)',
      fontFamily: "'Mulish', sans-serif",
      fontSize: '12px',
      color: 'var(--white)',
      userSelect: 'none',
    });

    var minus = makeBtn('−', 'Zoom out', function () { stepZoom(-1); });

    var readout = document.createElement('span');
    readout.id = 'fpts-obs-zoom-readout';
    Object.assign(readout.style, {
      minWidth: '44px',
      textAlign: 'center',
      fontFamily: "'Kanit', sans-serif",
      fontWeight: '800',
      fontStyle: 'italic',
      fontSize: '13px',
      padding: '0 4px',
    });

    var plus  = makeBtn('+', 'Zoom in', function () { stepZoom(1); });
    var reset = makeBtn('⟲', 'Reset zoom to adaptive default', resetZoom);
    reset.id = 'fpts-obs-zoom-reset';

    w.appendChild(minus);
    w.appendChild(readout);
    w.appendChild(plus);
    w.appendChild(reset);
    return w;
  }

  function render() {
    if (!widget) return;
    var override = readOverride();
    var cur = effectiveZoom();
    var readout = widget.querySelector('#fpts-obs-zoom-readout');
    if (readout) {
      readout.textContent = Math.round(cur * 100) + '%';
      readout.style.color = (override != null) ? 'var(--red)' : 'rgba(255,255,255,.55)';
    }
    var reset = widget.querySelector('#fpts-obs-zoom-reset');
    if (reset) {
      reset.style.opacity = (override != null) ? '1' : '.35';
      reset.style.cursor  = (override != null) ? 'pointer' : 'default';
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    if (document.getElementById('fpts-obs-zoom-controls')) return;   // idempotent
    var stored = readOverride();
    if (stored != null) applyZoom(stored);   // restore persisted override
    widget = createWidget();
    // Mount on documentElement (NOT body). If we mounted on body, the
    // widget itself would visually scale every time body { zoom } changes
    // — clicking [+] would inflate the buttons along with the page content.
    (document.documentElement || document.body).appendChild(widget);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
