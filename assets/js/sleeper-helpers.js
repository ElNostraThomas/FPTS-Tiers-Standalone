/*
 * sleeper-helpers.js — shared trade-engine + Sleeper-data utilities.
 *
 * Pure functions (no DOM). Depend only on two intentionally page-level
 * globals: window.FP_VALUES (player trade-value dict, loaded by
 * data-bootstrap.js) and window.PICK_VALUES (draft-pick value dict, same
 * source). Everything else is passed in as arguments — so each consumer
 * page can shape its own data dict without coupling to the other.
 *
 * Consumers:
 *   - my-leagues.html (the trade-suggestion modal + roster archetype chips)
 *   - live-draft.html (live trade-fair-value at the user's upcoming pick)
 *
 * Surfaces are exposed on window.SLEEPER.*. Function signatures match the
 * original my-leagues inline functions where possible so the migration is
 * mostly a body-swap; the one exception is buildAssetPool, which now takes
 * a plain `data` object instead of looking up `window.ML_ALL_LEAGUE_DATA`
 * by leagueId. The my-leagues caller does the lookup before delegating.
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // Archetype preferences: how much each archetype wants picks vs.
  // youth vs. veterans. Drives mlPackageFit's per-asset scoring inside
  // generateTradeSuggestions.
  // ──────────────────────────────────────────────────────────────────
  const ARCH_PREFS = {
    rebuilder: { wantPicks: 1.0, wantYouth: 1.0, wantVeterans: 0.3 },
    emergency: { wantPicks: 1.0, wantYouth: 0.6, wantVeterans: 0.4 },
    tweener:   { wantPicks: 0.5, wantYouth: 0.5, wantVeterans: 0.5 },
    contender: { wantPicks: 0.3, wantYouth: 0.3, wantVeterans: 1.0 },
    dynasty:   { wantPicks: 0.5, wantYouth: 0.7, wantVeterans: 0.7 },
  };

  // ──────────────────────────────────────────────────────────────────
  // PICK_VALUES lookup. Tries the specific pick key first (e.g.
  // "2026-1.05"), falls back to a generic round key ("2026-1") when the
  // specific slot isn't seeded. Values may be numeric or an object with
  // a .value field; normalize both.
  //
  // formatKey selects which trade-value column to read off the pick
  // record: 'value' (SF default), 'valueSf' (explicit SF), or 'value1qb'
  // (1QB). Default is 'value' so existing callers (my-leagues) keep
  // their prior behavior — live-draft passes 'value1qb' when the active
  // league is 1QB.
  // ──────────────────────────────────────────────────────────────────
  function pickValue(season, round, formatKey) {
    const PV = window.PICK_VALUES || {};
    const key = formatKey || 'value';
    const num = v => {
      if (v && typeof v === 'object') {
        const n = Number(v[key]);
        if (!isNaN(n) && n !== 0) return n;
        // Fall back to the default 'value' if the requested key isn't on
        // this record (defensive against partial data).
        return Number(v.value) || 0;
      }
      return Number(v) || 0;
    };
    const specific = Object.keys(PV).filter(k => k.startsWith(season + '-' + round + '.'));
    if (specific.length) {
      specific.sort();
      return num(PV[specific[Math.floor(specific.length / 2)]]);
    }
    return num(PV[season + '-' + round]);
  }

  function getValueByName(name) {
    if (!name) return null;
    return (window.FP_VALUES || {})[name] || null;
  }

  // ──────────────────────────────────────────────────────────────────
  // getOwnedPicks — given a roster_id and the league's traded_picks
  // ledger, return every pick that roster CURRENTLY owns (natural picks
  // it hasn't traded away + picks acquired via trade). Excludes picks
  // in already-completed draft seasons (those are spent).
  // ──────────────────────────────────────────────────────────────────
  function getOwnedPicks(rosterId, tradedPicks, leagueRounds, currentSeason, completedDraftSeasons) {
    const picks = [];
    const rounds = leagueRounds && leagueRounds > 0 ? Math.min(leagueRounds, 5) : 4;
    const completed = completedDraftSeasons instanceof Set ? completedDraftSeasons : new Set();

    const seasonsSet = new Set();
    (tradedPicks || []).forEach(p => seasonsSet.add(String(p.season)));
    const baseYear = parseInt(currentSeason, 10) || (new Date()).getFullYear();
    for (let s = 0; s < 3; s++) seasonsSet.add(String(baseYear + s));
    const seasons = [...seasonsSet]
      .filter(s => parseInt(s, 10) >= baseYear)
      .filter(s => !completed.has(String(s)))
      .sort();

    const tradedKeys = new Set();
    (tradedPicks || []).forEach(p => {
      tradedKeys.add(p.season + ':' + p.round + ':' + p.roster_id);
    });

    seasons.forEach(season => {
      for (let round = 1; round <= rounds; round++) {
        const key = season + ':' + round + ':' + rosterId;
        if (!tradedKeys.has(key)) {
          picks.push({ season, round, roster_id: rosterId, owner_id: rosterId,
                       isNatural: true, originalRosterId: rosterId });
        }
      }
    });

    (tradedPicks || []).forEach(p => {
      if (completed.has(String(p.season))) return;
      if (String(p.owner_id) === String(rosterId)) {
        picks.push({
          season: String(p.season), round: p.round,
          roster_id: p.roster_id, owner_id: p.owner_id,
          isNatural: false, originalRosterId: p.roster_id,
        });
      }
    });

    picks.sort((a, b) => a.season !== b.season ? a.season.localeCompare(b.season) : a.round - b.round);
    return picks;
  }

  // ──────────────────────────────────────────────────────────────────
  // buildAssetPool — flat list of { id, name, value, pos, age, type } for
  // a roster. type is 'player' or 'pick'. Used as the search space for
  // generateTradeSuggestions.
  //
  // data shape: { rosters, players, tradedPicks, draftRounds,
  //               leagueSeason, completedDraftSeasons }
  // rosterId: the roster whose pool we want.
  // formatKey: 'value' (default — SF-equivalent), 'valueSf', or
  //   'value1qb'. Selects which trade-value column on FP_VALUES + on
  //   PICK_VALUES to read. Live-draft passes 'value1qb' when the active
  //   league is 1QB so QBs are valued correctly vs the SF default.
  // ──────────────────────────────────────────────────────────────────
  function buildAssetPool(data, rosterId, formatKey) {
    if (!data) return [];
    const { rosters, players } = data;
    if (!rosters || !players) return [];
    const roster = rosters.find(r => r.roster_id === rosterId);
    if (!roster) return [];
    const valKey = formatKey || 'value';

    const assets = [];

    (roster.players || []).forEach(pid => {
      const p = players[pid];
      if (!p) return;
      const name = p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
      const fp = getValueByName(name);
      if (!fp) return;
      const playerValue = (fp[valKey] != null ? fp[valKey] : fp.value) || 0;
      if (!playerValue) return;
      assets.push({
        id: 'p_' + pid,
        name,
        value: playerValue,
        pos: p.position || (fp.posRank ? fp.posRank.replace(/\d+/g, '') : '—'),
        age: p.age || fp.age || null,
        type: 'player',
      });
    });

    const owned = getOwnedPicks(rosterId, data.tradedPicks, data.draftRounds,
                                 data.leagueSeason, data.completedDraftSeasons);
    owned.forEach((pk, idx) => {
      const value = pickValue(pk.season, pk.round, valKey) || 0;
      if (!value) return;
      const label = pk.season + ' Round ' + pk.round + (pk.isNatural ? '' : ' (acquired)');
      assets.push({
        id: 'pk_' + idx + '_' + pk.season + '_' + pk.round,
        name: label,
        value,
        pos: 'PICK',
        age: null,
        type: 'pick',
        season: pk.season,
        round: pk.round,
      });
    });

    return assets;
  }

  function packageFit(pkg, archetype) {
    const prefs = ARCH_PREFS[archetype] || ARCH_PREFS.tweener;
    let score = 0, weight = 0;
    pkg.forEach(a => {
      const w = a.value;
      weight += w;
      if (a.type === 'pick') score += prefs.wantPicks * w;
      else if (a.age && a.age <= 24) score += prefs.wantYouth * w;
      else score += prefs.wantVeterans * w;
    });
    return weight > 0 ? score / weight : 0;
  }

  function fitNote(pkg, archetype, fitScore) {
    if (!archetype) return '';
    const A = archetype.toUpperCase();
    if (fitScore >= 0.7) return '✓ Aligns with ' + A + ' preferences';
    if (fitScore >= 0.5) return '~ Reasonable fit for ' + A;
    return '⚠ May not interest a ' + A;
  }

  // ──────────────────────────────────────────────────────────────────
  // generateTradeSuggestions — given a roster's asset pool, a target
  // trade value (what we're trying to match), and an archetype, surface
  // up to N candidate packages that hit the target ±15% with diversity
  // across 1-/2-/3-asset packages + slight-overpay + archetype-tilted.
  // ──────────────────────────────────────────────────────────────────
  function generateTradeSuggestions(myAssets, targetValue, archetype, maxCount) {
    if (!targetValue || !myAssets || !myAssets.length) return [];
    const N = maxCount || 5;
    const minSize = Math.max(50, targetValue * 0.05);
    const pool = myAssets.filter(a => a.value >= minSize).sort((a, b) => b.value - a.value);

    const candidates = [];
    const tryAdd = (assets, kindLabel) => {
      const total = assets.reduce((s, a) => s + a.value, 0);
      const ratio = total / targetValue;
      if (ratio < 0.85 || ratio > 1.30) return;
      const sig = assets.map(a => a.id).sort().join('|');
      if (candidates.some(c => c.sig === sig)) return;
      candidates.push({ assets, total, ratio, sig, kind: kindLabel });
    };

    pool.forEach(a => tryAdd([a], '1-asset'));

    for (let i = 0; i < Math.min(pool.length, 12); i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const sum = pool[i].value + pool[j].value;
        if (sum < targetValue * 0.85 || sum > targetValue * 1.30) continue;
        tryAdd([pool[i], pool[j]], '2-asset');
      }
    }

    for (let i = 0; i < Math.min(pool.length, 8); i++) {
      for (let j = i + 1; j < Math.min(pool.length, 12); j++) {
        for (let k = j + 1; k < pool.length; k++) {
          const sum = pool[i].value + pool[j].value + pool[k].value;
          if (sum < targetValue * 0.85 || sum > targetValue * 1.30) continue;
          tryAdd([pool[i], pool[j], pool[k]], '3-asset');
        }
      }
    }

    if (!candidates.length) return [];

    candidates.forEach(c => {
      const valueFit = 1 - Math.min(Math.abs(c.ratio - 1), 0.30) / 0.30;
      const archFit  = packageFit(c.assets, archetype);
      const fewer    = 1 - (c.assets.length - 1) * 0.05;
      c.fitScore     = (valueFit * 0.55 + archFit * 0.35 + fewer * 0.10);
      c.archFit      = archFit;
    });

    candidates.sort((a, b) => b.fitScore - a.fitScore);

    const picked = [];
    const pickedSigs = new Set();
    const pickFrom = (filterFn, label) => {
      const found = candidates.find(c => !pickedSigs.has(c.sig) && filterFn(c));
      if (found) {
        picked.push(Object.assign({}, found, { label }));
        pickedSigs.add(found.sig);
      }
    };
    pickFrom(c => c.kind === '1-asset' && c.ratio >= 0.95 && c.ratio <= 1.05, 'FAIR VALUE — 1 ASSET');
    pickFrom(c => c.kind === '2-asset' && c.ratio >= 0.95 && c.ratio <= 1.05, 'FAIR VALUE — 2 ASSETS');
    pickFrom(c => c.ratio > 1.05 && c.ratio <= 1.15, 'SLIGHT OVERPAY');
    pickFrom(c => c.kind === '3-asset' && c.ratio >= 0.95 && c.ratio <= 1.10, 'VALUE PACKAGE — 3 ASSETS');
    pickFrom(c => c.archFit >= 0.65 && c.ratio >= 0.92 && c.ratio <= 1.15, 'ARCHETYPE-TILTED');
    for (const c of candidates) {
      if (picked.length >= N) break;
      if (pickedSigs.has(c.sig)) continue;
      picked.push(Object.assign({}, c, { label: 'ALTERNATIVE' }));
      pickedSigs.add(c.sig);
    }

    return picked.slice(0, N).map(c => ({
      label: c.label,
      sending: c.assets.map(a => ({ name: a.name, pos: a.pos, value: a.value, type: a.type, age: a.age })),
      totalSent: c.total,
      fitScore: c.fitScore,
      fitNote: fitNote(c.assets, archetype, c.archFit),
      ratio: c.ratio,
    }));
  }

  // ──────────────────────────────────────────────────────────────────
  // archetypeFromTotals — composite of trade value + pick value +
  // projection-vs-league-median, paired with age-vs-league-median, to
  // bucket a roster into one of dynasty / contender / tweener /
  // rebuilder / emergency.
  // ──────────────────────────────────────────────────────────────────
  function archetypeFromTotals(avgAge, totalValue, pickVal, projValue, leagueAvg) {
    if (!leagueAvg || !leagueAvg.age || !leagueAvg.value) return 'tweener';
    const valNorm  = (totalValue || 0) / (leagueAvg.value || 1);
    const pickNorm = leagueAvg.pickValue ? ((pickVal || 0) / leagueAvg.pickValue) : 1;
    const projNorm = leagueAvg.proj      ? ((projValue || 0) / leagueAvg.proj)    : 1;
    const composite = 0.6 * valNorm + 0.2 * pickNorm + 0.2 * projNorm;

    const valueHigh = composite > 1.10;
    const valueLow  = composite < 0.90;
    const ageYoung  = avgAge < leagueAvg.age - 0.6;
    const ageOld    = avgAge > leagueAvg.age + 0.6;

    if (valueHigh && ageYoung) return 'dynasty';
    if (valueHigh)              return 'contender';
    if (valueLow  && ageOld)    return 'emergency';
    if (valueLow  && ageYoung)  return 'rebuilder';
    if (valueLow)               return 'rebuilder';
    if (ageYoung) return 'rebuilder';
    if (ageOld)   return 'emergency';
    return 'tweener';
  }

  function archetypeLabel(key) {
    return ({
      dynasty:   'Dynasty',
      contender: 'Contender',
      tweener:   'Tweener',
      rebuilder: 'Rebuilder',
      emergency: 'Emergency',
    })[key] || 'Tweener';
  }

  // ──────────────────────────────────────────────────────────────────
  // SCORING OVERLAY — turn a raw stat line into league-adjusted fantasy
  // points. Single source of truth so live-draft + my-leagues (and any
  // future page) produce identical numbers for the same league.
  //
  // Base scoring is full-PPR + 4-pt pass TD. The overlay applies:
  //   - half-PPR / standard adjustment: subtract receptions as needed
  //   - pass-TD bonus: (pass_td_pts - 4) × passTd  →  5pt = +1, 6pt = +2
  //   - PPC (points-per-carry): rush_att × rushAtt for any league with
  //     a per-attempt bonus on rushing
  //   - TEP (tight-end premium): bonus_rec_te × rec when position === 'TE'
  //
  // Sleeper scoring_settings field names used:
  //   rec, pass_td, bonus_rec_te, rush_att (PPC bonus per attempt)
  //
  // Returns { fantasyPts, breakdown } — breakdown is useful for tooltips
  // / debugging. Always returns a finite number (defaults to 0 on null
  // inputs so callers can chain freely).
  // ──────────────────────────────────────────────────────────────────
  function adjustStatsForLeague(rawStats, scoring) {
    const s = rawStats || {};
    const sc = scoring || {};
    const num = v => (typeof v === 'number' && !isNaN(v)) ? v : 0;

    // Volume — all default to 0 so missing fields don't blow up.
    const passYards = num(s.passYards);
    const passTd    = num(s.passTd);
    const passInts  = num(s.passInts);
    const rushAtt   = num(s.rushAtt);
    const rushYards = num(s.rushYards);
    const rushTd    = num(s.rushTd);
    const rec       = num(s.rec);
    const recYards  = num(s.recYards);
    const recTd     = num(s.recTd);
    const fumbles   = num(s.fumbles);
    const pos       = (s.pos || s.position || '').toUpperCase();

    // Base: full PPR, 4-pt pass TD
    const base =
        0.04 * passYards
      + 4    * passTd
      - 2    * passInts
      + 0.1  * rushYards
      + 6    * rushTd
      + 0.1  * recYards
      + 1    * rec
      + 6    * recTd
      - 2    * fumbles;

    // Reception scoring adjustment off the full-PPR base.
    // Sleeper rec field: 1.0=PPR, 0.5=half, 0=standard. Default to 1.0
    // (PPR) when the scoring_settings is missing entirely.
    let recBonus = 0;
    const recPpr = (sc.rec != null) ? Number(sc.rec) : 1;
    if (recPpr !== 1) {
      recBonus = (recPpr - 1) * rec;     // half → -0.5*rec ; std → -1*rec
    }

    // Pass-TD bonus. Sleeper pass_td default is 4. If scoring is set
    // (typically to 5 or 6), add the delta × passTd.
    let passTdBonus = 0;
    if (sc.pass_td != null) {
      passTdBonus = (Number(sc.pass_td) - 4) * passTd;
    }

    // PPC — Sleeper field is rush_att (points per rushing attempt).
    // Common values: 0.1, 0.25, 0.5. Default 0.
    let ppc = 0;
    if (sc.rush_att != null) {
      ppc = Number(sc.rush_att) * rushAtt;
    }

    // TEP — only applies when player is a TE.
    let tep = 0;
    if (pos === 'TE' && sc.bonus_rec_te != null) {
      tep = Number(sc.bonus_rec_te) * rec;
    }

    const fantasyPts = base + recBonus + passTdBonus + ppc + tep;
    return {
      fantasyPts,
      breakdown: { base, recBonus, passTdBonus, ppc, tep },
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Per-player season-projected points for a specific league. Pulls the
  // raw stat line from window.STATS_DATA and runs it through the
  // scoring overlay. Returns null when no stats record exists so
  // callers can fall back to Sleeper /projections.
  //
  // playerKey accepts any of:
  //   - { sleeperId: '1234' }
  //   - { name: 'CeeDee Lamb' }
  //   - { sleeperId: '1234', name: 'CeeDee Lamb' } (tries sid first)
  // opts: { position } (overrides position from STATS_DATA — useful for
  //   cases where the data-suite pos field is stale or missing).
  // ──────────────────────────────────────────────────────────────────
  function projectPlayer(playerKey, scoring, opts) {
    const STATS = window.STATS_DATA;
    if (!STATS) return null;
    const k = playerKey || {};
    let rec = null;
    if (k.sleeperId) rec = STATS['sid:' + k.sleeperId] || null;
    if (!rec && k.name) {
      const norm = (typeof window.normalizePlayerName === 'function')
        ? window.normalizePlayerName
        : (s => String(s || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' '));
      rec = STATS['name:' + norm(k.name)] || null;
    }
    if (!rec) return null;
    if (opts && opts.position) {
      rec = Object.assign({}, rec, { pos: opts.position });
    }
    return adjustStatsForLeague(rec, scoring).fantasyPts;
  }

  // ──────────────────────────────────────────────────────────────────
  // OPTIMAL LINEUP — given a roster's players + a per-player projection
  // dict + the league's roster_positions array, return the Set of player
  // IDs that SHOULD be starting. Slot fill order: locked positions →
  // narrower flexes → SUPER_FLEX, so locked spots claim their best fits
  // before flex absorbs leftovers.
  //
  // Extracted from my-leagues.html's _mlComputeOptimalLineup so the
  // live-draft + my-leagues archetype computations share one canonical
  // lineup algorithm. The signature is preserved.
  // ──────────────────────────────────────────────────────────────────
  function optimalLineup(playerIds, players, projections, rosterPositions) {
    if (!playerIds || !playerIds.length || !rosterPositions || !rosterPositions.length) {
      return new Set();
    }
    const benchSlots = new Set(['BN', 'TAXI', 'IR', 'RES']);
    const playableSlots = rosterPositions.filter(s => !benchSlots.has(s));
    if (!playableSlots.length) return new Set();

    // Rank signal: projections (in-season) or trade value (pre-season fallback)
    const hasProjData = projections && Object.values(projections).some(v => v > 0);
    const FP = window.FP_VALUES || {};
    const valKey = (Array.isArray(rosterPositions) && rosterPositions.indexOf('SUPER_FLEX') >= 0)
      ? 'valueSf' : 'value1qb';
    const signal = (id, name) => {
      if (hasProjData) {
        return (projections && projections[id]) ? +projections[id] : 0;
      }
      const ktc = FP[name] || {};
      return +((ktc[valKey] != null ? ktc[valKey] : ktc.value) || 0);
    };

    const candidates = playerIds
      .map(id => {
        const p = players[id];
        if (!p) return null;
        const fullName = p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
        return { id, pos: p.position || '', score: signal(id, fullName) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const slotPrecedence = ['QB','RB','WR','TE','K','DEF','DL','LB','DB',
                            'WRRB_FLEX','WRRB','REC_FLEX','WRTE_FLEX','FLEX',
                            'IDP_FLEX','SUPER_FLEX'];
    const eligibility = {
      QB:          ['QB'],
      RB:          ['RB'],
      WR:          ['WR'],
      TE:          ['TE'],
      K:           ['K'],
      DEF:         ['DEF'],
      DL:          ['DL','DE','DT'],
      LB:          ['LB'],
      DB:          ['DB','CB','S','SS','FS'],
      FLEX:        ['RB','WR','TE'],
      WRRB_FLEX:   ['RB','WR'],
      WRRB:        ['RB','WR'],
      REC_FLEX:    ['WR','TE'],
      WRTE_FLEX:   ['WR','TE'],
      SUPER_FLEX:  ['QB','RB','WR','TE'],
      IDP_FLEX:    ['DL','LB','DB','DE','DT','CB','S','SS','FS'],
    };

    const ordered = playableSlots
      .map((slot, origIdx) => ({ slot, origIdx, prec: slotPrecedence.indexOf(slot) }))
      .sort((a, b) => {
        if (a.prec === -1 && b.prec === -1) return a.origIdx - b.origIdx;
        if (a.prec === -1) return 1;
        if (b.prec === -1) return -1;
        return a.prec - b.prec;
      });

    const claimed = new Set();
    ordered.forEach(({ slot }) => {
      const eligible = eligibility[slot] || [slot];
      const pick = candidates.find(c => !claimed.has(c.id) && eligible.includes(c.pos));
      if (pick) claimed.add(pick.id);
    });

    return claimed;
  }

  // ──────────────────────────────────────────────────────────────────
  // LINEUP PROJECTION — the load-bearing helper that turns a roster +
  // a league's scoring + a league's roster_positions into a scalar
  // "what this team is projected to score" using ONLY the optimal Start-N
  // lineup (not the entire 25-player roster).
  //
  // This is what archetypeFromTotals' projValue argument should consume
  // for a calibrated "contender/dynasty/rebuilder" composite — a 25-player
  // roster's projected sum isn't what the team scores, the lineup is.
  //
  // Falls back gracefully when STATS_DATA misses a player: that player
  // contributes 0 to the lineup projection (won't be ranked in the
  // optimal lineup since their projection is null). For leagues with
  // heavy IDP / K usage this is fine because the FP-value fallback
  // inside optimalLineup picks up the slack on the lineup-selection
  // side; only the SUM is conservative.
  // ──────────────────────────────────────────────────────────────────
  function lineupProjection(playerIds, players, scoring, rosterPositions) {
    if (!playerIds || !playerIds.length) return 0;
    const projections = {};
    playerIds.forEach(pid => {
      const p = players[pid];
      if (!p) return;
      const name = p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
      const pts = projectPlayer({ sleeperId: pid, name }, scoring, { position: p.position });
      if (pts != null && !isNaN(pts)) projections[pid] = pts;
    });
    const starters = optimalLineup(playerIds, players, projections, rosterPositions);
    let total = 0;
    starters.forEach(pid => { total += +(projections[pid] || 0); });
    return total;
  }

  window.SLEEPER = {
    pickValue,
    getValueByName,
    getOwnedPicks,
    buildAssetPool,
    generateTradeSuggestions,
    archetypeFromTotals,
    archetypeLabel,
    adjustStatsForLeague,
    projectPlayer,
    optimalLineup,
    lineupProjection,
  };
})();
