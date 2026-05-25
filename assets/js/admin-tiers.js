/* ════════════════════════════════════════════════════════════════════════
   ADMIN-TIERS — device-local tier + Buy/Sell/Hold editor (Tier 1 scope)
   ════════════════════════════════════════════════════════════════════════

   What this is
   ------------
   A scratchpad for the admin to override the tier / B/S/H / trending fields
   stored in data/tiers.json (the FPTS Google Sheet mirror) WITHOUT round-
   tripping through the Sheet sync. Overrides live in this device's
   localStorage only — other devices and regular site visitors see nothing.

   Workflow
   --------
   1. Visit any page with `?admin=1` once. The flag becomes sticky in
      localStorage (`fpts-admin-mode=true`); the URL param is then removed
      via history.replaceState so the link looks clean.
   2. Open `tiers.html`. The admin banner appears at the top, plus a small
      ✎ pencil next to every tier badge in the table.
   3. Click any pencil → small popover with tier dropdown / B/S/H dropdown
      / trending text field. Save mutates window.TIERS_DATA in place AND
      writes the override to localStorage (`fpts-tier-overrides`).
      data-bootstrap.js re-applies overrides on every future page load.
   4. Compare.html (and any future TIERS_DATA consumer) shows the overridden
      tier/B/S/H badge on subsequent visits — the merge happens inside
      data-bootstrap.js after fetching tiers.json.
   5. When ready to publish: click "Copy as JSON" in the banner, paste into
      Google Sheet. After the next push.bat run regenerates data/tiers.json,
      clear local overrides via the banner button.
   6. Disable admin mode by visiting `?admin=0` or clicking "Disable admin"
      in the banner.

   Security model
   --------------
   This is security-through-URL-obscurity: anyone who guesses or shares
   `?admin=1` can edit on their own device. No tampering with what other
   visitors see (overrides are device-local). For a personal-tool static
   site, this is the right tradeoff vs adding a backend.

   Hard guarantee: when admin mode is OFF (default), this module renders
   nothing. The data-bootstrap.js override-merge step still runs but is a
   no-op when no overrides exist in localStorage.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Standalone build: the parent project's admin-gated nav/legend toggles
  // (Formulas link + .lg-trigger) are removed entirely along with the topnav
  // and Legend drawer, so the init block that touched them has no work to do.

  var STORAGE_KEY_MODE      = 'fpts-admin-mode';
  var STORAGE_KEY_OVERRIDES = 'fpts-tier-overrides';
  // GitHub publish settings (Phase 1b). PAT lives in localStorage on this
  // device only. Repo / branch / path are configured via the Settings panel
  // on first run. Token security: localStorage is per-origin (only this
  // site can read), token is sensitive — if the device is shared, clear it
  // via the Settings panel's "Clear token" button.
  var STORAGE_KEY_GH_TOKEN  = 'fpts-admin-gh-token';
  var STORAGE_KEY_GH_REPO   = 'fpts-admin-gh-repo';
  var STORAGE_KEY_GH_BRANCH = 'fpts-admin-gh-branch';
  var STORAGE_KEY_GH_PATH   = 'fpts-admin-gh-path';
  // Standalone defaults: blank repo forces first-run configuration via the
  // ⚙ Settings modal so Publish can't accidentally write to the wrong repo.
  var DEFAULT_GH_REPO   = '';
  var DEFAULT_GH_BRANCH = 'main';
  var DEFAULT_GH_PATH   = 'data/source/tiers/tiers.csv';
  // Phase 3 — tier title/order overrides (separate file from the player
  // CSV so Publish writes one or both as needed without rewriting both
  // when only one changed).
  var STORAGE_KEY_TIER_TITLES = 'fpts-tier-title-overrides';
  var STORAGE_KEY_TIER_ORDER  = 'fpts-tier-order-override';
  // Phase 4 — per-tier custom player ordering. Shape:
  //   { S++: [name1, name2, ...], S+: [name1, ...] }
  // Names listed render first in the given order; unlisted players fall
  // back to alphabetical at the end so partial reorders don't drop rows.
  var STORAGE_KEY_PLAYER_ORDER = 'fpts-player-order-overrides';
  var DEFAULT_GH_CONFIG_PATH  = 'data/source/tiers/tier-config.json';

  var TIERS = ['S++','S+','S','A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','E+','E','E-','F+','F','F-'];
  // 5 + empty for Buy/Sell/Hold (mirrors bshChipHtml in tiers.html)
  var BSHS  = ['', 'buying', 'checking', 'selling', 'shopping', 'hold'];
  // 5 priority levels — Top Target = active acquire, Avoid = active divest.
  // Saved as the exact display label so priorityChipHtml renders without
  // mapping.
  var PRIORITIES = ['', 'Top Target', 'High', 'Medium', 'Low', 'Avoid'];
  // 5 team-archetype buckets, same vocabulary as my-leagues' team archetype
  // classifier (mlGetArchetype) for cross-page consistency.
  var CONTENDERS = ['', 'Dynasty', 'Contender', 'Tweener', 'Rebuilder', 'Emergency'];
  // Trending field: 3 states (none / up / down). Saved as codes 'up'/'down'
  // so the renderer can swap between the avatar PNG (up) and a CSS chevron
  // (down) without parsing emoji. Legacy values (📈/📉/Rookie/etc. from
  // TAT imports) auto-map to up/down/empty at read time — see
  // _trendingNormalize().
  var TRENDINGS = ['', 'up', 'down'];
  var TRENDING_LABELS = { '': '— none —', 'up': 'Trending Up ↑', 'down': 'Trending Down ▼' };

  // Map any legacy trending value to the canonical code. Anything not
  // recognized -> ''. Keeps the dropdown's "selected" state correct when
  // older data was stored as 📈 / 📉 / freeform text.
  function _trendingNormalize(v) {
    if (!v) return '';
    var s = String(v).trim();
    if (s === 'up'   || s === '📈' || s === '↑' || s === '▲') return 'up';
    if (s === 'down' || s === '📉' || s === '↓' || s === '▼') return 'down';
    return '';   // unrecognized (Rookie/Sophomore/etc.) drops to none
  }

  // ── Password gate ───────────────────────────────────────────────────────
  // SHA-256 hex of the admin password. Generated via the ?admin=hash setup
  // flow. Empty string = no password configured (admin mode CANNOT be
  // activated until you set one). Stored in committed source so only the
  // repo owner can change it. Anyone reading the public JS sees this hash
  // but can't trivially reverse it — pick a strong password (12+ chars,
  // mixed) and dictionary attacks are infeasible. The "real" security
  // boundary is the GitHub PAT (when Path B publish ships in Phase 1b);
  // this gate's job is preventing public visitors from even seeing the
  // editor UI.
  var PASSWORD_HASH = 'f59049ad3f53ad49c66101ef8c1b295d9dc8cd431cfcdbc7236c341e81054de9';

  async function hashPassword(pw) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('WebCrypto unavailable — admin mode requires HTTPS (or localhost).');
    }
    var bytes = new TextEncoder().encode(String(pw == null ? '' : pw));
    var buf = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  // ── Activation handling ────────────────────────────────────────────────
  // URL flags:
  //   ?admin=1    -> prompt for password; on match, sticky-activate
  //   ?admin=0    -> disable + clear localStorage flag (no password needed)
  //   ?admin=hash -> setup helper. Prompts for a NEW password, computes
  //                  SHA-256, displays it for you to paste into the
  //                  PASSWORD_HASH constant above. One-time setup.
  async function _handleUrlParam() {
    var url;
    try { url = new URL(window.location.href); } catch (e) { return; }
    var p = url.searchParams.get('admin');
    if (!p) return;
    // Always strip the param from the visible URL so the secret never sits
    // in the address bar / history / screenshots.
    url.searchParams.delete('admin');
    try { history.replaceState(null, '', url.toString()); } catch (e) {}

    if (p === '0') {
      try { localStorage.removeItem(STORAGE_KEY_MODE); } catch (e) {}
      return;
    }

    if (p === 'hash') {
      var pw = window.prompt('Enter a NEW admin password to hash:\n\n(The hash will be displayed for you to paste into\nassets/js/admin-tiers.js PASSWORD_HASH constant.)');
      if (!pw) return;
      try {
        var hex = await hashPassword(pw);
        // window.prompt with a 2nd-arg default pre-fills the input box,
        // making it trivially copyable on every platform.
        window.prompt(
          'Paste this hex into admin-tiers.js PASSWORD_HASH (then push.bat):',
          hex
        );
      } catch (e) {
        window.alert('Hash failed: ' + e.message);
      }
      return;
    }

    if (p === '1') {
      // Already-active sessions skip the prompt (sticky localStorage).
      if (isActive()) return;
      if (!PASSWORD_HASH) {
        window.alert('Admin mode is not yet set up.\n\nVisit any page with ?admin=hash to generate a password hash, paste it into assets/js/admin-tiers.js PASSWORD_HASH, then push.bat.');
        return;
      }
      var entered = window.prompt('Admin password:');
      if (entered === null) return;
      try {
        var enteredHash = await hashPassword(entered);
        if (enteredHash === PASSWORD_HASH) {
          try { localStorage.setItem(STORAGE_KEY_MODE, 'true'); } catch (e) {}
        } else {
          window.alert('Wrong password.');
        }
      } catch (e) {
        window.alert('Auth failed: ' + e.message);
      }
    }
  }

  function isActive() {
    try { return localStorage.getItem(STORAGE_KEY_MODE) === 'true'; } catch (e) { return false; }
  }

  // ── Override read/write ─────────────────────────────────────────────────
  function _readOverrides() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_OVERRIDES);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { return {}; }
  }
  function _writeOverrides(map) {
    try {
      if (!map || !Object.keys(map).length) {
        localStorage.removeItem(STORAGE_KEY_OVERRIDES);
      } else {
        localStorage.setItem(STORAGE_KEY_OVERRIDES, JSON.stringify(map));
      }
    } catch (e) {}
  }
  function _overrideCount() {
    return Object.keys(_readOverrides()).length;
  }

  // Apply a single-player override + mutate live TIERS_DATA so the page
  // reflects the change without a reload. Fires 'fpts:tiers-overrides-changed'
  // so consumers (tiers.html, compare.html when open in another tab) can
  // re-render.
  function saveOverride(name, patch) {
    if (!name || !patch) return;
    var map = _readOverrides();
    var existing = map[name] || {};
    var merged = Object.assign({}, existing, patch);
    // Trim empty-string fields so the stored override stays compact.
    Object.keys(merged).forEach(function (k) {
      if (merged[k] === '' || merged[k] == null) delete merged[k];
    });
    if (Object.keys(merged).length === 0) {
      delete map[name];
    } else {
      map[name] = merged;
    }
    _writeOverrides(map);
    _applyOverrideToLive(name, merged);
    _fireChanged();
    _refreshBanner();
  }

  function clearOverride(name) {
    var map = _readOverrides();
    if (!(name in map)) return;
    delete map[name];
    _writeOverrides(map);
    // Restore live TIERS_DATA[name] from the original tiers.json. Since we
    // don't keep a clean copy, simplest restore = page reload. Alternative:
    // re-fetch tiers.json. Reload is the honest path.
    _fireChanged();
    _refreshBanner();
  }

  function clearAllOverrides() {
    _writeOverrides({});
    // Phase 3 — also clear tier title + order overrides so "Clear all" is
    // a true full-reset to canonical state across all admin layers.
    _writeTitleOverrides({});
    _writeOrderOverride(null);
    // Phase 4 — and the per-tier player-order map.
    _writePlayerOrder({});
    _fireChanged();
    _fireConfigChanged();
    _refreshBanner();
  }

  // Mark a player as removed. Stored as { _deleted: true } in the override
  // so the render layer + publish CSV both filter them out. Clearing the
  // override (via Reset in the popover or Clear all in the banner) restores
  // the player. This is "soft delete" -- never destroys the underlying
  // tiers.csv entry, just hides it locally until published.
  function removePlayer(name) {
    if (!name) return;
    saveOverride(name, { _deleted: true });
  }

  // ── Phase 3 — Tier title + order overrides ─────────────────────────────
  // Render layer reads window.TIER_CONFIG (loaded from data/source/tiers/
  // tier-config.json) for canonical titles + order. Admin overrides layer
  // on top in localStorage. Publish writes the file back to GitHub with
  // overrides baked in.
  function _readTitleOverrides() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TIER_TITLES) || '{}'); }
    catch (e) { return {}; }
  }
  function _writeTitleOverrides(map) {
    try {
      if (!map || !Object.keys(map).length) localStorage.removeItem(STORAGE_KEY_TIER_TITLES);
      else localStorage.setItem(STORAGE_KEY_TIER_TITLES, JSON.stringify(map));
    } catch (e) {}
  }
  function _readOrderOverride() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TIER_ORDER) || 'null'); }
    catch (e) { return null; }
  }
  function _writeOrderOverride(arr) {
    try {
      if (!arr || !arr.length) localStorage.removeItem(STORAGE_KEY_TIER_ORDER);
      else localStorage.setItem(STORAGE_KEY_TIER_ORDER, JSON.stringify(arr));
    } catch (e) {}
  }
  function _hasConfigOverrides() {
    return !!(
      Object.keys(_readTitleOverrides()).length ||
      _readOrderOverride() ||
      Object.keys(_readPlayerOrder()).length
    );
  }

  // Phase 4 — player order within each tier.
  function _readPlayerOrder() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_PLAYER_ORDER) || '{}'); }
    catch (e) { return {}; }
  }
  function _writePlayerOrder(map) {
    try {
      if (!map || !Object.keys(map).length) localStorage.removeItem(STORAGE_KEY_PLAYER_ORDER);
      else localStorage.setItem(STORAGE_KEY_PLAYER_ORDER, JSON.stringify(map));
    } catch (e) {}
  }

  // Sort a list of player names within a single tier. Names that appear
  // in the override array come first in that order; unlisted players are
  // appended alphabetically. Used by both the render layer (tiers.html
  // renderTiers) and the publish layer (_buildOverriddenCsv) so the CSV
  // committed to the repo matches what the admin sees on the page.
  function sortPlayersForTier(tierCode, names) {
    var order = _readPlayerOrder()[tierCode] || [];
    if (!order.length) {
      return names.slice().sort(function (a, b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });
    }
    var indexed = {};
    order.forEach(function (n, i) { indexed[n] = i; });
    var listed = names.filter(function (n) { return n in indexed; });
    var unlisted = names.filter(function (n) { return !(n in indexed); });
    listed.sort(function (a, b) { return indexed[a] - indexed[b]; });
    unlisted.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    return listed.concat(unlisted);
  }

  // Persist a new ordering for one tier. Pass null/empty to clear.
  function setPlayerOrder(tierCode, namesArray) {
    if (!tierCode) return;
    var map = _readPlayerOrder();
    if (!namesArray || !namesArray.length) {
      delete map[tierCode];
    } else {
      map[tierCode] = namesArray.slice();
    }
    _writePlayerOrder(map);
    _fireChanged();          // tiers.html re-renders via existing listener
    _refreshBanner();
  }

  // Effective tier list, override-merged. Always sourced from
  // window.TIER_CONFIG.tiers (loaded from JSON) so the canonical order
  // ships in the repo. Returns array of {code, title} in display order.
  function effectiveTierConfig() {
    var canonical = (window.TIER_CONFIG && window.TIER_CONFIG.tiers) || [];
    if (!canonical.length) {
      // Defensive: synthesize from TIERS constant if config wasn't loaded
      canonical = TIERS.map(function (c) { return { code: c, title: c }; });
    }
    var titleMap = _readTitleOverrides();
    var orderOverride = _readOrderOverride();
    var byCode = {};
    canonical.forEach(function (t) { byCode[t.code] = { code: t.code, title: t.title }; });
    // Apply title overrides
    Object.keys(titleMap).forEach(function (code) {
      if (byCode[code]) byCode[code].title = titleMap[code];
    });
    // Apply order override (only codes that exist in canonical; appended
    // canonical codes that aren't in the override go at the end so a
    // partial reorder doesn't drop tiers).
    var order = orderOverride && orderOverride.length
      ? orderOverride.filter(function (c) { return byCode[c]; })
      : canonical.map(function (t) { return t.code; });
    canonical.forEach(function (t) {
      if (order.indexOf(t.code) < 0) order.push(t.code);
    });
    return order.map(function (c) { return byCode[c]; });
  }

  function setTierTitle(code, title) {
    if (!code) return;
    var map = _readTitleOverrides();
    var canonicalTitle = (function () {
      var c = (window.TIER_CONFIG && window.TIER_CONFIG.tiers) || [];
      for (var i = 0; i < c.length; i++) if (c[i].code === code) return c[i].title;
      return '';
    })();
    if (!title || title === canonicalTitle) {
      // Empty or matches canonical -> clear the override
      delete map[code];
    } else {
      map[code] = title;
    }
    _writeTitleOverrides(map);
    _fireConfigChanged();
    _refreshBanner();
  }

  function moveTier(code, direction) {
    if (!code || (direction !== 1 && direction !== -1)) return;
    var cfg = effectiveTierConfig();
    var idx = cfg.findIndex(function (t) { return t.code === code; });
    if (idx < 0) return;
    var newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= cfg.length) return;   // already at edge
    var order = cfg.map(function (t) { return t.code; });
    var tmp = order[idx]; order[idx] = order[newIdx]; order[newIdx] = tmp;
    _writeOrderOverride(order);
    _fireConfigChanged();
    _refreshBanner();
  }

  // Persist a full tier-order array. Used by the drag-and-drop reorder
  // path in tiers.html (Phase 5) — pass the codes in their new display
  // order. Defensive: filters out unknown codes and re-appends any
  // canonical tiers missing from the input so a partial array can't
  // drop tiers from the display.
  function setTierOrder(orderArray) {
    if (!Array.isArray(orderArray)) return;
    var canonical = effectiveTierConfig().map(function (t) { return t.code; });
    var seen = {};
    var clean = [];
    orderArray.forEach(function (c) {
      if (c && canonical.indexOf(c) >= 0 && !seen[c]) { clean.push(c); seen[c] = true; }
    });
    canonical.forEach(function (c) {
      if (!seen[c]) clean.push(c);
    });
    // No-op if the new order matches what we'd render today.
    if (clean.join('|') === canonical.join('|')) {
      // Still clear an existing override if it was redundant.
      var existing = _readOrderOverride();
      if (existing) { _writeOrderOverride(null); _fireConfigChanged(); _refreshBanner(); }
      return;
    }
    _writeOrderOverride(clean);
    _fireConfigChanged();
    _refreshBanner();
  }

  function _fireConfigChanged() {
    try {
      document.dispatchEvent(new CustomEvent('fpts:tier-config-changed', {
        detail: { tiers: effectiveTierConfig() },
      }));
    } catch (e) {}
  }

  // Build the tier-config.json payload for Publish — overrides baked in,
  // canonical structure preserved.
  function _buildOverriddenTierConfigJson() {
    var tiers = effectiveTierConfig();
    var payload = {
      version: new Date().toISOString().slice(0, 10),
      source: 'Published via admin scratchpad (admin-tiers.js)',
      tiers: tiers.map(function (t) { return { code: t.code, title: t.title }; }),
    };
    return JSON.stringify(payload, null, 2) + '\n';
  }

  function _applyOverrideToLive(name, merged) {
    if (!window.TIERS_DATA) return;
    var base = window.TIERS_DATA[name] || {
      tier: '', trending: '', buySell: '', priority: '', contender: '', notes: '',
    };
    window.TIERS_DATA[name] = Object.assign({}, base, merged, { _override: true });
    if (window.TIERS_BY_NORM && typeof window.normalizePlayerName === 'function') {
      window.TIERS_BY_NORM[window.normalizePlayerName(name)] = window.TIERS_DATA[name];
    }
  }

  function _fireChanged() {
    try {
      document.dispatchEvent(new CustomEvent('fpts:tiers-overrides-changed', {
        detail: { count: _overrideCount() },
      }));
    } catch (e) {}
  }

  // ── Export ──────────────────────────────────────────────────────────────
  function exportToClipboard() {
    var map = _readOverrides();
    var lines = ['Tier overrides (paste into Google Sheet):', ''];
    Object.keys(map).sort().forEach(function (n) {
      var rec = map[n];
      var bits = [];
      if (rec.tier)     bits.push('tier=' + rec.tier);
      if (rec.buySell)  bits.push('buySell=' + rec.buySell);
      if (rec.trending) bits.push('trending=' + rec.trending);
      lines.push('  ' + n + ' → ' + bits.join(' · '));
    });
    lines.push('');
    lines.push('--- Raw JSON ---');
    lines.push(JSON.stringify(map, null, 2));
    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { _flashBanner('Copied ' + Object.keys(map).length + ' overrides to clipboard.'); },
        function () { _fallbackCopy(text); }
      );
    } else {
      _fallbackCopy(text);
    }
  }
  function _fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); _flashBanner('Copied (fallback).'); }
    catch (e) { _flashBanner('Copy failed — see console.'); console.log(text); }
    document.body.removeChild(ta);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Phase 1b — Settings panel + Publish to GitHub
  // ══════════════════════════════════════════════════════════════════════

  // ── GitHub Settings storage ─────────────────────────────────────────────
  function _ghSettings() {
    function _get(k, fallback) {
      try { return localStorage.getItem(k) || fallback; } catch (e) { return fallback; }
    }
    return {
      token:  _get(STORAGE_KEY_GH_TOKEN,  ''),
      hasToken: !!_get(STORAGE_KEY_GH_TOKEN, ''),
      repo:   _get(STORAGE_KEY_GH_REPO,   DEFAULT_GH_REPO),
      branch: _get(STORAGE_KEY_GH_BRANCH, DEFAULT_GH_BRANCH),
      path:   _get(STORAGE_KEY_GH_PATH,   DEFAULT_GH_PATH),
    };
  }
  function _ghSettingsSave(token, repo, branch, path) {
    try {
      // Defensive: only WRITE the token if the user supplied one. An empty
      // input on Save = "no change" (could be Chrome's password-manager
      // wiping the input value attribute, or the user just tweaking repo
      // /branch/path without touching the masked token). The dedicated
      // "Clear token" button is the only path that erases the PAT.
      if (token) localStorage.setItem(STORAGE_KEY_GH_TOKEN, token);
      localStorage.setItem(STORAGE_KEY_GH_REPO,   repo   || DEFAULT_GH_REPO);
      localStorage.setItem(STORAGE_KEY_GH_BRANCH, branch || DEFAULT_GH_BRANCH);
      localStorage.setItem(STORAGE_KEY_GH_PATH,   path   || DEFAULT_GH_PATH);
    } catch (e) {}
  }
  function _ghReady() {
    var s = _ghSettings();
    return !!(s.token && s.repo && s.branch && s.path);
  }

  // ── CSV generation (Sheet-format, 7 cols, overrides baked in) ──────────
  // Walks live TIERS_DATA (already merged with localStorage overrides via
  // data-bootstrap) and emits a Sheet-format CSV that sync-tiers.py parses
  // via the header-aware map_rows path. Matches the same columns the user
  // would export from the Google Sheet.
  // Parse Sheet-format CSV → { [playerName]: { tier, trending, buySell,
  // priority, contender, notes } }. Inverse of _buildOverriddenCsv below.
  // Used at publish time by the stale-CSV defense to rebase user overrides
  // onto GitHub's latest content rather than the (possibly stale) page view.
  function _parseTiersCsv(csvText) {
    var out = {};
    if (!csvText) return out;
    if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);
    var rows = [], field = '', row = [], inQuotes = false, i = 0, len = csvText.length;
    while (i < len) {
      var c = csvText[i];
      if (inQuotes) {
        if (c === '"') {
          if (csvText[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return out;
    var header = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    var idx = {
      tier:      header.indexOf('tier'),
      player:    header.indexOf('player'),
      trending:  header.indexOf('trending'),
      buysell:   header.indexOf('buy/sell/hold'),
      priority:  header.indexOf('priority level'),
      contender: header.indexOf('contender/rebuild'),
      notes:     header.indexOf('player notes'),
    };
    if (idx.player < 0 || idx.tier < 0) return out;
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r];
      var name = String(cells[idx.player] || '').trim();
      if (!name) continue;
      out[name] = {
        tier:      String(cells[idx.tier]      || '').trim(),
        trending:  String(cells[idx.trending]  || '').trim(),
        buySell:   String(cells[idx.buysell]   || '').trim(),
        priority:  String(cells[idx.priority]  || '').trim(),
        contender: String(cells[idx.contender] || '').trim(),
        notes:     String(cells[idx.notes]     || '').trim(),
      };
    }
    return out;
  }

  // Merge per-player overrides onto a base data map. Returns a NEW map.
  // User's overrides win on every field they set; un-set fields fall
  // through to the base. _deleted=true is preserved so downstream
  // _buildOverriddenCsv can skip the row.
  function _applyOverridesToData(base, overrides) {
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = Object.assign({}, base[k]); });
    Object.keys(overrides || {}).forEach(function (name) {
      var ov = overrides[name] || {};
      out[name] = Object.assign({}, out[name] || {}, ov);
    });
    return out;
  }

  function _buildOverriddenCsv(dataArg) {
    var TIER_ORDER = ['S++','S+','S','A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','E+','E','E-','F+','F','F-'];
    function tierRank(t) { var i = TIER_ORDER.indexOf(t); return i >= 0 ? i : 99; }
    function esc(v) {
      var s = (v == null) ? '' : String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    var headers = ['Tier','Player','Trending','Buy/Sell/Hold','Priority Level','Contender/Rebuild','Player Notes'];
    // Caller may pass an already-merged map (used by the stale-CSV defense
    // in publishToGitHub). Default falls back to the live in-memory view.
    var data = dataArg || window.TIERS_DATA || {};
    // Skip players the admin removed (Phase 2). They stay in TIERS_DATA
    // with _deleted=true so the override layer can "undo" via Clear, but
    // they don't appear in the published CSV.
    var allNames = Object.keys(data).filter(function (n) {
      return data[n] && data[n].tier && !data[n]._deleted;
    });
    // Phase 4 — bucket by tier, then apply per-tier player-order override
    // (alpha fallback for unlisted players inside sortPlayersForTier).
    // Tier buckets are emitted in canonical TIER_ORDER so the CSV row
    // order matches both the tiers.html grouped view AND publish-friendly
    // structure (sync-tiers.py reads tier from the Tier column, not row
    // position — but matching row order keeps diffs reviewable).
    var byTier = {};
    allNames.forEach(function (n) {
      var t = data[n].tier;
      (byTier[t] = byTier[t] || []).push(n);
    });
    var names = [];
    TIER_ORDER.forEach(function (t) {
      if (!byTier[t]) return;
      sortPlayersForTier(t, byTier[t]).forEach(function (n) { names.push(n); });
    });
    // Catch any rows with a tier outside the canonical 21 (e.g., legacy
    // data). Sort them alpha and append at the end so nothing is dropped.
    Object.keys(byTier).forEach(function (t) {
      if (TIER_ORDER.indexOf(t) >= 0) return;
      byTier[t].slice().sort(function (a, b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      }).forEach(function (n) { names.push(n); });
    });
    var lines = [headers.map(esc).join(',')];
    names.forEach(function (n) {
      var r = data[n];
      lines.push([
        esc(r.tier || ''),
        esc(n),
        esc(r.trending || ''),
        esc(r.buySell || ''),
        esc(r.priority || ''),
        esc(r.contender || ''),
        esc(r.notes || ''),
      ].join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  // ── GitHub Contents API ────────────────────────────────────────────────
  // UTF-8-safe base64 (btoa alone breaks on multi-byte chars like emojis).
  function _utf8Btoa(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  // Inverse of _utf8Btoa. GitHub's Contents API returns base64 with \n
  // every 60 chars, so strip whitespace before atob.
  function _utf8Atob(b64) {
    if (!b64) return '';
    return decodeURIComponent(escape(atob(b64.replace(/\s+/g, ''))));
  }

  // ── Dry-run / diff preview helpers ──────────────────────────────────────
  // Compute per-player diff between latest GitHub state and the merged
  // result we're about to PUT. Returns an array of change objects sorted
  // by player name. Used by the preview modal to show "what's about to
  // change?" before the operator confirms the commit.
  function _buildPlayerDiff(latest, merged) {
    var changes = [];
    var allNames = {};
    Object.keys(latest || {}).forEach(function (n) { allNames[n] = true; });
    Object.keys(merged || {}).forEach(function (n) { allNames[n] = true; });
    Object.keys(allNames).sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    }).forEach(function (name) {
      var L = latest ? latest[name] : null;
      var M = merged ? merged[name] : null;
      if (M && M._deleted) {
        if (L) changes.push({ type: 'remove', name: name, tier: L.tier || '?' });
        return;
      }
      if (!L && M) {
        changes.push({ type: 'add', name: name, tier: M.tier || '?' });
        return;
      }
      if (L && !M) {
        changes.push({ type: 'remove', name: name, tier: L.tier || '?' });
        return;
      }
      if (!L && !M) return;
      if ((L.tier || '') !== (M.tier || '')) {
        changes.push({ type: 'tier', name: name, from: L.tier || '?', to: M.tier || '?' });
      }
      var metaFields = [
        ['trending',  'Trending'],
        ['buySell',   'Buy/Sell'],
        ['priority',  'Priority'],
        ['contender', 'Contender'],
        ['notes',     'Notes'],
      ];
      metaFields.forEach(function (pair) {
        var key = pair[0], label = pair[1];
        var lv = String(L[key] == null ? '' : L[key]).trim();
        var mv = String(M[key] == null ? '' : M[key]).trim();
        if (lv !== mv) {
          changes.push({ type: 'meta', name: name, field: label, from: lv, to: mv });
        }
      });
    });
    return changes;
  }

  // Compute tier-config diff (title renames + tier order). Returns array
  // of { type: 'rename', code, from, to } and at most one { type: 'order',
  // from: [codes], to: [codes] } if the order changed.
  function _buildConfigDiff(latest, merged) {
    var changes = [];
    var L = (latest && latest.tiers) || [];
    var M = (merged && merged.tiers) || [];
    var lByCode = {};
    L.forEach(function (t) { if (t && t.code) lByCode[t.code] = t.title || ''; });
    M.forEach(function (t) {
      if (!t || !t.code) return;
      if (lByCode[t.code] !== undefined && lByCode[t.code] !== (t.title || '')) {
        changes.push({ type: 'rename', code: t.code, from: lByCode[t.code], to: t.title || '' });
      }
    });
    var lOrder = L.map(function (t) { return t && t.code; }).filter(Boolean);
    var mOrder = M.map(function (t) { return t && t.code; }).filter(Boolean);
    if (lOrder.join('|') !== mOrder.join('|')) {
      changes.push({ type: 'order', from: lOrder, to: mOrder });
    }
    return changes;
  }

  // Render the preview modal. Returns a Promise<bool> — true if the user
  // clicked Publish to GitHub, false if Cancel / backdrop / Escape.
  function _openPublishPreviewModal(playerDiff, configDiff) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(yes) {
        if (settled) return;
        settled = true;
        try { backdrop.remove(); } catch (e) {}
        document.removeEventListener('keydown', onKey);
        resolve(yes);
      }
      function onKey(e) { if (e.key === 'Escape') finish(false); }

      var backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 4vh;overflow-y:auto';
      var modal = document.createElement('div');
      modal.style.cssText = 'background:#1a1a1a;color:var(--text);border:2px solid var(--red);border-radius:8px;padding:20px 24px;max-width:760px;width:100%;font-family:"Mulish",sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.6)';

      var totalChanges = (playerDiff || []).length + (configDiff || []).length;
      var parts = [];
      parts.push('<div style="font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:18px;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px">Review publish</div>');

      if (totalChanges === 0) {
        parts.push('<div style="font-size:13px;opacity:.75;margin:14px 0 4px">Your overrides match GitHub\'s current state. Nothing to commit.</div>');
        parts.push('<div style="font-size:11px;opacity:.5;margin-bottom:18px">(Tip: click "Clear all" in the banner to drop these no-op overrides locally.)</div>');
      } else {
        parts.push('<div style="font-size:12px;opacity:.8;margin-bottom:14px">' + totalChanges + ' change' + (totalChanges === 1 ? '' : 's') + ' will be committed to <code style="background:var(--black);padding:1px 5px;border-radius:3px;font-size:11px">' + _esc(_ghSettings().repo || '(repo not configured — open ⚙ Settings)') + '</code>:</div>');

        if (playerDiff.length) {
          parts.push('<div style="font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:12px;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin:6px 0 6px">Player changes (' + playerDiff.length + ')</div>');
          parts.push('<div style="font-size:12px;line-height:1.7;border-left:2px solid #333;padding-left:10px;max-height:300px;overflow-y:auto">');
          playerDiff.forEach(function (c) {
            if (c.type === 'tier') {
              parts.push('<div><span style="color:var(--yellow)">⇅</span> <strong>' + _esc(c.name) + '</strong>  <span style="color:#888">' + _esc(c.from) + ' → </span><span style="color:#66dd84">' + _esc(c.to) + '</span></div>');
            } else if (c.type === 'add') {
              parts.push('<div><span style="color:#66dd84">+</span> <strong>' + _esc(c.name) + '</strong> added to <span style="color:#66dd84">' + _esc(c.tier) + '</span></div>');
            } else if (c.type === 'remove') {
              parts.push('<div><span style="color:var(--red)">−</span> <strong>' + _esc(c.name) + '</strong> removed from <span style="color:#888">' + _esc(c.tier) + '</span></div>');
            } else if (c.type === 'meta') {
              parts.push('<div><span style="color:#888">✎</span> <strong>' + _esc(c.name) + '</strong> ' + _esc(c.field) + ': <span style="color:#888">' + _esc(c.from || '∅') + ' → </span><span style="color:#66dd84">' + _esc(c.to || '∅') + '</span></div>');
            }
          });
          parts.push('</div>');
        }

        if (configDiff.length) {
          parts.push('<div style="font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:12px;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px">Tier config changes (' + configDiff.length + ')</div>');
          parts.push('<div style="font-size:12px;line-height:1.7;border-left:2px solid #333;padding-left:10px">');
          configDiff.forEach(function (c) {
            if (c.type === 'rename') {
              parts.push('<div><span style="color:#888">✎</span> Tier <strong>' + _esc(c.code) + '</strong>: <span style="color:#888">"' + _esc(c.from) + '" → </span><span style="color:#66dd84">"' + _esc(c.to) + '"</span></div>');
            } else if (c.type === 'order') {
              parts.push('<div><span style="color:#888">↕</span> Tier order changed (' + c.from.length + ' tiers)</div>');
              parts.push('<div style="opacity:.55;font-size:11px;margin-left:18px">was: ' + _esc(c.from.join(' › ')) + '</div>');
              parts.push('<div style="font-size:11px;margin-left:18px;color:#66dd84">now: ' + _esc(c.to.join(' › ')) + '</div>');
            }
          });
          parts.push('</div>');
        }
      }

      parts.push('<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;padding-top:14px;border-top:1px solid #333">');
      parts.push('<button type="button" id="fpts-adm-pp-cancel" style="background:transparent;color:var(--text);border:1px solid #555;padding:8px 14px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:12px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Cancel</button>');
      if (totalChanges > 0) {
        parts.push('<button type="button" id="fpts-adm-pp-confirm" style="background:var(--red);color:#fff;border:1px solid var(--red);padding:8px 14px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:12px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Publish to GitHub ⬆</button>');
      }
      parts.push('</div>');

      modal.innerHTML = parts.join('');
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);

      var cancelBtn = modal.querySelector('#fpts-adm-pp-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', function () { finish(false); });
      var confirmBtn = modal.querySelector('#fpts-adm-pp-confirm');
      if (confirmBtn) confirmBtn.addEventListener('click', function () { finish(true); });
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) finish(false); });
      document.addEventListener('keydown', onKey);
    });
  }
  // Inline HTML-escape (modal content interpolates player names + metadata).
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _ghHeaders(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept':        'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
  // Fetch current file → returns { sha, content } or throws with a
  // human-readable error keyed off the HTTP status.
  function _ghGetFile(s) {
    var url = 'https://api.github.com/repos/' + s.repo + '/contents/' + encodeURI(s.path) + '?ref=' + encodeURIComponent(s.branch);
    return fetch(url, { headers: _ghHeaders(s.token) }).then(function (r) {
      if (r.status === 404) {
        // File doesn't exist yet — PUT will create it. Return null SHA.
        return { sha: null, content: '' };
      }
      if (!r.ok) {
        return r.json().then(function (j) {
          throw new Error('GitHub GET ' + r.status + ': ' + (j && j.message ? j.message : r.statusText));
        }, function () {
          throw new Error('GitHub GET ' + r.status + ' ' + r.statusText);
        });
      }
      return r.json().then(function (j) { return { sha: j.sha, content: j.content || '' }; });
    });
  }
  function _ghPutFile(s, csvContent, currentSha, commitMessage) {
    var url = 'https://api.github.com/repos/' + s.repo + '/contents/' + encodeURI(s.path);
    var body = {
      message: commitMessage,
      content: _utf8Btoa(csvContent),
      branch:  s.branch,
    };
    if (currentSha) body.sha = currentSha;
    return fetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _ghHeaders(s.token)),
      body:    JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) {
          var msg = (j && j.message) ? j.message : r.statusText;
          if (r.status === 401) msg = 'Invalid PAT (401). Re-paste your token in Settings.';
          else if (r.status === 403) msg = 'PUT 403: ' + msg + ' (likely: PAT missing Contents: write on this repo, OR branch protection / SAML / org policy blocking the write)';
          else if (r.status === 404) msg = 'Repo or file path not found (404). Check Settings.';
          else if (r.status === 409) msg = 'File changed on server (409). Reload page to fetch the latest, then re-publish.';
          else if (r.status === 422) msg = 'GitHub rejected the PUT (422): ' + msg;
          throw new Error(msg);
        }, function () {
          throw new Error('GitHub PUT ' + r.status + ' ' + r.statusText);
        });
      }
      return r.json();
    });
  }

  // ── Publish flow ───────────────────────────────────────────────────────
  function publishToGitHub() {
    var s = _ghSettings();
    if (!_ghReady()) {
      window.alert('GitHub PAT not configured. Click the ⚙ Settings button in the admin banner first.');
      return Promise.resolve(null);
    }
    var n = _overrideCount();
    var hasConfig = _hasConfigOverrides();
    if (n === 0 && !hasConfig) {
      _flashBanner('Nothing to publish.');
      return Promise.resolve(null);
    }

    // Two files may need writing: tiers.csv (player overrides) and
    // tier-config.json (title/order overrides). Each is a separate GET-SHA-
    // then-PUT round trip. Run sequentially so we don't burn rate-limit
    // on parallel fetches that share a SHA-conflict failure mode.
    var commitMessage = 'admin: tier edits via web UI ('
      + (n > 0 ? n + ' player override' + (n === 1 ? '' : 's') : '')
      + (n > 0 && hasConfig ? ' + ' : '')
      + (hasConfig ? 'tier config' : '')
      + ')';
    var configPath = DEFAULT_GH_CONFIG_PATH;
    var configSettings = Object.assign({}, s, { path: configPath });

    _publishSetState('publishing');

    var pipeline = Promise.resolve();
    if (n > 0) {
      // STALE-CSV DEFENSE: rebase user overrides onto GitHub's LATEST CSV
      // rather than building from the page's in-memory view. Without this,
      // a Publish from a file://-loaded page that's behind origin/main
      // would write the stale local state back to GitHub, clobbering
      // other admin commits made since the page was loaded (the Loveland
      // ping-pong bug across d3bb5c7 / a98d0cf / 1e16d75). The PUT still
      // uses GitHub's current SHA so concurrent edits within the same
      // session still 409 cleanly.
      pipeline = pipeline
        .then(function () { return _ghGetFile(s); })
        .then(function (existing) {
          var latestData = _parseTiersCsv(_utf8Atob(existing.content));
          var merged     = _applyOverridesToData(latestData, _readOverrides());
          var csv        = _buildOverriddenCsv(merged);
          return _ghPutFile(s, csv, existing.sha, commitMessage);
        });
    }
    if (hasConfig) {
      var json = _buildOverriddenTierConfigJson();
      pipeline = pipeline
        .then(function () { return _ghGetFile(configSettings); })
        .then(function (existing) { return _ghPutFile(configSettings, json, existing.sha, commitMessage + ' [config]'); });
    }

    return pipeline.then(function (lastCommit) {
      var commitUrl = (lastCommit && lastCommit.commit && lastCommit.commit.html_url) || '';
      // Auto-clear ALL local overrides — they're now baked into the
      // canonical file(s). Reload so the next render reads the fresh state
      // without stale-override merges.
      _writeOverrides({});
      _writeTitleOverrides({});
      _writeOrderOverride(null);
      _flashBanner('Published! ' + (commitUrl ? 'View commit · ' : '') + 'GitHub Pages rebuilds in ~30-60s.');
      _publishSetState('idle');
      setTimeout(function () { window.location.reload(); }, 1500);
      return lastCommit;
    }).catch(function (err) {
      console.error('[admin-tiers] publish failed:', err);
      window.alert('Publish failed:\n\n' + err.message);
      _publishSetState('idle');
      return null;
    });
  }
  function _publishSetState(state) {
    var btn = document.getElementById('fpts-admin-banner-publish');
    if (!btn) return;
    if (state === 'publishing') {
      btn.disabled = true;
      btn.textContent = 'Publishing…';
      btn.style.opacity = '.65';
    } else {
      btn.disabled = false;
      btn.textContent = 'Publish ⬆';
      btn.style.opacity = '1';
    }
  }

  // ── Settings modal ─────────────────────────────────────────────────────
  function _openSettings() {
    var s = _ghSettings();
    var backdrop = document.createElement('div');
    backdrop.id = 'fpts-admin-settings-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', zIndex: '220',
      background: 'rgba(0,0,0,.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    var modal = document.createElement('div');
    Object.assign(modal.style, {
      background: 'var(--surface)', border: '2px solid var(--red)',
      padding: '20px', minWidth: '420px', maxWidth: '560px',
      fontFamily: "'Mulish', sans-serif", fontSize: '12px',
      color: 'var(--white)', boxShadow: '0 8px 32px rgba(0,0,0,.6)',
    });
    var inputStyle = "width:100%;margin-top:4px;background:var(--surface2);color:var(--white);border:1px solid var(--border);padding:7px;font-family:'Mulish',sans-serif;font-size:12px";
    modal.innerHTML = ''
      + '<div style="font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:16px;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px">GitHub Publish Settings</div>'
      + '<div style="font-size:11px;opacity:.65;margin-bottom:14px;line-height:1.4">PAT scope needs <b>Contents: Read &amp; write</b> on this repo only. <a href="https://github.com/settings/tokens?type=beta" target="_blank" style="color:var(--red)">Create fine-grained token →</a></div>'
      + '<label style="display:block;margin-bottom:12px">GitHub Personal Access Token'
      +   (s.hasToken
            ? ('<div style="font-size:10px;color:#66dd84;margin-top:4px">✓ A token is saved on this device. Leave blank to keep it; type a new value to replace.</div>'
               + '<input id="fpts-adm-gh-token" type="password" autocomplete="new-password" placeholder="(leave blank to keep saved token)" value="" style="' + inputStyle + '">')
            : ('<input id="fpts-adm-gh-token" type="password" autocomplete="new-password" placeholder="github_pat_..." value="" style="' + inputStyle + '">'))
      + '</label>'
      + '<label style="display:block;margin-bottom:12px">Repository (<code style="font-family:monospace">owner/name</code>)'
      +   '<input id="fpts-adm-gh-repo" type="text" value="' + s.repo + '" style="' + inputStyle + '">'
      + '</label>'
      + '<label style="display:block;margin-bottom:12px">Branch'
      +   '<input id="fpts-adm-gh-branch" type="text" value="' + s.branch + '" style="' + inputStyle + '">'
      + '</label>'
      + '<label style="display:block;margin-bottom:16px">File path'
      +   '<input id="fpts-adm-gh-path" type="text" value="' + s.path + '" style="' + inputStyle + '">'
      + '</label>'
      + '<div style="display:flex;gap:8px">'
      +   '<button type="button" id="fpts-adm-settings-save" style="flex:1;background:var(--red);color:#111;border:none;padding:8px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:12px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Save</button>'
      +   '<button type="button" id="fpts-adm-settings-clear-token" style="background:transparent;color:var(--white);border:1px solid var(--border2);padding:8px 12px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:11px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Clear token</button>'
      +   '<button type="button" id="fpts-adm-settings-cancel" style="background:transparent;color:var(--white);border:1px solid var(--border2);padding:8px 12px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:11px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Cancel</button>'
      + '</div>'
      + '<div style="margin-top:12px;font-size:10px;opacity:.55;line-height:1.4">Token stored in this device\'s localStorage only. Public site visitors don\'t see it. Clear via the button if the device is shared or you suspect leakage.</div>';
    backdrop.appendChild(modal);
    document.documentElement.appendChild(backdrop);

    function close() { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }
    document.getElementById('fpts-adm-settings-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    document.getElementById('fpts-adm-settings-clear-token').addEventListener('click', function () {
      if (!confirm('Clear the saved GitHub token? (Other settings stay.)')) return;
      try { localStorage.removeItem(STORAGE_KEY_GH_TOKEN); } catch (e) {}
      document.getElementById('fpts-adm-gh-token').value = '';
      _refreshBanner();
      _flashBanner('Token cleared.');
    });
    document.getElementById('fpts-adm-settings-save').addEventListener('click', function () {
      var token  = document.getElementById('fpts-adm-gh-token').value || '';
      var repo   = document.getElementById('fpts-adm-gh-repo').value || '';
      var branch = document.getElementById('fpts-adm-gh-branch').value || '';
      var path   = document.getElementById('fpts-adm-gh-path').value || '';
      _ghSettingsSave(token.trim(), repo.trim(), branch.trim(), path.trim());
      close();
      _refreshBanner();
      _flashBanner('Settings saved.');
    });
  }

  // ── Add Player modal (Phase 2) ─────────────────────────────────────────
  // Search FP_VALUES (920+ NFL players) -> pick a player -> set their tier
  // and other fields -> Save. Internally calls saveOverride() so the new
  // player flows through the same publish pipeline as edits to existing
  // players. tiers.html's overrides-changed listener also detects NEW
  // TIERS_DATA entries and pushes them into TIER_PLAYERS so the row
  // appears immediately.
  function _openAddPlayerModal() {
    var FP = window.FP_VALUES || {};
    var selectedName = null;

    var backdrop = document.createElement('div');
    backdrop.id = 'fpts-adm-add-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', zIndex: '220',
      background: 'rgba(0,0,0,.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    var modal = document.createElement('div');
    Object.assign(modal.style, {
      background: 'var(--surface)', border: '2px solid var(--red)',
      padding: '20px', minWidth: '420px', maxWidth: '520px',
      fontFamily: "'Mulish', sans-serif", fontSize: '12px',
      color: 'var(--white)', boxShadow: '0 8px 32px rgba(0,0,0,.6)',
    });
    var selStyle = "width:100%;margin-top:3px;background:var(--surface2);color:var(--white);border:1px solid var(--border);padding:5px;font-family:'Kanit',sans-serif;font-weight:800;font-style:italic";
    var inputStyle = "width:100%;margin-top:4px;background:var(--surface2);color:var(--white);border:1px solid var(--border);padding:7px;font-family:'Mulish',sans-serif;font-size:12px";
    var tierOpts = TIERS.map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join('');
    var bshOpts  = BSHS.map(function (b) {
      var label = b ? b.charAt(0).toUpperCase() + b.slice(1) : '— none —';
      return '<option value="' + b + '">' + label + '</option>';
    }).join('');
    var priorityOpts = PRIORITIES.map(function (p) { return '<option value="' + p + '">' + (p || '— none —') + '</option>'; }).join('');
    var contenderOpts = CONTENDERS.map(function (c) { return '<option value="' + c + '">' + (c || '— none —') + '</option>'; }).join('');
    var trendingOpts = TRENDINGS.map(function (t) { return '<option value="' + t + '">' + TRENDING_LABELS[t] + '</option>'; }).join('');

    modal.innerHTML = ''
      + '<div style="font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:16px;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px">Add Player to Tiers</div>'
      + '<label style="display:block;margin-bottom:10px">Search FP players'
      +   '<input id="fpts-adm-add-search" type="text" autocomplete="off" placeholder="Type a player name..." style="' + inputStyle + '">'
      + '</label>'
      + '<div id="fpts-adm-add-results" style="max-height:200px;overflow-y:auto;margin-bottom:10px;background:var(--surface2);border:1px solid var(--border);display:none"></div>'
      + '<div id="fpts-adm-add-selected" style="margin-bottom:10px;padding:8px;background:var(--surface2);border:1px solid var(--border);display:none;align-items:center;gap:8px">'
      +   '<span class="pos-pill" id="fpts-adm-add-sel-pos"></span>'
      +   '<span id="fpts-adm-add-sel-name" style="font-weight:800;font-size:13px;flex:1"></span>'
      +   '<span id="fpts-adm-add-sel-team" style="font-size:10px;opacity:.65"></span>'
      + '</div>'
      + '<label style="display:block;margin-bottom:8px">Tier'
      +   '<select id="fpts-adm-add-tier" style="' + selStyle + '"><option value="">— pick a tier —</option>' + tierOpts + '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:8px">Buy / Sell / Hold'
      +   '<select id="fpts-adm-add-bsh" style="' + selStyle + '">' + bshOpts + '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:8px">Priority Level'
      +   '<select id="fpts-adm-add-priority" style="' + selStyle + '">' + priorityOpts + '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:8px">Contender / Rebuild'
      +   '<select id="fpts-adm-add-contender" style="' + selStyle + '">' + contenderOpts + '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:14px">Trending'
      +   '<select id="fpts-adm-add-trending" style="' + selStyle + '">' + trendingOpts + '</select>'
      + '</label>'
      + '<div style="display:flex;gap:8px">'
      +   '<button type="button" id="fpts-adm-add-save" style="flex:1;background:var(--red);color:#111;border:none;padding:8px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:12px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer" disabled>Add Player</button>'
      +   '<button type="button" id="fpts-adm-add-cancel" style="background:transparent;color:var(--white);border:1px solid var(--border2);padding:8px 12px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:11px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Cancel</button>'
      + '</div>';
    backdrop.appendChild(modal);
    document.documentElement.appendChild(backdrop);

    function close() { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }

    var searchInput   = document.getElementById('fpts-adm-add-search');
    var resultsEl     = document.getElementById('fpts-adm-add-results');
    var selectedBox   = document.getElementById('fpts-adm-add-selected');
    var selectedPos   = document.getElementById('fpts-adm-add-sel-pos');
    var selectedName_ = document.getElementById('fpts-adm-add-sel-name');
    var selectedTeam  = document.getElementById('fpts-adm-add-sel-team');
    var saveBtn       = document.getElementById('fpts-adm-add-save');
    var debounceTimer = null;

    function _selectPlayer(name) {
      selectedName = name;
      var fp = FP[name] || {};
      selectedName_.textContent = name;
      selectedPos.textContent = fp.pos || '?';
      selectedPos.className = 'pos-pill ' + (fp.pos || '');
      selectedTeam.textContent = fp.team || '';
      selectedBox.style.display = 'flex';
      resultsEl.style.display = 'none';
      searchInput.value = name;
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
    }

    searchInput.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var q = (searchInput.value || '').trim().toLowerCase();
      if (!q) {
        resultsEl.style.display = 'none';
        selectedBox.style.display = 'none';
        selectedName = null;
        saveBtn.disabled = true;
        saveBtn.style.opacity = '.5';
        return;
      }
      debounceTimer = setTimeout(function () {
        var hits = Object.keys(FP)
          .filter(function (n) { return n.toLowerCase().indexOf(q) >= 0; })
          .sort(function (a, b) {
            // Rank by (a) starts-with-query first, (b) FP rank
            var aStarts = a.toLowerCase().indexOf(q) === 0;
            var bStarts = b.toLowerCase().indexOf(q) === 0;
            if (aStarts !== bStarts) return aStarts ? -1 : 1;
            return (FP[a].rank || 9999) - (FP[b].rank || 9999);
          })
          .slice(0, 12);
        if (!hits.length) {
          resultsEl.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:11px">No matches.</div>';
          resultsEl.style.display = 'block';
          return;
        }
        resultsEl.innerHTML = hits.map(function (n) {
          var fp = FP[n] || {};
          var safe = n.replace(/'/g, "\\'");
          return '<div data-name="' + n.replace(/"/g, '&quot;') + '" style="padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)" '
            + 'onmouseover="this.style.background=\'var(--surface)\'" onmouseout="this.style.background=\'\'">'
            + '<span class="pos-pill ' + (fp.pos || '') + '">' + (fp.pos || '?') + '</span>'
            + '<span style="flex:1;font-weight:800">' + n + '</span>'
            + '<span style="font-size:10px;opacity:.6">' + (fp.team || '') + (fp.posRank ? ' · ' + fp.posRank : '') + '</span>'
            + '</div>';
        }).join('');
        resultsEl.style.display = 'block';
      }, 60);
    });

    // Delegated click on result rows
    resultsEl.addEventListener('click', function (e) {
      var row = e.target.closest('[data-name]');
      if (!row) return;
      _selectPlayer(row.getAttribute('data-name'));
    });

    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    document.getElementById('fpts-adm-add-cancel').addEventListener('click', close);
    saveBtn.addEventListener('click', function () {
      if (!selectedName) return;
      var tier      = document.getElementById('fpts-adm-add-tier').value || '';
      if (!tier) { window.alert('Pick a tier first.'); return; }
      var buySell   = document.getElementById('fpts-adm-add-bsh').value || '';
      var priority  = document.getElementById('fpts-adm-add-priority').value || '';
      var contender = document.getElementById('fpts-adm-add-contender').value || '';
      var trending  = document.getElementById('fpts-adm-add-trending').value || '';
      saveOverride(selectedName, {
        tier: tier, buySell: buySell, priority: priority,
        contender: contender, trending: trending,
      });
      close();
      _flashBanner('Added ' + selectedName + ' to tier ' + tier + '.');
    });

    setTimeout(function () { searchInput.focus(); }, 50);
  }

  // ── Banner ──────────────────────────────────────────────────────────────
  var _banner = null;
  function _mountBanner() {
    if (_banner || !document.body) return;
    _banner = document.createElement('div');
    _banner.id = 'fpts-admin-banner';
    Object.assign(_banner.style, {
      position: 'fixed',
      top: '0', left: '0', right: '0',
      zIndex: '200',
      background: 'var(--red)',
      color: '#111',
      padding: '6px 14px',
      fontFamily: "'Mulish', sans-serif",
      fontSize: '12px',
      fontWeight: '700',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      boxShadow: '0 2px 10px rgba(0,0,0,.35)',
      borderBottom: '2px solid #111',
    });
    var btnStyle    = "background:transparent;color:#111;border:1px solid #111;padding:4px 10px;font-family:'Kanit',sans-serif;font-weight:800;font-style:italic;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer";
    var publishStyle = "background:#111;color:var(--green);border:1px solid #111;padding:4px 12px;font-family:'Kanit',sans-serif;font-weight:800;font-style:italic;font-size:12px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer";
    _banner.innerHTML = ''
      + '<span style="font-family:\'Kanit\',sans-serif;font-style:italic;font-weight:800;font-size:13px;letter-spacing:.04em;text-transform:uppercase">ADMIN MODE</span>'
      + '<span id="fpts-admin-banner-count" style="opacity:.85"></span>'
      + '<span id="fpts-admin-banner-flash" style="margin-left:auto;font-style:italic;opacity:0;transition:opacity .2s"></span>'
      + '<button type="button" id="fpts-admin-banner-publish" style="' + publishStyle + '" title="Commit your overrides to data/source/tiers/tiers.csv via GitHub API. Publishes for everyone.">Publish ⬆</button>'
      + '<button type="button" id="fpts-admin-banner-add" style="' + btnStyle + '" title="Search FP_VALUES and add a new player to the tier list">+ Add Player</button>'
      + '<button type="button" id="fpts-admin-banner-settings" style="' + btnStyle + '" title="GitHub PAT + repo settings">⚙ Settings</button>'
      + '<button type="button" id="fpts-admin-banner-export" style="background:#111;color:var(--red);border:none;padding:4px 10px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer">Copy as JSON</button>'
      + '<button type="button" id="fpts-admin-banner-clear" style="' + btnStyle + '">Clear all</button>'
      + '<button type="button" id="fpts-admin-banner-disable" style="background:transparent;color:#111;border:1px solid #111;padding:4px 10px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer">Disable</button>';
    document.body.appendChild(_banner);
    // Push the page content down so the banner doesn't cover the topnav.
    document.body.style.paddingTop = (_banner.offsetHeight) + 'px';

    document.getElementById('fpts-admin-banner-export').addEventListener('click', exportToClipboard);

    // "Publish ⬆" — one-click commit to data/source/tiers/tiers.csv via the
    // GitHub Contents API. Reads PAT/repo/branch/path from localStorage
    // (set via the Settings modal). Auto-clears overrides on success +
    // reloads so the page reflects the canonical state.
    document.getElementById('fpts-admin-banner-publish').addEventListener('click', function () {
      var n = _overrideCount();
      var hasConfig = _hasConfigOverrides();
      if (!n && !hasConfig) { _flashBanner('No overrides to publish.'); return; }
      if (!_ghReady()) {
        window.alert('GitHub PAT not configured. Click ⚙ Settings to set it.');
        return;
      }
      // Dry-run preview: fetch latest GitHub state, compute diff, show the
      // operator what's about to commit. On confirm, publishToGitHub does
      // its own GET-merge-PUT (the extra GET is negligible vs the 5000/hr
      // rate limit). Layers on top of the stale-CSV defense already in
      // publishToGitHub.
      var s = _ghSettings();
      var configSettings = Object.assign({}, s, { path: DEFAULT_GH_CONFIG_PATH });
      var btn = document.getElementById('fpts-admin-banner-publish');
      if (btn) { btn.disabled = true; btn.textContent = 'Loading preview…'; btn.style.opacity = '.65'; }

      Promise.all([
        n > 0
          ? _ghGetFile(s).then(function (existing) {
              var latest = _parseTiersCsv(_utf8Atob(existing.content));
              var merged = _applyOverridesToData(latest, _readOverrides());
              return _buildPlayerDiff(latest, merged);
            })
          : Promise.resolve([]),
        hasConfig
          ? _ghGetFile(configSettings).then(function (existing) {
              var latestCfg = {};
              try { latestCfg = JSON.parse(_utf8Atob(existing.content) || '{}'); } catch (e) {}
              var mergedCfg = {};
              try { mergedCfg = JSON.parse(_buildOverriddenTierConfigJson()); } catch (e) {}
              return _buildConfigDiff(latestCfg, mergedCfg);
            })
          : Promise.resolve([]),
      ]).then(function (results) {
        if (btn) { btn.disabled = false; btn.textContent = 'Publish ⬆'; btn.style.opacity = '1'; }
        return _openPublishPreviewModal(results[0], results[1]);
      }).then(function (confirmed) {
        if (confirmed) publishToGitHub();
      }).catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Publish ⬆'; btn.style.opacity = '1'; }
        console.error('[admin-tiers] preview failed:', err);
        window.alert('Could not load preview from GitHub:\n\n' + err.message + '\n\n(Nothing was published.)');
      });
    });

    document.getElementById('fpts-admin-banner-settings').addEventListener('click', _openSettings);
    document.getElementById('fpts-admin-banner-add').addEventListener('click', _openAddPlayerModal);

    // "Clear all" — wipes overrides AND auto-reloads so the user sees the
    // restored TAT-default tiers immediately. The prior "reload required"
    // warning text was confusing (the action was incomplete-feeling without
    // a manual reload).
    document.getElementById('fpts-admin-banner-clear').addEventListener('click', function () {
      var n = _overrideCount();
      if (!n) { _flashBanner('No overrides to clear.'); return; }
      if (confirm('Clear all ' + n + ' tier override' + (n === 1 ? '' : 's') +
                  ' on this device?\n\n' +
                  'This reloads the page so every player snaps back to the ' +
                  'TAT-default tier. Admin mode stays ON.')) {
        clearAllOverrides();
        window.location.reload();
      }
    });

    // "Disable" — turns off admin mode. Asks separately whether to also
    // clear overrides because the two are distinct intents:
    //   - keep overrides: your tier edits stay live on this device; only
    //     the editor UI hides. Use this if you're done editing for now
    //     but want your changes to still show on the page.
    //   - clear overrides: full revert. Page snaps back to TAT-default for
    //     everyone (on this device). Most common "I'm done" path.
    document.getElementById('fpts-admin-banner-disable').addEventListener('click', function () {
      var n = _overrideCount();
      if (!confirm('Disable admin mode on this device?')) return;
      var clearToo = false;
      if (n > 0) {
        clearToo = confirm(
          'You have ' + n + ' saved tier override' + (n === 1 ? '' : 's') +
          ' on this device.\n\n' +
          'OK = clear them too (page reverts to TAT-default tiers)\n' +
          'Cancel = keep them saved (your edits stay applied; only the ' +
          'editor UI hides)'
        );
      }
      if (clearToo) {
        clearAllOverrides();
      }
      try { localStorage.removeItem(STORAGE_KEY_MODE); } catch (e) {}
      window.location.reload();
    });
    _refreshBanner();
  }
  function _refreshBanner() {
    if (!_banner) return;
    var n = _overrideCount();
    var label = (n === 0) ? 'No overrides yet' : (n + ' override' + (n === 1 ? '' : 's') + ' on this device');
    var el = document.getElementById('fpts-admin-banner-count');
    if (el) el.textContent = '· ' + label;
    // Publish button visual state — dim when there's nothing to publish
    // OR when PAT isn't configured (clicking it shows a helpful message
    // either way, but the dimming sets correct expectations).
    var pub = document.getElementById('fpts-admin-banner-publish');
    if (pub) {
      var hasConfig = _hasConfigOverrides();
      var enabled = (n > 0 || hasConfig) && _ghReady();
      pub.style.opacity = enabled ? '1' : '.5';
      var bits = [];
      if (n > 0)      bits.push(n + ' player override' + (n === 1 ? '' : 's'));
      if (hasConfig)  bits.push('tier config');
      pub.title = enabled
        ? ('Publish ' + bits.join(' + ') + ' via GitHub API.')
        : ((n === 0 && !hasConfig) ? 'No overrides to publish.' : 'GitHub PAT not configured. Click ⚙ Settings first.');
    }
  }
  function _flashBanner(msg) {
    var el = document.getElementById('fpts-admin-banner-flash');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    setTimeout(function () { el.style.opacity = '0'; }, 2200);
  }

  // ── Per-row edit pencil + popover ───────────────────────────────────────
  // Returns the HTML for an inline edit pencil. Consumers (tiers.html row
  // template) include this string adjacent to the tier badge. Returns ''
  // when admin mode is off so the row is unchanged for regular visitors.
  function editButtonHtml(playerName) {
    if (!isActive()) return '';
    var safe = String(playerName || '').replace(/"/g, '&quot;');
    return '<button type="button" class="fpts-adm-edit-btn" data-player="' + safe +
           '" title="Edit tier / B-S-H for ' + safe + '"' +
           ' style="background:transparent;border:none;color:var(--red);cursor:pointer;font-size:13px;padding:0 4px;margin-left:4px;line-height:1">✎</button>';
  }

  var _popover = null;
  function _ensurePopoverMounted() {
    if (_popover) return _popover;
    _popover = document.createElement('div');
    _popover.id = 'fpts-adm-popover';
    Object.assign(_popover.style, {
      position: 'absolute',
      zIndex: '210',
      background: 'var(--surface)',
      border: '2px solid var(--red)',
      padding: '12px',
      minWidth: '260px',
      boxShadow: '0 6px 24px rgba(0,0,0,.5)',
      display: 'none',
      fontFamily: "'Mulish', sans-serif",
      fontSize: '12px',
      color: 'var(--white)',
    });
    document.body.appendChild(_popover);
    document.addEventListener('click', function (e) {
      if (_popover.style.display === 'none') return;
      if (_popover.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.fpts-adm-edit-btn')) return;
      _popover.style.display = 'none';
    });
    return _popover;
  }

  function _openPopover(triggerEl, playerName) {
    _ensurePopoverMounted();
    var rec = (window.TIERS_DATA && window.TIERS_DATA[playerName]) || {};
    var overrides = _readOverrides();
    var hasOverride = !!overrides[playerName];
    var tierOpts = TIERS.map(function (t) {
      return '<option value="' + t + '"' + (t === rec.tier ? ' selected' : '') + '>' + t + '</option>';
    }).join('');
    var bshOpts = BSHS.map(function (b) {
      var label = b ? b.charAt(0).toUpperCase() + b.slice(1) : '— none —';
      return '<option value="' + b + '"' + (b === (rec.buySell || '') ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
    var priorityOpts = PRIORITIES.map(function (p) {
      var label = p || '— none —';
      return '<option value="' + p + '"' + (p === (rec.priority || '') ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
    var contenderOpts = CONTENDERS.map(function (c) {
      var label = c || '— none —';
      return '<option value="' + c + '"' + (c === (rec.contender || '') ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
    var selStyle = 'width:100%;margin-top:3px;background:var(--surface2);color:var(--white);border:1px solid var(--border);padding:5px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic';
    _popover.innerHTML = ''
      + '<div style="font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:13px;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">' + playerName + '</div>'
      + '<label style="display:block;margin-bottom:8px">Tier'
      +   '<select id="fpts-adm-tier" style="' + selStyle + '">'
      +     '<option value="">— none —</option>' + tierOpts
      +   '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:8px">Buy / Sell / Hold'
      +   '<select id="fpts-adm-bsh" style="' + selStyle + '">'
      +     bshOpts
      +   '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:8px">Priority Level'
      +   '<select id="fpts-adm-priority" style="' + selStyle + '">'
      +     priorityOpts
      +   '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:8px">Contender / Rebuild'
      +   '<select id="fpts-adm-contender" style="' + selStyle + '">'
      +     contenderOpts
      +   '</select>'
      + '</label>'
      + '<label style="display:block;margin-bottom:10px">Trending'
      +   '<select id="fpts-adm-trending" style="' + selStyle + '">'
      +     TRENDINGS.map(function (t) {
              var current = _trendingNormalize(rec.trending);
              return '<option value="' + t + '"' + (t === current ? ' selected' : '') + '>' + TRENDING_LABELS[t] + '</option>';
            }).join('')
      +   '</select>'
      + '</label>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
      +   '<button type="button" id="fpts-adm-save" style="flex:1;background:var(--red);color:#111;border:none;padding:6px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:11px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Save</button>'
      +   '<button type="button" id="fpts-adm-cancel" style="background:transparent;color:var(--white);border:1px solid var(--border2);padding:6px 10px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:11px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Cancel</button>'
      + '</div>'
      + '<div style="display:flex;gap:6px;margin-top:6px">'
      +   (hasOverride
        ? '<button type="button" id="fpts-adm-reset" style="flex:1;background:transparent;color:var(--white);border:1px solid var(--border2);padding:5px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:10px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Reset to default</button>'
        : '')
      +   '<button type="button" id="fpts-adm-remove" style="flex:1;background:transparent;color:var(--red);border:1px solid var(--red);padding:5px;font-family:\'Kanit\',sans-serif;font-weight:800;font-style:italic;font-size:10px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Remove from tiers</button>'
      + '</div>'
      + '<div style="margin-top:8px;font-size:10px;opacity:.55">Saved on this device only. Use "Publish ⬆" in the banner to push to GitHub.</div>';

    // Position below the trigger.
    var rect = triggerEl.getBoundingClientRect();
    var bodyZoom = (function () {
      var v = parseFloat(getComputedStyle(document.body).zoom);
      return (isFinite(v) && v > 0) ? v : 1;
    })();
    _popover.style.display = 'block';
    _popover.style.left = ((rect.left + window.scrollX) / bodyZoom) + 'px';
    _popover.style.top  = ((rect.bottom + window.scrollY + 4) / bodyZoom) + 'px';

    document.getElementById('fpts-adm-save').addEventListener('click', function () {
      var tier      = document.getElementById('fpts-adm-tier').value || '';
      var buySell   = document.getElementById('fpts-adm-bsh').value || '';
      var priority  = document.getElementById('fpts-adm-priority').value || '';
      var contender = document.getElementById('fpts-adm-contender').value || '';
      var trending  = document.getElementById('fpts-adm-trending').value || '';
      saveOverride(playerName, {
        tier: tier, buySell: buySell, priority: priority,
        contender: contender, trending: trending,
      });
      _popover.style.display = 'none';
      _flashBanner('Saved ' + playerName + '.');
    });
    document.getElementById('fpts-adm-cancel').addEventListener('click', function () {
      _popover.style.display = 'none';
    });
    var resetBtn = document.getElementById('fpts-adm-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        clearOverride(playerName);
        _popover.style.display = 'none';
        _flashBanner('Reset ' + playerName + ' (reload to see original).');
      });
    }
    var removeBtn = document.getElementById('fpts-adm-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        if (!confirm('Remove ' + playerName + ' from the tier list?\n\n' +
                     'They\'ll be hidden from the tiers table until you click ' +
                     '"Reset to default" on this player or Clear All in the banner. ' +
                     'Publishing while this player is removed will omit them from ' +
                     'data/source/tiers/tiers.csv.')) return;
        removePlayer(playerName);
        _popover.style.display = 'none';
        _flashBanner('Removed ' + playerName + '. Publish to make it permanent.');
      });
    }
  }

  // Delegated click handler for any [data-player] edit button on the page.
  function _wireDelegatedClicks() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.fpts-adm-edit-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var name = btn.getAttribute('data-player');
      if (name) _openPopover(btn, name);
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────
  // Async because the password gate needs WebCrypto.subtle.digest (returns
  // a Promise). DOMContentLoaded fires init synchronously but doesn't wait
  // on the returned Promise — that's fine; the async work proceeds in the
  // background and the banner mounts when the gate resolves.
  async function init() {
    await _handleUrlParam();
    if (!isActive()) return;
    _mountBanner();
    _wireDelegatedClicks();
  }

  // Public surface (used by tiers.html row template + console helpers).
  window.AdminTiers = {
    isActive:           isActive,
    editButtonHtml:     editButtonHtml,
    saveOverride:       saveOverride,
    clearOverride:      clearOverride,
    clearAllOverrides:  clearAllOverrides,
    exportToClipboard:  exportToClipboard,
    overrideCount:      _overrideCount,
    // Exposed for console-driven setup: `await AdminTiers.hashPassword('mypw')`
    // returns the SHA-256 hex you'd paste into PASSWORD_HASH. The ?admin=hash
    // URL helper does the same via a prompt UI; this is the dev-friendly path.
    hashPassword:       hashPassword,
    // Phase 1b — GitHub publish surface for console + automation:
    publish:            publishToGitHub,
    openSettings:       _openSettings,
    // Phase 2 — add/remove players from the tier list:
    openAddPlayer:      _openAddPlayerModal,
    removePlayer:       removePlayer,
    // Phase 3 — tier title rename + reorder:
    effectiveTierConfig: effectiveTierConfig,
    setTierTitle:       setTierTitle,
    moveTier:           moveTier,
    // Phase 4 — per-tier player ordering (drag-and-drop from tiers.html):
    sortPlayersForTier: sortPlayersForTier,
    setPlayerOrder:     setPlayerOrder,
    // Phase 5 — tier section drag-and-drop (drag handler in tiers.html):
    setTierOrder:       setTierOrder,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
