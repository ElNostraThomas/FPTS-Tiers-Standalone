/* ════════════════════════════════════════════════════════════════════════
   FPTS data-bootstrap — shared data layer for every page.
   ════════════════════════════════════════════════════════════════════════

   PURPOSE
     Centralizes the data-fetch + window-mirror + payload-apply machinery
     that used to be hand-rolled in every page. New pages drop this script
     in and get every JSON in data/ pre-loaded, every shared module
     (player-panel, heatmap, mvs-extras, articles) auto-fed in lockstep.

   USAGE
     In <head>, before this script:
       <script>
         window.FPTS_CURRENT_PAGE = 'newpage';        // required
         window.FPTS_DATA_OPTS = { skip: [] };        // optional opt-outs
       </script>
       <script src="assets/js/data-bootstrap.js?v=..." defer></script>

     Page-specific code waits for the data:
       document.addEventListener('fpts:data-ready', () => {
         // window.FP_VALUES, window.PICK_VALUES, window.MVS_PAYLOAD, etc.
         // are all hydrated and ready to read.
       });

   WHAT IT POPULATES
     window.FP_VALUES              — { [name]: { value, age, team, pos, ... } }
     window.PICK_VALUES            — { [key]: { value, valueSf, value1qb, label } }
     window.SLEEPER_IDS            — { [name]: sleeperId } (auto-built from FP_VALUES if page didn't pre-seed it)
     window.STATS_DATA             — { [key]: rawStats } from data/stats.json. Keys are 'sid:<id>' or 'name:<normalized name>'. Downstream callers look up via `STATS_DATA['name:' + normalizePlayerName(name)]` or `'sid:' + sleeperId`.
     window.ADP_PAYLOAD            — raw adp.json
     window.AUCTION_PAYLOAD        — raw auction.json
     window.MVS_PAYLOAD            — raw mvs.json
     window.PLAYER_ARTICLES        — { [name]: [articles] }
     window.PICK_AVAILABILITY      — { [sleeperId]: { matrix, dropoff, ... } }
     window.PICK_AVAILABILITY_META — { version, season, teamCount, topN } drives the heatmap "Data refreshed" stamp
     window.FPTS_DATA              — public API: { ready: Promise, version, _apply* helpers }

   OPT-OUTS (set in FPTS_DATA_OPTS.skip)
     'values' 'adp' 'auction' 'picks' 'mvs' 'articles' 'pick-availability' 'stats'
     Default: fetch everything. Most pages should NOT opt out — the shared
     player-panel drawer depends on the full set being present.

   CONSISTENCY GUARANTEE
     adp.json, auction.json, and pick-availability.json are written in the
     same `sync-adp.py` invocation with identical `version` timestamps. The
     bootstrap fetches them as one Promise.all, so any page using this
     module gets all three in lockstep automatically. The heatmap "Data
     refreshed" stamp on every page will always equal the ADP refresh date.

   LOAD ORDER WITH team-helpers.js
     If a page also uses team-helpers.js (for team-logo badges + inline
     logos in place of "ATL"/"BUF" text), it MUST be loaded BEFORE
     player-panel.js — that module checks window.TeamHelpers when it
     renders the modal-hero avatar badge + team-text setter. data-bootstrap.js
     itself doesn't depend on team-helpers; the helpers are pure utilities
     and can load at any time relative to this script.
   ════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ─── Initialize window globals (idempotent — page pre-seeds preserved) ──
  if (!global.FP_VALUES)               global.FP_VALUES = {};
  if (!global.PICK_VALUES)             global.PICK_VALUES = {};
  if (!global.SLEEPER_IDS)             global.SLEEPER_IDS = {};
  if (!global.ADP_PAYLOAD)             global.ADP_PAYLOAD = null;
  if (!global.AUCTION_PAYLOAD)         global.AUCTION_PAYLOAD = null;

  // ─── Shared helpers ──────────────────────────────────────────────────────

  function normalizePlayerName(name) {
    if (!name) return '';
    return String(name)
      .trim()
      .toLowerCase()
      .replace(/\./g, '')         // strip periods ("D.J." vs "DJ", "Jr." vs "Jr")
      .replace(/\s+/g, ' ');      // collapse whitespace
  }

  function _indexByNorm(list) {
    const out = {};
    (list || []).forEach(p => {
      if (!p || !p.name) return;
      const key = normalizePlayerName(p.name);
      if (key) out[key] = p;
    });
    return out;
  }

  if (typeof global.normalizePlayerName !== 'function') {
    global.normalizePlayerName = normalizePlayerName;
  }

  // ─── Payload appliers (canonical implementations) ────────────────────────

  // ──────────────────────────────────────────────────────────────────
  // ADP CLEANUP FILTER — applied at boot to drop two big sources of
  // noise from the displayed ADP rankings:
  //
  //   1. Kickers / DEF / IDP in fantasy-position contexts. Rookie ADP
  //      ships with kickers ranked alongside QBs because a tiny number
  //      of leagues draft kickers in round 2-3 of rookie drafts. The
  //      data is correct but pollutes "real prospect" rankings.
  //
  //   2. Tiny-sample entries: a player drafted in only 5-12 leagues
  //      out of ~10,000+ in the corpus shows up with a respectable
  //      ADP because those handful of leagues drafted them early. The
  //      rank field is sorted by ADP regardless of sample size, so a
  //      12-draft player at ADP 20 sits at rank 18, ahead of 1000s of
  //      "actually drafted" players at higher ADPs.
  //
  // Filter rule per (month, format) bucket:
  //   1. Position ∈ {QB, RB, WR, TE} — drops K / DEF / IDP from fantasy
  //      rankings.
  //   2. drafts >= max(ADP_FILTER_ABS_FLOOR, floor(corpus_max × 10%))
  //      — scale-aware floor. A player drafted in fewer than 10% of the
  //      leagues that drafted this corpus's top player is fringe noise.
  //      The 10% rule self-adjusts per format: rookie_draft_sf (max
  //      10,919 drafts) → floor ≈ 1,091; rookie_draft_1qb (max ~586)
  //      → floor ≈ 58. Auto-handles the corpus-size disparity between
  //      SF (~10K leagues scraped) and 1QB (~hundreds).
  //   3. Absolute floor of 25 catches tiny corpora that 10% would zero
  //      out (1QB startup max is ~50 drafts — corpus barely usable as
  //      consensus signal but the floor preserves some signal).
  //
  // Filtered list is what every consumer sees via window.ADP_PAYLOAD.
  // The raw, un-filtered version stays available under
  // window.ADP_PAYLOAD_RAW for the ADP tool's "show fringe players"
  // research mode.
  //
  // Re-rank within each filtered bucket so visible "rank" reflects the
  // cleaned ordering (1 = lowest ADP = drafted earliest in consensus).
  // ──────────────────────────────────────────────────────────────────
  const ADP_FILTER_ABS_FLOOR  = 25;
  const ADP_FILTER_RATIO      = 0.10;   // 10% of corpus max
  const ADP_FILTER_KEEP_POS   = new Set(['QB','RB','WR','TE']);

  function _cleanAdpPayload(raw) {
    if (!raw || !raw.byMonth) return raw;
    const out = Object.assign({}, raw, { byMonth: {} });
    Object.keys(raw.byMonth).forEach(month => {
      out.byMonth[month] = {};
      Object.keys(raw.byMonth[month] || {}).forEach(fmt => {
        const lst = raw.byMonth[month][fmt] || [];
        // Determine this bucket's draft floor: 10% of the bucket's max
        // drafts (after position-filter), with an absolute minimum.
        let maxDrafts = 0;
        for (const r of lst) {
          if (!r) continue;
          const pos = (r.position || r.pos || '').toUpperCase();
          if (!ADP_FILTER_KEEP_POS.has(pos)) continue;
          const d = +(r.drafts) || 0;
          if (d > maxDrafts) maxDrafts = d;
        }
        const floor = Math.max(ADP_FILTER_ABS_FLOOR, Math.floor(maxDrafts * ADP_FILTER_RATIO));
        // Filter + clone each record so re-rank doesn't mutate raw records.
        const filtered = lst.filter(r => {
          if (!r) return false;
          const pos = (r.position || r.pos || '').toUpperCase();
          if (!ADP_FILTER_KEEP_POS.has(pos)) return false;
          if (r.drafts != null && r.drafts < floor) return false;
          return true;
        }).map(r => Object.assign({}, r));
        // Re-rank by ADP asc (1 = lowest ADP = drafted earliest)
        filtered.sort((a, b) => (a.adp != null ? a.adp : 9999) - (b.adp != null ? b.adp : 9999));
        filtered.forEach((r, i) => { r.rank = i + 1; });
        out.byMonth[month][fmt] = filtered;
      });
    });
    return out;
  }

  function _applyAdpPayload(j) {
    if (!j || !j.byMonth) return;
    // Preserve raw payload for the ADP tool's research mode AND for the
    // per-player FP_VALUES.adp overlay below — that overlay sets the
    // single ADP scalar on each FP record by name, and we want every
    // player who appears in the ADP corpus to get an ADP value (even
    // fringe ones), so use RAW for the overlay's lookup. Only the
    // ranked-display path (byMonth) gets the filter.
    global.ADP_PAYLOAD_RAW = j;
    // Default ADP_PAYLOAD is the cleaned version — every consumer that
    // reads byMonth lists for ranking-display sees filtered ranks.
    const j_clean = _cleanAdpPayload(j);
    global.ADP_PAYLOAD = j_clean;
    if (global.applySeasonBadge) global.applySeasonBadge(j_clean.season);
    // Overlay onto FP_VALUES uses the RAW byMonth so per-player .adp
    // gets set even for low-draft entries (display-side filter doesn't
    // need to leak into the per-player value layer).
    const all = j.byMonth.ALL || {};
    const sfByKey  = _indexByNorm(all.startup_sf);
    const oneByKey = _indexByNorm(all.startup_1qb);
    if (global.ADP_DATA && typeof global.ADP_DATA === 'object') {
      Object.values(sfByKey).forEach(p => {
        global.ADP_DATA[p.name] = global.ADP_DATA[p.name] || {};
        global.ADP_DATA[p.name].sf = { overall: p.adp, posRank: p.posRank };
      });
      Object.values(oneByKey).forEach(p => {
        global.ADP_DATA[p.name] = global.ADP_DATA[p.name] || {};
        global.ADP_DATA[p.name].oneqb = { overall: p.adp, posRank: p.posRank };
      });
    }
    const FP = global.FP_VALUES;
    if (!FP) return;

    let _fmt = 'sf';
    try { const _v = localStorage.getItem('fpts-adp-format'); if (_v === '1qb' || _v === 'sf') _fmt = _v; } catch (e) {}

    const canonByKey = _fmt === '1qb' ? oneByKey : sfByKey;
    const fallByKey  = _fmt === '1qb' ? sfByKey  : oneByKey;

    // ADP overlay writes only .adp. Trend is owned by MVS (overwrites in
    // _applyMvsPayload below); for players MVS doesn't cover, the FP-API
    // trend from values.json stays in place as a fallback.
    Object.entries(FP).forEach(([fpName, rec]) => {
      const key = normalizePlayerName(fpName);
      const p = canonByKey[key] || fallByKey[key];
      if (p) rec.adp = p.adp;
    });
  }

  function _applyAuctionPayload(j) {
    if (!j || !j.byMonth) return;
    global.AUCTION_PAYLOAD = j;
    const all = j.byMonth.ALL || {};
    const sfByKey  = _indexByNorm(all.startup_sf);
    const oneByKey = _indexByNorm(all.startup_1qb);
    function fmt(p) { return (p && p.med != null) ? ('$' + Math.round(p.med)) : null; }
    const FP = global.FP_VALUES;
    if (!FP) return;
    Object.entries(FP).forEach(([fpName, rec]) => {
      const key = normalizePlayerName(fpName);
      const one = oneByKey[key];
      const sf  = sfByKey[key];
      rec.auction   = fmt(one) || fmt(sf) || rec.auction || null;
      rec.auctionSf = fmt(sf)              || rec.auctionSf || null;
    });
  }

  function _applyMvsPayload(j) {
    if (!j || !j.players) return;
    global.MVS_PAYLOAD = j;

    let _fmt = 'sf';
    try { const _v = localStorage.getItem('fpts-adp-format'); if (_v === '1qb' || _v === 'sf') _fmt = _v; } catch (e) {}

    const FP = global.FP_VALUES;
    const PV = global.PICK_VALUES;

    if (FP) {
      const fpByNorm = {};
      Object.keys(FP).forEach(n => { fpByNorm[normalizePlayerName(n)] = n; });
      const overlaid = new Set();
      Object.entries(j.players).forEach(([name, mvs]) => {
        const fpName = FP[name] ? name : fpByNorm[normalizePlayerName(name)];
        const target = fpName ? FP[fpName] : (FP[name] = { sleeperId: mvs.sleeperId, pos: mvs.position });
        target.valueSf  = mvs.valueSf;
        target.value1qb = mvs.value1qb;
        target.value    = (_fmt === '1qb') ? mvs.value1qb : mvs.valueSf;
        target.baselineSf  = mvs.baseline;
        target.baseline1qb = mvs.baseline1qb;
        target.baseline    = (_fmt === '1qb') ? mvs.baseline1qb : mvs.baseline;
        target.trend       = (_fmt === '1qb') ? mvs.trend1qb : mvs.trend;
        target.tradesLastWeekSf  = mvs.tradesLastWeek;
        target.tradesLastWeek1qb = mvs.tradesLastWeek1qb;
        target.tradesLastWeek    = (_fmt === '1qb') ? mvs.tradesLastWeek1qb : mvs.tradesLastWeek;
        target.historySf  = mvs.history;
        target.history1qb = mvs.history1qb;
        target.history    = (_fmt === '1qb') ? mvs.history1qb : mvs.history;
        target.otcValue       = mvs.otcValue;
        target.otcDiff        = mvs.otcDiff;
        target.rankings       = mvs.rankings;
        target.recentTrades   = mvs.recentTrades;
        target.lastUpdated    = mvs.lastUpdated;
        overlaid.add(target);
      });
      // Wholesale replacement: zero out value for FP players MVS doesn't cover.
      Object.values(FP).forEach(rec => {
        if (overlaid.has(rec)) return;
        rec.value = 0; rec.valueSf = 0; rec.value1qb = 0;
      });
    }

    if (PV && j.picks) {
      Object.entries(j.picks).forEach(([key, rec]) => {
        PV[key] = {
          value:    (_fmt === '1qb') ? rec.value1qb : rec.valueSf,
          valueSf:  rec.valueSf,
          value1qb: rec.value1qb,
          valueTep: rec.valueSf,  // backward-compat alias
          label:    rec.label,
        };
      });
    }
  }

  // ─── Fetch + hydrate ─────────────────────────────────────────────────────

  const opts = global.FPTS_DATA_OPTS || {};
  const skip = new Set(opts.skip || []);
  const v = '?v=' + (global.__DATA_VERSION || Date.now());

  function _fetchJson(path) {
    return fetch(path + v).then(r => r.ok ? r.json() : null).catch(() => null);
  }

  function _maybe(name, path) {
    return skip.has(name) ? Promise.resolve(null) : _fetchJson(path);
  }

  const ready = Promise.all([
    _maybe('values',            'data/values.json'),
    _maybe('adp',               'data/adp.json'),
    _maybe('auction',           'data/auction.json'),
    _maybe('picks',             'data/picks.json'),
  ]).then(function (results) {
    const [values, adp, auction, picks] = results;

    // Apply in canonical order (standalone tiers — drawer-only payloads dropped):
    //   1. values  — seeds FP_VALUES with all players
    //   2. adp     — overlays .adp and ADP-derived .trend onto FP_VALUES
    //   3. auction — overlays .auction and .auctionSf
    //   4. picks   — seeds PICK_VALUES with pick slot record-shapes
    if (values && values.players) Object.assign(global.FP_VALUES, values.players);
    if (adp)                       _applyAdpPayload(adp);
    if (auction)                   _applyAuctionPayload(auction);
    if (picks && picks.picks)      Object.assign(global.PICK_VALUES, picks.picks);

    // Auto-populate SLEEPER_IDS from FP_VALUES if the page didn't pre-seed it.
    // Pages that ship a hand-curated SLEEPER_IDS dict (e.g. trade-calculator)
    // will skip this branch because the dict is non-empty before bootstrap runs.
    if (Object.keys(global.SLEEPER_IDS).length === 0) {
      Object.entries(global.FP_VALUES).forEach(function (entry) {
        const name = entry[0], rec = entry[1];
        if (rec && rec.sleeperId) global.SLEEPER_IDS[name] = String(rec.sleeperId);
      });
    }

    try {
      document.dispatchEvent(new CustomEvent('fpts:data-ready', {
        detail: {
          version: (adp && adp.version) || (values && values.version) || null,
          page:    global.FPTS_CURRENT_PAGE || null,
        },
      }));
    } catch (e) { /* CustomEvent unavailable in very old browsers — skip */ }
    return results;
  });

  // ─── Public API ──────────────────────────────────────────────────────────

  global.FPTS_DATA = {
    ready: ready,
    get version() {
      return (global.ADP_PAYLOAD && global.ADP_PAYLOAD.version) || null;
    },
    _applyAdpPayload:     _applyAdpPayload,
    _applyAuctionPayload: _applyAuctionPayload,
    normalizePlayerName:  normalizePlayerName,
  };

  // ─── Mobile nav sync ─────────────────────────────────────────────────────
  // The mobile nav is a native <select class="mobile-nav-select"> with a "— Pages —"
  // placeholder option first. Without intervention, every page renders with the
  // placeholder selected — the dropdown never shows "Tiers" / "Rankings" / etc.
  // even when you're already on that page. This sets selectedIndex to the option
  // whose value matches the current URL filename. Idempotent + safe if the page
  // doesn't have the select.
  function _syncMobileNav() {
    try {
      const sel = document.querySelector('.mobile-nav-select');
      if (!sel) return;
      const path = (global.location && global.location.pathname || '').split('/').pop() || 'index.html';
      for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value && sel.options[i].value === path) {
          sel.selectedIndex = i;
          return;
        }
      }
    } catch (e) { /* silent — non-critical UI sync */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _syncMobileNav);
  } else {
    _syncMobileNav();
  }

})(typeof window !== 'undefined' ? window : globalThis);
