/* ════════════════════════════════════════════════════════════════════════
   IFRAME SCROLL FIX — shared module
   ════════════════════════════════════════════════════════════════════════

   Problem: when the site is embedded inside a streaming-tool app (or any
   parent that iframes us), the parent page can't reach in and scroll the
   iframe content. Wheel events get trapped by inner scroll containers
   on our pages (e.g. the player-panel drawer's .pp-scroll, my-leagues
   table sections) and never bubble to the iframe document, so users in
   the parent app can't scroll past them.

   Solution: only when running inside an iframe (window.self !== window.top),
   flatten any oversized inner scrollable container to overflow: visible,
   and install a capture-phase wheel handler that manually scrolls the
   document when no scrollable child wants the wheel event.

   Hard guarantee: direct browser visitors (NOT in an iframe) get zero
   behavior change. The first thing this script does is bail if we're not
   embedded. Every site feature that relies on inner scrolling
   (player-panel drawer, my-leagues tables, tiers tables, etc.) is
   completely untouched for normal visits.

   Source spec: user-supplied iframe-compat snippet 2026-05-19.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  // ── IFRAME-ONLY GUARD ─────────────────────────────────────────────────
  // If we're the top-level window (direct browser visit), do nothing.
  // Catches the obvious case + cross-origin parents where window.top
  // access throws SecurityError (treat as "not embedded" defensively).
  try {
    if (window.self === window.top) return;
  } catch (_e) {
    // Cross-origin parent — we ARE embedded. Proceed.
  }

  // ── Inject the overflow-reset CSS ─────────────────────────────────────
  // Forces html/body to be scrollable + flattens common framework wrappers
  // and our own .page / page-wrapper selectors so the iframe's outer
  // document is the scroll surface.
  var css = [
    'html, body {',
    '  overflow-y: auto !important;',
    '  overflow-x: auto !important;',   /* was hidden — now allows horizontal scroll for wide content like the live-draft board */
    '  height: auto !important;',
    '  min-height: 100% !important;',
    '  max-height: none !important;',
    '}',
    '#__next, #root, #app, [data-reactroot] {',
    '  overflow: visible !important;',
    '  height: auto !important;',
    '  min-height: 0 !important;',
    '  max-height: none !important;',
    '}',
    'main, .main, #main,',
    '.container, .layout, .layout-wrapper,',
    '.page, .page-wrapper, .page-content,',
    '[class*="ScrollContainer"], [class*="scroll-container"] {',
    '  overflow: visible !important;',
    '  height: auto !important;',
    '  min-height: 0 !important;',
    '  max-height: none !important;',
    '}'
  ].join('\n');
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-iframe-scroll-fix', 'true');
  styleEl.appendChild(document.createTextNode(css));
  (document.head || document.documentElement).appendChild(styleEl);

  // ── fixContainers: flatten oversized scrollable inner containers ─────
  // Walks divs/main/article/section. Any element with overflow-y of
  // auto/scroll/hidden AND wider than 50% viewport AND taller than 200px
  // gets flipped to overflow: visible so it doesn't trap wheel events.
  function fixContainers() {
    if (!document.body) return;
    document.body.style.overflowY = 'auto';
    document.body.style.overflowX = 'auto';   /* was hidden — match the CSS reset above so the body can scroll horizontally when content overflows */
    document.body.style.height = 'auto';
    document.body.style.maxHeight = 'none';
    document.querySelectorAll('div, main, article, section').forEach(function (el) {
      try {
        var cs = getComputedStyle(el);
        var ov = cs.overflowY;
        if (ov === 'auto' || ov === 'scroll' || ov === 'hidden') {
          var r = el.getBoundingClientRect();
          if (r.width > window.innerWidth * 0.5 && r.height > 200) {
            el.style.overflowY = 'visible';
            el.style.maxHeight = 'none';
            el.style.height = 'auto';
          }
        }
      } catch (_e) { /* ignore unreachable elements */ }
    });
  }

  // ── Wheel handler: scroll the document when no inner child wants it ─
  // Walks up from the element under the cursor (up to 8 hops). If any
  // ancestor is still scrollable in the wheel direction, defer to it.
  // Only if NOTHING wants the wheel event does this preventDefault and
  // window.scrollBy manually — meaning legit inner scrollers (sidebars,
  // tables) keep working.
  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    try {
      var cs = getComputedStyle(el);
      var vScroll = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                    el.scrollHeight > el.clientHeight;
      var hScroll = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
                    el.scrollWidth > el.clientWidth;
      if (vScroll || hScroll) return true;
    } catch (_e) { /* ignore */ }
    return false;
  }
  function onWheel(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var hops = 0;
    while (el && hops < 8) {
      if (isScrollable(el)) {
        var cs = getComputedStyle(el);
        var canScrollY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                         el.scrollHeight > el.clientHeight;
        var canScrollX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
                         el.scrollWidth > el.clientWidth;
        // Defer to this ancestor if it still has room to scroll in the
        // wheel direction — vertical OR horizontal. The draft board is a
        // common horizontal-scrolling case (Shift+Wheel or trackpad).
        if (canScrollY) {
          var atTop    = el.scrollTop === 0;
          var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
          if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
        }
        if (canScrollX) {
          var atLeft  = el.scrollLeft === 0;
          var atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
          if ((e.deltaX < 0 && !atLeft) || (e.deltaX > 0 && !atRight)) return;
        }
      }
      el = el.parentElement;
      hops++;
    }
    e.preventDefault();
    window.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' });
  }
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });

  // ── Middle-click drag-scroll (Windows-style pan) ─────────────────────
  // OBS Browser Source doesn't surface the native middle-click pan/
  // auto-scroll gesture that desktop Chromium ships with. Re-implement
  // it manually so streamers can press the mouse wheel down + drag in
  // any direction to scroll the document. The board on live-draft and
  // wide tables on tiers / my-leagues / adp-tool benefit most.
  var pan = null;
  window.addEventListener('mousedown', function (e) {
    if (e.button !== 1) return;  // middle button only
    e.preventDefault();
    pan = {
      startX: e.clientX,
      startY: e.clientY,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
    };
    document.body.style.cursor = 'all-scroll';
  }, true);
  window.addEventListener('mousemove', function (e) {
    if (!pan) return;
    var dx = e.clientX - pan.startX;
    var dy = e.clientY - pan.startY;
    // Drag-to-scroll convention: drag RIGHT moves content right →
    // viewport scrolls LEFT (so scrollLeft DECREASES). Drag follows
    // the page like a Google-Maps grab.
    window.scrollTo({
      left: pan.scrollX - dx,
      top:  pan.scrollY - dy,
      behavior: 'auto',
    });
  });
  window.addEventListener('mouseup', function (e) {
    if (e.button !== 1 || !pan) return;
    pan = null;
    document.body.style.cursor = '';
  });
  // Suppress the native auxclick fallback (some Chromium builds toggle
  // auto-scroll cursor mode on middle-down, which conflicts with the
  // drag-pan we just installed).
  window.addEventListener('auxclick', function (e) {
    if (e.button === 1) e.preventDefault();
  }, true);

  // ── Wire up ──────────────────────────────────────────────────────────
  // Run fixContainers ASAP, then again at 400ms and 1500ms to catch
  // anything that mounts late (async data render). MutationObserver
  // re-runs after SPA-style URL changes (we don't do SPA routing but
  // this is harmless and matches the source spec).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fixContainers);
  } else {
    fixContainers();
  }
  setTimeout(fixContainers, 400);
  setTimeout(fixContainers, 1500);
  var lastUrl = location.href;
  new MutationObserver(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(fixContainers, 250);
      setTimeout(fixContainers, 1200);
    }
  }).observe(document.documentElement, { subtree: true, childList: true });
})();
