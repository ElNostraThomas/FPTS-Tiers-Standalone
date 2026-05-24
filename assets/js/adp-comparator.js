/* ═══════════════════════════════════════════════════════════════════════════
   ADP COMPARATOR — shared month-to-month ADP comparison helpers
   ───────────────────────────────────────────────────────────────────────────
   Public API on window.AdpComparator:

     init({ storageKey, onChange })  Configure for the host page.
                                       storageKey: localStorage key for the
                                         saved compare-month (e.g. 'fpts-
                                         tiers-compare-month').
                                       onChange: callback fired AFTER the
                                         user picks a new month — host page
                                         should re-overlay + re-render.

     buildMonthIndex()                Rebuild the flat per-month lookup from
                                       every loaded year payload.

     ensureYearLoaded(year)           Lazy-fetch data/adp-{year}.json (or
                                       data/adp.json for the current
                                       season). Resolves immediately if
                                       cached. Adds to YEAR_CACHE +
                                       rebuilds MONTH_INDEX on success.

     getMonthBucket(ym)               Returns MONTH_INDEX[ym] (or undefined).
     getCurrentMonth()                Returns the active "YYYY-MM" anchor.
     setCurrentMonth(ym)              Programmatic setter (also persists +
                                       fires onChange).

     renderTriggerHtml()              Returns the <button> markup the host
                                       page embeds in its <th>. Clicking it
                                       opens the calendar popup.

     openCalendar(triggerEl)          Open popup, positioned beneath the
                                       given trigger element.
     closeCalendar()                  Hide popup.

     changeChipHtml(current, prev)    Pure helper — returns the ▲/▼/● chip
                                       markup for a (current, previous) ADP
                                       pair. Matches adp-tool's .trend
                                       palette (#66dd84 / var(--red) /
                                       white text-shadow stroke).

   Architecture notes:
   - YEAR_CACHE is module-private — each year's payload cached once per
     session. The current-season payload is seeded from window.ADP_PAYLOAD
     on first init() call.
   - MONTH_INDEX is a flat { "YYYY-MM": bucket } merged across every
     cached year. Bucket shape: { startup_sf: [...], startup_1qb: [...] }.
   - Single popup mounted at document.body on first openCalendar() call.
     Host pages with grouped views can have many trigger buttons that all
     reference the same popup.
   - CSS injected once into <head> on first init() — no separate CSS file
     needed. Selectors prefixed adp-cmp-* to avoid collision with any
     legacy tier-cal-* selectors during cutover.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── private state ─────────────────────────────────────────────────────
  let _initialized = false;
  let _storageKey  = 'fpts-adp-compare-month';   // overridden by host
  let _onChange    = function () {};

  let _currentMonth = null;          // "YYYY-MM" the host is comparing against
  let _viewYear     = null;          // year shown in the open popup
  let YEAR_CACHE    = Object.create(null);   // { 2024: <adp-2024.json>, ... }
  let MONTH_INDEX   = Object.create(null);   // { "YYYY-MM": bucket }
  const MIN_YEAR    = 2022;          // historical lower bound (matches adp-tool)

  const MONTH_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const MONTH_LABEL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── helpers ───────────────────────────────────────────────────────────
  function _currentSeason() {
    return Number(window.ADP_PAYLOAD && window.ADP_PAYLOAD.season) || new Date().getFullYear();
  }

  function _formatMonthLabel(ym) {
    if (!ym || typeof ym !== 'string') return ym || '';
    const m = ym.match(/^(\d{4})-(\d{2})$/);
    if (!m) return ym;
    return (MONTH_LABEL[parseInt(m[2], 10) - 1] || m[2]) + ' ' + m[1];
  }

  function _seedCurrentYear() {
    const season = _currentSeason();
    if (season && window.ADP_PAYLOAD && !YEAR_CACHE[season]) {
      YEAR_CACHE[season] = window.ADP_PAYLOAD;
    }
  }

  function _initCurrentMonthFromStorage() {
    // Pick the saved month if it's still in MONTH_INDEX, else default to the
    // second-newest available (i.e. the most-recent prior month after
    // dropping the "now" anchor).
    let saved = null;
    try { saved = localStorage.getItem(_storageKey); } catch (e) {}
    const months = Object.keys(MONTH_INDEX).sort().reverse();
    const compareOptions = months.slice(1);   // drop newest (that IS "current")
    if (!compareOptions.length) { _currentMonth = null; return; }
    _currentMonth = (saved && compareOptions.includes(saved))
      ? saved
      : compareOptions[0];
  }

  // ── data plumbing ─────────────────────────────────────────────────────
  function buildMonthIndex() {
    MONTH_INDEX = Object.create(null);
    for (const year of Object.keys(YEAR_CACHE)) {
      const payload = YEAR_CACHE[year];
      if (!payload || !payload.byMonth) continue;
      for (const m of Object.keys(payload.byMonth)) {
        if (m === 'ALL') continue;
        // Later loads win if month keys collide (cross-year edge slop).
        MONTH_INDEX[m] = payload.byMonth[m];
      }
    }
  }

  function ensureYearLoaded(year) {
    if (YEAR_CACHE[year]) return Promise.resolve();
    const url = (year === _currentSeason())
      ? 'data/adp.json'
      : 'data/adp-' + year + '.json';
    const status = document.getElementById('adp-cmp-status');
    if (status) { status.hidden = false; status.textContent = 'Loading ' + year + '…'; }
    const _v = '?v=' + (window.__DATA_VERSION || Date.now());
    return fetch(url + _v)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(payload => {
        YEAR_CACHE[year] = payload;
        buildMonthIndex();
        if (status) status.hidden = true;
      })
      .catch(err => {
        if (status) { status.hidden = false; status.textContent = 'Failed to load ' + year; }
        console.warn('[adp-comparator] failed to load year', year, err);
      });
  }

  function getMonthBucket(ym) {
    return ym ? MONTH_INDEX[ym] : null;
  }

  function getCurrentMonth() {
    return _currentMonth;
  }

  function setCurrentMonth(ym) {
    if (!ym) return;
    _currentMonth = ym;
    try { localStorage.setItem(_storageKey, ym); } catch (e) {}
    try { _onChange(ym); } catch (e) { console.warn('[adp-comparator] onChange threw', e); }
  }

  // ── trigger + chip markup helpers ─────────────────────────────────────
  function renderTriggerHtml() {
    const label = _currentMonth ? _formatMonthLabel(_currentMonth) : '—';
    return '<button type="button" class="adp-cmp-trigger"'
         +   ' onclick="event.stopPropagation(); window.AdpComparator.openCalendar(this)"'
         +   ' aria-label="Pick ADP comparison month">'
         +   '<span class="adp-cmp-label">' + label + '</span>'
         +   '<span class="adp-cmp-chevron">▾</span>'
         + '</button>';
  }

  function changeChipHtml(current, previous) {
    const c = parseFloat(current), p = parseFloat(previous);
    if (!isFinite(c) || !isFinite(p)) return '';
    const delta = c - p;
    const abs   = Math.abs(delta);
    if (abs < 0.05) return '<span class="adp-cmp-chip flat" title="No change">●</span>';
    const label = abs.toFixed(1);
    const tip = 'ADP ' + (delta < 0 ? 'improved' : 'slipped')
              + ' from ' + p.toFixed(1) + ' to ' + c.toFixed(1);
    if (delta < 0) {
      return '<span class="adp-cmp-chip up" title="' + tip + '">'
           + '<span class="adp-cmp-arrow">▲</span>' + label + '</span>';
    }
    return '<span class="adp-cmp-chip down" title="' + tip + '">'
         + '<span class="adp-cmp-arrow">▼</span>' + label + '</span>';
  }

  // ── calendar popup ────────────────────────────────────────────────────
  function _mountPopup() {
    if (document.getElementById('adp-cmp-popup')) return;
    const pop = document.createElement('div');
    pop.id = 'adp-cmp-popup';
    pop.className = 'adp-cmp-popup';
    pop.hidden = true;
    pop.innerHTML =
        '<div class="adp-cmp-header">'
      +   '<button type="button" class="adp-cmp-nav" id="adp-cmp-prev" aria-label="Previous year">◀</button>'
      +   '<span class="adp-cmp-year" id="adp-cmp-year-label">—</span>'
      +   '<button type="button" class="adp-cmp-nav" id="adp-cmp-next" aria-label="Next year">▶</button>'
      + '</div>'
      + '<div class="adp-cmp-grid" id="adp-cmp-grid"></div>'
      + '<div class="adp-cmp-status" id="adp-cmp-status" hidden></div>';
    document.body.appendChild(pop);

    document.getElementById('adp-cmp-prev').addEventListener('click', () => _navYear(-1));
    document.getElementById('adp-cmp-next').addEventListener('click', () => _navYear( 1));

    document.addEventListener('click', (e) => {
      if (pop.hidden) return;
      if (pop.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.adp-cmp-trigger')) return;
      closeCalendar();
    });
    document.addEventListener('keydown', (e) => {
      if (!pop.hidden && e.key === 'Escape') closeCalendar();
    });
    window.addEventListener('scroll', () => { if (!pop.hidden) closeCalendar(); }, { passive: true });
  }

  function openCalendar(triggerEl) {
    _mountPopup();
    const pop = document.getElementById('adp-cmp-popup');
    if (!pop.hidden) { closeCalendar(); return; }   // toggle
    const fromSaved = _currentMonth ? parseInt(_currentMonth.slice(0, 4), 10) : null;
    _viewYear = fromSaved || _currentSeason();
    // Compensate for `body { zoom: N }` (brand.css:323 — 1.25 desktop, 1.0
    // mobile). getBoundingClientRect returns post-zoom visual coords, but the
    // popup is mounted on <body> and inherits body's zoom — assigning the
    // visual coord to style.left would re-scale by zoom, shifting the popup
    // off-screen. Dividing by zoom cancels the inherited re-scale so the
    // popup lands directly under the trigger at every zoom step.
    const bodyZoom = (function () {
      const v = parseFloat(getComputedStyle(document.body).zoom);
      return (isFinite(v) && v > 0) ? v : 1;
    })();
    const rect = triggerEl.getBoundingClientRect();
    pop.style.left = ((rect.left + window.scrollX) / bodyZoom) + 'px';
    pop.style.top  = ((rect.bottom + window.scrollY + 4) / bodyZoom) + 'px';
    pop.hidden = false;
    _renderGrid();
    ensureYearLoaded(_viewYear).then(() => _renderGrid());
  }

  function closeCalendar() {
    const pop = document.getElementById('adp-cmp-popup');
    if (pop) pop.hidden = true;
  }

  function _navYear(delta) {
    const maxYear = _currentSeason();
    const next = Math.max(MIN_YEAR, Math.min(maxYear, (_viewYear || maxYear) + delta));
    if (next === _viewYear) return;
    _viewYear = next;
    _renderGrid();
    ensureYearLoaded(next).then(() => _renderGrid());
  }

  function _renderGrid() {
    const grid  = document.getElementById('adp-cmp-grid');
    const label = document.getElementById('adp-cmp-year-label');
    const prev  = document.getElementById('adp-cmp-prev');
    const next  = document.getElementById('adp-cmp-next');
    if (!grid || !label) return;

    const maxYear = _currentSeason();
    label.textContent = String(_viewYear);
    if (prev) prev.disabled = (_viewYear <= MIN_YEAR);
    if (next) next.disabled = (_viewYear >= maxYear);

    const allMonths = Object.keys(MONTH_INDEX).sort();
    const nowMonth = allMonths.length ? allMonths[allMonths.length - 1] : null;

    let html = '';
    for (let i = 0; i < 12; i++) {
      const mm = String(i + 1).padStart(2, '0');
      const ym = _viewYear + '-' + mm;
      const classes = ['adp-cmp-cell'];
      const hasData = !!MONTH_INDEX[ym];
      const isActive = (ym === _currentMonth);
      const isFutureOrNow = nowMonth && ym >= nowMonth;
      let clickAttr = '';
      if (isActive)        classes.push('active');
      if (isFutureOrNow)   classes.push('disabled');
      else if (!hasData)   classes.push('no-data');
      if (!isFutureOrNow && hasData) {
        clickAttr = ' onclick="window.AdpComparator._pickMonth(\'' + ym + '\')"';
      }
      html += '<button type="button" class="' + classes.join(' ') + '"' + clickAttr + '>'
            + MONTH_SHORT[i] + '</button>';
    }
    grid.innerHTML = html;
  }

  function _pickMonth(ym) {
    setCurrentMonth(ym);
    closeCalendar();
  }

  // ── CSS injection (once) ──────────────────────────────────────────────
  function _injectCss() {
    if (document.getElementById('adp-cmp-styles')) return;
    const style = document.createElement('style');
    style.id = 'adp-cmp-styles';
    style.textContent = ''
      // Trigger button — looks like a <th> label, opens the popup on click
      + '.adp-cmp-trigger {'
      +   'background: transparent; color: var(--muted);'
      +   'border: none; padding: 0; margin: 0;'
      +   'font: 700 10px/1 \'Mulish\', sans-serif;'
      +   'text-transform: uppercase; letter-spacing: .06em;'
      +   'cursor: pointer;'
      +   'display: inline-flex; align-items: center; gap: 4px;'
      + '}'
      + '.adp-cmp-trigger:hover { color: var(--white); }'
      + '.adp-cmp-trigger:focus { outline: none; color: var(--red); }'
      + '.adp-cmp-trigger .adp-cmp-chevron { font-size: 9px; opacity: .7; }'

      // Change chip — matches adp-tool .trend palette (transparent bg + colored arrow/text)
      + '.adp-cmp-chip {'
      +   'display: inline-flex; align-items: center; gap: 4px;'
      +   'font-family: \'Kanit\', sans-serif; font-weight: 800; font-style: italic; font-size: 11px;'
      +   'background: transparent;'
      +   'text-shadow: 0 0 2px #000, 0 0 1px #000;'
      +   'line-height: 1.1; justify-content: center;'
      + '}'
      + '.adp-cmp-chip.up   { color: #66dd84; }'
      + '.adp-cmp-chip.down { color: var(--red); }'
      + '.adp-cmp-chip.flat { color: #ffffff; }'
      + '.adp-cmp-chip .adp-cmp-arrow { font-size: 10px; }'

      // Calendar popup (mounted at body level by _mountPopup)
      + '.adp-cmp-popup {'
      +   'position: absolute; z-index: 100;'
      +   'background: var(--surface); border: 1px solid var(--border2);'
      +   'box-shadow: 0 4px 18px rgba(0,0,0,.55);'
      +   'padding: 8px; min-width: 220px;'
      +   'font-family: \'Mulish\', sans-serif;'
      + '}'
      + '.adp-cmp-header {'
      +   'display: flex; align-items: center; justify-content: space-between;'
      +   'padding: 4px 6px 8px; border-bottom: 1px solid var(--border);'
      + '}'
      + '.adp-cmp-nav {'
      +   'background: transparent; color: var(--white); border: none;'
      +   'cursor: pointer; font-size: 14px; padding: 2px 8px; line-height: 1;'
      + '}'
      + '.adp-cmp-nav:hover:not(:disabled) { color: var(--red); }'
      + '.adp-cmp-nav:disabled { opacity: .25; cursor: default; }'
      + '.adp-cmp-year {'
      +   'font-family: \'Kanit\', sans-serif; font-weight: 800; font-style: italic;'
      +   'font-size: 14px; color: var(--white); letter-spacing: .04em;'
      + '}'

      // 12-month grid
      + '.adp-cmp-grid {'
      +   'display: grid; grid-template-columns: repeat(4, 1fr);'
      +   'gap: 4px; padding: 8px 4px 4px;'
      + '}'
      + '.adp-cmp-cell {'
      +   'background: var(--surface2); color: var(--white); border: 1px solid transparent;'
      +   'padding: 8px 0;'
      +   'font-family: \'Mulish\', sans-serif; font-weight: 700; font-size: 11px; line-height: 1;'
      +   'text-transform: uppercase; cursor: pointer; text-align: center;'
      + '}'
      + '.adp-cmp-cell:hover:not(.disabled):not(.no-data) {'
      +   'border-color: var(--red); color: var(--red);'
      + '}'
      + '.adp-cmp-cell.active {'
      +   'background: var(--red); color: #111111; border-color: var(--red);'
      + '}'
      + '.adp-cmp-cell.disabled { opacity: .25; cursor: default; }'
      + '.adp-cmp-cell.no-data  { opacity: .45; cursor: default; color: var(--muted); }'
      + '.adp-cmp-status {'
      +   'padding: 8px; text-align: center; color: var(--muted); font-size: 11px;'
      + '}'

      // Mobile — center the popup, larger touch targets
      + '@media (max-width: 768px) {'
      +   '.adp-cmp-popup { left: 50% !important; transform: translateX(-50%); min-width: 280px; }'
      +   '.adp-cmp-cell { padding: 12px 0; font-size: 13px; }'
      + '}';
    document.head.appendChild(style);
  }

  // ── public init ───────────────────────────────────────────────────────
  function init(opts) {
    opts = opts || {};
    if (opts.storageKey) _storageKey = opts.storageKey;
    if (typeof opts.onChange === 'function') _onChange = opts.onChange;

    _injectCss();
    _seedCurrentYear();
    buildMonthIndex();
    _initCurrentMonthFromStorage();
    _initialized = true;

    // Subtle race: if saved month is from a non-current year, lazy-fetch
    // it now so the host's overlay can populate without waiting for the
    // user to open the popup.
    let savedRaw = null;
    try { savedRaw = localStorage.getItem(_storageKey); } catch (e) {}
    const savedYear = savedRaw ? parseInt(savedRaw.slice(0, 4), 10) : null;
    const cur = _currentSeason();
    if (savedYear && savedYear !== cur && !YEAR_CACHE[savedYear]) {
      ensureYearLoaded(savedYear).then(() => {
        _initCurrentMonthFromStorage();
        try { _onChange(_currentMonth); } catch (e) {}
      });
    }
  }

  // ── expose ────────────────────────────────────────────────────────────
  window.AdpComparator = {
    init: init,
    buildMonthIndex: buildMonthIndex,
    ensureYearLoaded: ensureYearLoaded,
    getMonthBucket: getMonthBucket,
    getCurrentMonth: getCurrentMonth,
    setCurrentMonth: setCurrentMonth,
    renderTriggerHtml: renderTriggerHtml,
    openCalendar: openCalendar,
    closeCalendar: closeCalendar,
    changeChipHtml: changeChipHtml,
    // Private but referenced by inline onclick attribute in grid cells:
    _pickMonth: _pickMonth,
  };
})();
