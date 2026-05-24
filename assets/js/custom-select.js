/* ════════════════════════════════════════════════════════════════════════
   CUSTOM SELECT — site-wide combobox wrapper for OBS / CEF compatibility
   ════════════════════════════════════════════════════════════════════════

   The problem
   ─────────────────────────────────────────────────────────────────────
   CEF (the Chromium fork that OBS Browser Source ships) has a known bug
   where native <select> popups don't render reliably in cross-origin
   iframes. The popup never opens or renders at wrong coordinates.
   Reproduces on OBS 32.x even with all other workarounds disabled.

   The fix
   ─────────────────────────────────────────────────────────────────────
   For every <select> on the site (except .mobile-nav-select, which is
   hidden on desktop and not a regression vector for OBS streamers), we:

     1. Hide the native <select> (display:none) but leave it in DOM —
        it keeps its full JS API working (.value / .innerHTML / .disabled
        / .options / etc.) so every consumer's existing code is unchanged.
     2. Insert a sibling button + popup <div> that MIRRORS the <select>'s
        state and provides the visible UI.
     3. Wire user interaction back to the native select — option click
        sets <select>.value + dispatches new Event('change') so any
        existing onchange handler (inline attribute OR addEventListener)
        fires normally.

   How the mirror stays in sync
   ─────────────────────────────────────────────────────────────────────
     - MutationObserver on each <select> with childList:true (catches
       innerHTML rebuilds — option list updates) + subtree:true (catches
       individual <option> attribute changes) + attributeFilter:['disabled']
       (catches disabled toggling).
     - Per-instance .value setter override via Object.defineProperty —
       programmatic `sel.value = x` doesn't reflect to an attribute, so
       MutationObserver alone would miss it. Native setter preserved
       via the prototype descriptor.

   Dynamic selects
   ─────────────────────────────────────────────────────────────────────
   Some pages render <select>s inside JS template literals (e.g.,
   my-leagues per-league team sort). A body-level MutationObserver
   (100ms debounce) catches these and wraps them after they're added
   to the DOM. Idempotent via the data-fpts-cs-wrapped marker.

   Opt-out
   ─────────────────────────────────────────────────────────────────────
     - .mobile-nav-select — page navigator; mobile-only, hidden on
       desktop where OBS users actually are.
     - .no-fpts-cs — explicit opt-out for any future case where a page
       deliberately wants the native widget.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  // ── Inject the shared popup CSS once ────────────────────────────────
  var css = [
    '.fpts-cs-wrap { position: relative; min-width: 0; display: inline-block; }',
    '.fpts-cs-btn {',
    '  /* Inherits the original <select> class (e.g. .filter-select,',
    '     .ld-select, .year-select) for font / colors / arrow so the',
    '     button looks visually identical to the native select. */',
    '  width: 100%;',
    '  text-align: left;',
    '  cursor: pointer;',
    '}',
    '.fpts-cs-btn:disabled { opacity: .45; cursor: not-allowed; }',
    '.fpts-cs-popup {',
    '  position: absolute;',
    '  top: calc(100% + 2px);',
    '  left: 0;',
    '  /* Popup grows to fit its widest option (max-content) and is never',
    '     narrower than the button width (min-width: 100%). Hard cap so it',
    '     can\'t bleed off-screen on narrow desktop / mobile. Previous',
    '     `right: 0` constrained popup to button width and truncated long',
    '     option labels (e.g. YEAR dropdown options like 2025 → "20..."). */',
    '  min-width: 100%;',
    '  width: max-content;',
    '  max-width: min(420px, 95vw);',
    '  background: var(--surface);',
    '  border: 1px solid var(--border2);',
    '  max-height: 280px;',
    '  overflow-y: auto;',
    '  z-index: 5000;',
    '  box-shadow: 0 6px 14px rgba(0,0,0,.45);',
    '}',
    '.fpts-cs-popup[hidden] { display: none; }',
    '.fpts-cs-option {',
    '  padding: 8px 12px;',
    '  cursor: pointer;',
    "  font-family: 'Mulish', sans-serif;",
    '  font-size: 12px;',
    '  font-weight: 700;',
    '  color: var(--white);',
    '  border-bottom: 1px solid var(--border);',
    '  white-space: nowrap;',
    '}',
    '.fpts-cs-option:last-child { border-bottom: none; }',
    '.fpts-cs-option:hover { background: var(--surface2); }',
    '.fpts-cs-option[aria-selected="true"] { background: var(--surface2); color: var(--red); }',
  ].join('\n');
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-fpts-custom-select', 'true');
  styleEl.appendChild(document.createTextNode(css));
  (document.head || document.documentElement).appendChild(styleEl);

  // ── Wrap a single <select> ──────────────────────────────────────────
  function wrapSelect(sel) {
    if (sel.hasAttribute('data-fpts-cs-wrapped')) return;
    if (sel.classList.contains('mobile-nav-select')) return;
    if (sel.classList.contains('no-fpts-cs')) return;
    sel.setAttribute('data-fpts-cs-wrapped', 'true');

    // Preserve the original select's inline display style so we can
    // restore it if anything ever needs to (we set display:none to hide).
    sel.style.display = 'none';

    var wrap = document.createElement('div');
    wrap.className = 'fpts-cs-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = (sel.className || '') + ' fpts-cs-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');

    var popup = document.createElement('div');
    popup.className = 'fpts-cs-popup';
    popup.setAttribute('role', 'listbox');
    popup.hidden = true;

    wrap.appendChild(btn);
    wrap.appendChild(popup);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    function sync() {
      var opts = Array.prototype.slice.call(sel.options);
      var cur = opts[sel.selectedIndex];
      btn.textContent = cur ? cur.textContent : '';
      btn.disabled = sel.disabled;
      popup.innerHTML = '';
      opts.forEach(function (opt, i) {
        var item = document.createElement('div');
        item.className = 'fpts-cs-option';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        item.textContent = opt.textContent;
        if (i === sel.selectedIndex) item.setAttribute('aria-selected', 'true');
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          close();
        });
        popup.appendChild(item);
      });
    }
    function open()   { if (!sel.disabled) { popup.hidden = false; btn.setAttribute('aria-expanded', 'true'); } }
    function close()  { popup.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    function toggle() { popup.hidden ? open() : close(); }

    // NB: no stopPropagation on the button click — let the event bubble
    // so the document click handlers on the OTHER wrapped selects fire
    // and close their popups (otherwise opening one popup while another
    // is open leaves both visible).
    btn.addEventListener('click', function () { toggle(); });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    // MutationObserver — catches .innerHTML (childList + subtree for
    // <option> attribute changes) + .disabled toggling.
    new MutationObserver(sync).observe(sel, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['disabled'],
    });

    // Override .value setter on this instance so `sel.value = x`
    // triggers sync(). Native getter/setter preserved.
    var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && desc.get && desc.set) {
      Object.defineProperty(sel, 'value', {
        get: function () { return desc.get.call(this); },
        set: function (v) { desc.set.call(this, v); sync(); },
        configurable: true,
      });
    }

    sync();   // initial render
  }

  // ── Scan the document for any select we haven't wrapped yet ─────────
  function scan() {
    var sels = document.querySelectorAll(
      'select:not([data-fpts-cs-wrapped]):not(.mobile-nav-select):not(.no-fpts-cs)'
    );
    sels.forEach(wrapSelect);
  }

  // ── Wire up: initial scan + body-level observer for dynamic selects ──
  function init() {
    scan();
    // Some pages render <select>s inside JS template literals AFTER
    // DOMContentLoaded (e.g. my-leagues' per-league team-sort dropdown
    // inserted when a league row is expanded). Watch the body for
    // additions and rescan; 100ms debounce keeps the work cheap.
    if (!document.body) return;
    var t = null;
    new MutationObserver(function () {
      if (t) clearTimeout(t);
      t = setTimeout(scan, 100);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
