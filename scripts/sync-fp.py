"""
sync-fp.py -- pull Fantasy Points + Sleeper API data into local data/*.json.

Hybrid sourcing (chosen so the trade calculator keeps a rank source while
all per-player attributes come from Sleeper, which Sleeper actually owns and
refreshes daily):

  Fantasy Points provides ........ rank, posRank, trend, tier, pick values,
                                   articles. (Player value fields used to
                                   come from FP too but are now owned by
                                   sync-mvs.py / data/mvs.json — overlaid
                                   wholesale at runtime by data-bootstrap.js.)
  Sleeper provides ............... age, team, pos, injury, ppg (from 2025
                                   actual stats)

What it does:
  1. Reads sync-fp.config.json for the FP API base + auth.
  2. Calls 5 FP endpoints (trade-value, adp, auction, season proj, articles).
  3. Calls 2 Sleeper endpoints (no auth):
       - /v1/players/nfl
       - /v1/stats/nfl/regular/{SLEEPER_STATS_SEASON}
  4. Joins trade-value (value-by-rank) with ADP (name-by-rank), then overlays
     Sleeper attributes onto each player record.
  5. Writes 3 atomic JSON files (+ rolling rank-history state file):
       - data/values.json     (FP_VALUES — player -> {rank, posRank, age, team, pos, ppg, injury, trend, tier, sleeperId})
       - data/picks.json      (PICK_VALUES — "YYYY-R.SS" -> {value, valueSf, valueTep})
       - data/articles.json   (PLAYER_ARTICLES — player -> [articles])
     Note: data/adp.json + data/auction.json + data/pick-availability.json are
     owned by sync-adp.py. my-leagues.html fetches Sleeper projections at runtime,
     so we no longer persist a build-time projections snapshot.

Exits non-zero on any failure so push.bat can abort cleanly.
Local-only -- gitignored along with sync-fp.config.json.
"""

import csv
import json
import os
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CFG_PATH  = REPO_ROOT / "sync-fp.config.json"
DATA_DIR  = REPO_ROOT / "data"

# Optional manual-curation file. FP's dynasty ADP API drops veteran FAs
# (Deebo Samuel, Tyreek Hill, …) and below-cutoff rookies, which leaves
# their tier rows rendering blank on tiers.html. Adding a row here force-
# includes the player in values.json so the join lands. See
# apply_values_supplement() below.
VALUES_SUPPLEMENT_CSV = REPO_ROOT / "data" / "source" / "values-supplement.csv"

# Article URLs from /v2/articles/nfl/recent are returned as site-relative paths
# like "/nfl/articles/...". The player cards open them in a new tab pointing
# at the public site, so we absolutize them here at sync time.
FP_SITE_BASE = "https://www.fantasypoints.com"

# Sleeper is unauthenticated and exposes everything on api.sleeper.app/v1.
SLEEPER_BASE          = "https://api.sleeper.app/v1"
# PPG is computed from the most recently completed season's actual stats.
# Update once a season after Week 18 closes out. PRIOR_SEASON powers the
# "{year-1} PPG" column on the tier table (derived from SEASON so it auto-rolls).
SLEEPER_STATS_SEASON       = "2025"
SLEEPER_STATS_PRIOR_SEASON = str(int(SLEEPER_STATS_SEASON) - 1)

# Trend over a rolling 30-day window. Each sync drops a snapshot keyed by today's
# date into data/rank-history.json; trend is computed as the rank delta between
# now and the snapshot CLOSEST to 30 days ago. Snapshots older than 90 days are
# pruned so the file doesn't grow unbounded.
HISTORY_PATH       = DATA_DIR / "rank-history.json"
TREND_WINDOW_DAYS  = 30
MAX_HISTORY_DAYS   = 90

# Sanity thresholds -- refuse to overwrite if API returns suspiciously little
MIN_TRADE_VALUE_RECORDS = 250
MIN_ADP_RECORDS         = 500
MIN_AUCTION_RECORDS     = 300
MIN_SEASON_PROJ         = 400


def die(msg, code=1):
    sys.stderr.write(f"[sync-fp] ERROR: {msg}\n")
    sys.exit(code)


def info(msg):
    sys.stdout.write(f"[sync-fp] {msg}\n")


def load_cfg():
    if not CFG_PATH.exists():
        die(f"missing {CFG_PATH.name}. Copy sync-fp.config.example.json and fill in the api key fields.")
    try:
        cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        die(f"could not parse {CFG_PATH.name}: {e}")
    for required in ("api_base", "x_source", "auth_token"):
        if not cfg.get(required) or cfg[required].startswith("PASTE_"):
            die(f"{CFG_PATH.name} is missing or has placeholder for: {required}")
    return cfg


def fp_get(cfg, path):
    """Hit a Fantasy Points endpoint. Returns parsed JSON or raises."""
    try:
        import requests
    except ImportError:
        die("Python 'requests' library not installed. Run: python -m pip install requests")
    url = cfg["api_base"].rstrip("/") + path
    headers = {
        "X-Source": cfg["x_source"],
        "Authorization": cfg["auth_token"],
        "Accept": "application/json",
    }
    info(f"GET {url}")
    r = requests.get(url, headers=headers, timeout=60)
    if r.status_code != 200:
        die(f"{path} returned {r.status_code}: {r.text[:200]}")
    try:
        return r.json()
    except Exception as e:
        die(f"{path} response was not JSON: {e}")


def sleeper_get(path, *, optional=False):
    """Hit a Sleeper endpoint (no auth). Returns parsed JSON.
       If optional=True, returns {} on non-200 rather than dying."""
    try:
        import requests
    except ImportError:
        die("Python 'requests' library not installed. Run: python -m pip install requests")
    url = SLEEPER_BASE + path
    info(f"GET {url}")
    r = requests.get(url, timeout=60)
    if r.status_code != 200:
        if optional:
            info(f"  (optional) {path} returned {r.status_code}; skipping")
            return {}
        die(f"sleeper {path} returned {r.status_code}: {r.text[:200]}")
    try:
        return r.json() or {}
    except Exception as e:
        if optional:
            return {}
        die(f"sleeper {path} response was not JSON: {e}")


# ---------- shape helpers ----------

def fmt_pos_rank(pos, n):
    """('RB', 3) -> 'RB3'"""
    if not pos or n is None:
        return ""
    return f"{pos}{int(n)}"


def normalize_name(name):
    """Tolerant name match key: strip suffixes, punctuation, accents, whitespace."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\.?\b", "", s)
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def atomic_write_json(path, payload):
    """Write JSON to a temp file then rename, so partial writes never land."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# ---------- build per-data-source records ----------

def build_adp_lookups(adp_resp):
    """Return:
       - by_name: { normalized_name: { sf:{overall,posRank}, oneqb:{overall,posRank}, pos, team } }
       - ppr_ordered: list of player records in PPR ADP order (for trade-value join)
       - display_names: { normalized_name: original_name }
    """
    buckets = adp_resp.get("content", {})
    out_by_name = {}
    display_names = {}

    def add_bucket(bucket_name, target_field):
        b = buckets.get(bucket_name, {})
        values = b.get("values", []) or []
        for p in values:
            name = (p.get("name") or "").strip()
            if not name:
                continue
            key = normalize_name(name)
            if not key:
                continue
            display_names[key] = name
            rec = out_by_name.setdefault(key, {})
            rec[target_field] = {
                "overall": p.get("adp"),
                "posRank": fmt_pos_rank(p.get("fantasyPosition"), p.get("posRank")),
            }
            rec["pos"]  = p.get("fantasyPosition") or rec.get("pos")
            rec["team"] = p.get("team") or rec.get("team")

    # Map FP buckets to existing 'sf' / 'oneqb' axis
    add_bucket("superflex", "sf")
    add_bucket("ppr",       "oneqb")

    ppr = buckets.get("ppr", {}).get("values", []) or []
    return out_by_name, ppr, display_names


def build_values_from_trade_value(tv_resp):
    """Return:
       - rank_to_value: { rank_int: {value, valueSf, valueTep} }
       - pick_to_value: { 'YYYY-R.SS': {value, valueSf, valueTep} }
    """
    values = tv_resp.get("content", {}).get("rankings", {}).get("values", []) or []
    rank_to_value = {}
    pick_to_value = {}
    for row in values:
        rank_str = str(row.get("rank", "")).strip()
        triple = {
            "value":   row.get("tradeValue"),
            "valueSf": row.get("tradeValueSuperflex"),
            "valueTep":row.get("tradeValueTePremium"),
        }
        # Pure integer rank -> player slot
        if rank_str.isdigit():
            rank_to_value[int(rank_str)] = triple
            continue
        # Otherwise try to parse as pick: 'YYYY R.SS'
        m = re.match(r"^(\d{4})\s+(\d+)\.(\d+)$", rank_str)
        if m:
            y, r, s = m.group(1), m.group(2), m.group(3).zfill(2)
            pick_to_value[f"{y}-{r}.{s}"] = triple
    return rank_to_value, pick_to_value


def build_auction_by_name(auction_resp):
    """{ normalized_name: {ppr, halfppr, superflex, tier} }"""
    out = {}
    values = auction_resp.get("content", {}).get("rankings", {}).get("values", []) or []
    for row in values:
        name = (row.get("name") or "").strip()
        if not name:
            continue
        key = normalize_name(name)
        out[key] = {
            "ppr":       row.get("auctionValuePpr"),
            "halfppr":   row.get("auctionValueHalfPpr"),
            "superflex": row.get("auctionValueSuperflex"),
            "tier":      row.get("tier"),
        }
    return out


def build_season_proj_by_name(season_resp):
    """{ normalized_name: {ppg, ppgPpr, ppgHalfPpr, total, trend, ...} }"""
    out = {}
    values = season_resp.get("content", {}).get("projections", {}).get("values", []) or []
    for row in values:
        name = (row.get("name") or "").strip()
        if not name:
            continue
        key = normalize_name(name)
        # Trend signal from isUp / isDown / move
        trend = 0
        if row.get("isUp"):   trend = 1
        if row.get("isDown"): trend = -1
        if isinstance(row.get("move"), (int, float)):
            trend = int(row.get("move"))
        out[key] = {
            "ppg":      row.get("fantasyPointsPprPerGame") or row.get("fantasyPointsPerGame"),
            "total":    row.get("fantasyPointsPpr") or row.get("fantasyPoints"),
            "trend":    trend,
            "tier":     row.get("tier"),
        }
    return out


def _age_from_birthdate(bd):
    """Return decimal age in years from 'YYYY-MM-DD' string, or None."""
    if not bd or len(bd) < 10:
        return None
    try:
        born = date.fromisoformat(bd[:10])
    except ValueError:
        return None
    today = date.today()
    days = (today - born).days
    if days <= 0:
        return None
    return round(days / 365.25, 1)


def _ppg_from_stats_row(stats):
    """Compute PPG (PPR, 1 decimal) from a Sleeper /v1/stats row, or None."""
    if not stats:
        return None
    gp = stats.get("gp") or 0
    pts = stats.get("pts_ppr") or stats.get("pts_half_ppr") or stats.get("pts_std") or 0
    return round(pts / gp, 1) if gp and pts else None


def build_sleeper_overlay(players_resp, stats_resp, prior_stats_resp=None):
    """Produce a per-player overlay sourced from Sleeper.

    Inputs:
      players_resp     -- /v1/players/nfl response: { player_id: {full_name, team, position, birth_date, injury_status, active, status, ...} }
      stats_resp       -- /v1/stats/nfl/regular/{year} response: { player_id: {gp, pts_ppr, ...} }
      prior_stats_resp -- optional, same shape as stats_resp but for the prior season.
                          Powers FP_VALUES.ppgPrior -> tier table's "{year-1} PPG" column.

    Output:
      { normalized_name: {sleeper_id, age, team, pos, injury, ppg, ppgPrior} }

    Disambiguation: when two players share a normalized name (e.g. Sr/Jr),
    prefer the one marked Active over Inactive, then the one with stats over
    the one without.
    """
    candidates_by_key = {}
    for pid, p in (players_resp or {}).items():
        if (p.get("sport") or "nfl") != "nfl":
            continue
        # Only fantasy-skill positions for the overlay (ignores OL, defenders, etc.)
        pos = (p.get("position") or "").upper()
        if pos not in ("QB", "RB", "WR", "TE", "K", "DEF"):
            continue
        full = p.get("full_name") or " ".join(
            x for x in (p.get("first_name"), p.get("last_name")) if x
        ).strip()
        if not full:
            continue
        key = normalize_name(full)
        if not key:
            continue
        stats = (stats_resp or {}).get(pid) or {}
        prior_stats = (prior_stats_resp or {}).get(pid) or {}
        gp = stats.get("gp") or 0
        ppg = _ppg_from_stats_row(stats)
        ppg_prior = _ppg_from_stats_row(prior_stats)
        candidates_by_key.setdefault(key, []).append({
            "sleeper_id": pid,
            "age":        _age_from_birthdate(p.get("birth_date")),
            "team":       p.get("team") or None,
            "pos":        pos,
            "injury":     p.get("injury_status") or None,
            "ppg":        ppg,
            "ppgPrior":   ppg_prior,
            "_active":    (p.get("status") == "Active") and (p.get("active") is not False),
            "_has_stats": bool(gp),
        })

    out = {}
    for key, cands in candidates_by_key.items():
        if len(cands) == 1:
            best = cands[0]
        else:
            # Prefer active + has-stats; then active; then anything
            best = max(
                cands,
                key=lambda c: (1 if c["_active"] else 0) * 2 + (1 if c["_has_stats"] else 0),
            )
        out[key] = {k: v for k, v in best.items() if not k.startswith("_")}
    return out


def build_articles_map(articles_resp, known_names):
    """Scan article bodies for player name mentions.
       known_names: list of original player names from ADP.
       Returns { player_name: [ {title, url, publishedDate, author} ] }"""
    docs = articles_resp.get("content", {}).get("documents", {}).get("values", []) or []
    # Only published (publishedDate present)
    published = [a for a in docs if a.get("publishedDate")]
    # Sort known names by length descending so longer names match first
    # (avoids "Chase" matching "Ja'Marr Chase" body before "Ja'Marr Chase" itself)
    sorted_names = sorted(set(known_names), key=lambda n: (-len(n), n))
    name_re_cache = {}
    for n in sorted_names:
        # Word-boundary match, case sensitive (names are proper nouns)
        name_re_cache[n] = re.compile(r"\b" + re.escape(n) + r"\b")

    # Body-mention threshold — articles will only attach to a player when they
    # appear in the title (clearly a subject) OR are mentioned at least this
    # many times in the body. Stops single-mention "vet comp" drops in rookie
    # articles from polluting the vet's card.
    BODY_MENTION_MIN = 2

    out = {}
    for art in published:
        title = (art.get("title") or "")
        body  = (art.get("body")  or "")
        mentioned = []
        for n in sorted_names:
            in_title    = bool(name_re_cache[n].search(title))
            body_hits   = len(name_re_cache[n].findall(body))
            if in_title or body_hits >= BODY_MENTION_MIN:
                mentioned.append(n)
        if not mentioned:
            continue
        raw_url = art.get("url") or ""
        if raw_url.startswith("/"):
            full_url = FP_SITE_BASE + raw_url
        elif raw_url.startswith("http"):
            full_url = raw_url
        else:
            full_url = FP_SITE_BASE + "/" + raw_url if raw_url else ""
        # Field names match what index.html / my-leagues.html render code reads.
        # Body is intentionally NOT persisted: FP returns articles in a custom
        # markdown with internal STATIC_ASSET_URI placeholder tokens, which is
        # unreadable when rendered raw and not worth a parser. Article cards on
        # the site click through to FantasyPoints for the full read.
        record = {
            "title":  art.get("title"),
            "url":    full_url,
            "date":   art.get("publishedDate"),
            "author": art.get("author"),
        }
        for n in mentioned:
            out.setdefault(n, []).append(record)
    # Sort each player's article list newest-first
    for n in out:
        out[n].sort(key=lambda a: a.get("date") or "", reverse=True)
    return out


# ---------- assemble + write ----------

def load_history():
    """Read data/rank-history.json: { snapshots: { 'YYYY-MM-DD': {name: rank, ...}, ... } }"""
    if not HISTORY_PATH.exists():
        return {"snapshots": {}}
    try:
        h = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        if "snapshots" not in h or not isinstance(h["snapshots"], dict):
            h["snapshots"] = {}
        return h
    except Exception:
        return {"snapshots": {}}


def find_baseline_ranks(history):
    """Find the snapshot closest to TREND_WINDOW_DAYS ago (excluding today).
       Returns (ranks_dict, baseline_date_str, days_old) or ({}, None, None)."""
    today = date.today()
    target = today - timedelta(days=TREND_WINDOW_DAYS)
    snapshots = history.get("snapshots", {}) or {}
    best_date = None
    best_diff = None
    for d_str in snapshots:
        try:
            d = date.fromisoformat(d_str)
        except ValueError:
            continue
        if d >= today:           # skip today and future snapshots
            continue
        diff = abs((d - target).days)
        if best_diff is None or diff < best_diff:
            best_diff = diff
            best_date = d_str
    if best_date is None:
        return {}, None, None
    ranks = snapshots[best_date]
    days_old = (today - date.fromisoformat(best_date)).days
    return ranks, best_date, days_old


def prune_history(history):
    """Drop snapshots older than MAX_HISTORY_DAYS so the file stays bounded."""
    cutoff = date.today() - timedelta(days=MAX_HISTORY_DAYS)
    snapshots = history.get("snapshots", {}) or {}
    keep = {}
    for d_str, ranks in snapshots.items():
        try:
            d = date.fromisoformat(d_str)
        except ValueError:
            continue
        if d >= cutoff:
            keep[d_str] = ranks
    history["snapshots"] = keep
    return history


def record_snapshot(history, players_out):
    """Stamp today's date into the history with current ranks."""
    today_str = date.today().isoformat()
    history.setdefault("snapshots", {})[today_str] = {
        name: rec["rank"] for name, rec in players_out.items()
        if isinstance(rec.get("rank"), int)
    }
    return history


def assemble_player_records(adp_resp, tv_resp, auction_resp, season_resp, sleeper_overlay, history):
    """Merge all the per-player sources into the final values + adp + picks output."""
    by_name, ppr_ordered, display_names = build_adp_lookups(adp_resp)
    rank_to_value, pick_to_value = build_values_from_trade_value(tv_resp)
    auction_by_name = build_auction_by_name(auction_resp)
    season_by_name  = build_season_proj_by_name(season_resp)
    baseline_ranks, baseline_date, days_old = find_baseline_ranks(history)
    if baseline_date:
        info(f"  trend baseline: snapshot from {baseline_date} ({days_old} days ago, {len(baseline_ranks)} players)")
    else:
        info(f"  trend baseline: none yet (first sync — all trends will be 0)")

    if len(rank_to_value) < MIN_TRADE_VALUE_RECORDS:
        die(f"trade-value returned only {len(rank_to_value)} player rows (< {MIN_TRADE_VALUE_RECORDS}); refusing to overwrite")
    if sum(1 for _ in ppr_ordered) < MIN_ADP_RECORDS:
        die(f"adp/ppr returned only {len(ppr_ordered)} rows (< {MIN_ADP_RECORDS}); refusing to overwrite")
    if len(auction_by_name) < MIN_AUCTION_RECORDS:
        die(f"auction returned only {len(auction_by_name)} rows (< {MIN_AUCTION_RECORDS}); refusing to overwrite")
    if len(season_by_name) < MIN_SEASON_PROJ:
        die(f"season-projections returned only {len(season_by_name)} rows (< {MIN_SEASON_PROJ}); refusing to overwrite")

    players_out = {}
    # Walk PPR ADP order. Position i (0-based) -> trade-value rank (i+1).
    for i, p in enumerate(ppr_ordered):
        name = (p.get("name") or "").strip()
        if not name:
            continue
        key = normalize_name(name)
        auc    = auction_by_name.get(key, {})
        sea    = season_by_name.get(key, {})
        adp    = by_name.get(key, {})

        current_rank = i + 1
        # Trend = (baseline rank from ~30 days ago) - (current rank).
        # Positive = moved up (riser), negative = moved down (faller).
        # First-time setup leaves trend = 0 until 30 days of history accumulates.
        # Kept as the runtime fallback for players MVS doesn't cover (data-
        # bootstrap.js's MVS overlay writes target.trend from mvs.trend when
        # available; for the long tail this FP rank-delta is what shows).
        baseline_rank = baseline_ranks.get(name)
        trend = (baseline_rank - current_rank) if baseline_rank is not None else 0

        # Sleeper overlay: source of truth for age, team, pos, injury, ppg.
        # FP stays the source for rank/posRank/trend/tier; value fields are
        # owned by MVS (sync-mvs.py -> data/mvs.json -> wholesale-overlaid by
        # data-bootstrap.js). adp/auction come from sync-adp.py. FP's
        # trade-value endpoint is still called above because we need it to
        # produce data/picks.json's pick_to_value mapping.
        sl = sleeper_overlay.get(key, {})

        players_out[name] = {
            "rank":      current_rank,
            "posRank":   fmt_pos_rank(p.get("fantasyPosition"), p.get("posRank")),
            "pos":       sl.get("pos")  or p.get("fantasyPosition"),
            "team":      sl.get("team") or p.get("team"),
            "age":       sl.get("age"),
            "ppg":       sl.get("ppg"),
            "ppgPrior":  sl.get("ppgPrior"),
            "injury":    sl.get("injury"),
            "sleeperId": sl.get("sleeper_id"),
            "trend":     trend,
            "tier":      sea.get("tier"),
        }

    adp_out = {}
    for key, rec in by_name.items():
        original = display_names.get(key)
        if not original:
            continue
        if "sf" in rec or "oneqb" in rec:
            adp_out[original] = {
                "sf":    rec.get("sf", {"overall": None, "posRank": ""}),
                "oneqb": rec.get("oneqb", {"overall": None, "posRank": ""}),
            }

    return players_out, adp_out, pick_to_value


# ---------- values-supplement (force-include layer for FP-absent players) ----------

def apply_values_supplement(players, sleeper_overlay):
    """Merge data/source/values-supplement.csv entries into players dict for
    any name not already returned by FP's dynasty ADP API.

    Background: FP's /v2/adp/dynasty/nfl appears to filter veteran free
    agents (Deebo Samuel, Tyreek Hill) and below-cutoff rookies (Eli Stowers),
    so without this layer their tier rows render with no rank/team/pos/
    headshot. The supplement is a manual-curation file the user maintains;
    sync-fp.py merges it in after the FP fetch + Sleeper overlay so the
    supplemented players get the same shape as FP-sourced ones.

    Supplement CSV columns (header-driven; all optional except `name`):
      name      REQUIRED — display name (matched to existing players via
                normalize_name; Jr/Sr/II/III suffixes are stripped)
      sleeperId optional — Sleeper player ID; if present + matchable in the
                Sleeper overlay, age/team/pos/ppg/injury auto-fill from there
      rank      optional — overall dynasty rank (default 999, well past FP's
                ~932-player tail so it doesn't collide)
      posRank   optional — like "WR50"
      pos       optional — QB/RB/WR/TE (Sleeper overlay wins when both present)
      team      optional — team code or FA  (Sleeper overlay wins)
      age       optional — float (Sleeper overlay wins when supplement blank)
      ppg       optional — float (same)
      ppgPrior  optional — float (same)
      tier      optional — FP projection tier number
      trend     optional — int (default 0)

    Players already in FP's response are SKIPPED with a log line, so the
    user can drop the supplement row once FP starts including them again.

    Returns (added_count, skipped_count) for the caller's log line.
    """
    if not VALUES_SUPPLEMENT_CSV.exists():
        return 0, 0

    def _opt_float(v):
        try:    return float(v) if v not in (None, "", "null") else None
        except (TypeError, ValueError): return None
    def _opt_int(v, default=None):
        try:    return int(v) if v not in (None, "", "null") else default
        except (TypeError, ValueError): return default

    fp_keys = {normalize_name(n) for n in players.keys()}
    added = 0
    skipped = 0

    with VALUES_SUPPLEMENT_CSV.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("name") or "").strip()
            if not name:
                continue
            key = normalize_name(name)
            if not key:
                continue
            if key in fp_keys:
                info(f"  values-supplement: skipping {name!r} — FP returned this player; remove the row from values-supplement.csv to silence")
                skipped += 1
                continue

            sl = sleeper_overlay.get(key, {}) or {}
            sleeper_id = (row.get("sleeperId") or "").strip() or sl.get("sleeper_id")

            players[name] = {
                "rank":      _opt_int(row.get("rank"), 999),
                "posRank":   (row.get("posRank") or "").strip(),
                "pos":       sl.get("pos")  or (row.get("pos") or "").strip().upper() or None,
                "team":      sl.get("team") or (row.get("team") or "").strip().upper() or None,
                "age":       sl.get("age")      if sl.get("age")      is not None else _opt_float(row.get("age")),
                "ppg":       sl.get("ppg")      if sl.get("ppg")      is not None else _opt_float(row.get("ppg")),
                "ppgPrior":  sl.get("ppgPrior") if sl.get("ppgPrior") is not None else _opt_float(row.get("ppgPrior")),
                "injury":    sl.get("injury"),
                "sleeperId": sleeper_id,
                "trend":     _opt_int(row.get("trend"), 0),
                "tier":      _opt_int(row.get("tier")),
            }
            added += 1
    return added, skipped


def main():
    cfg = load_cfg()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # ── FP endpoints (value-shaped data Sleeper doesn't publish) ────────────
    tv_resp       = fp_get(cfg, "/v2/rankings/trade-value/nfl/dynasty")
    adp_resp      = fp_get(cfg, "/v2/adp/dynasty/nfl")
    auction_resp  = fp_get(cfg, "/v2/rankings/auction/nfl")
    season_resp   = fp_get(cfg, "/v2/projections/season/nfl")
    articles_resp = fp_get(cfg, "/v2/articles/nfl/recent")

    # ── Sleeper endpoints (per-player attributes) ───────────────────────────
    sleeper_players     = sleeper_get("/players/nfl")
    sleeper_stats       = sleeper_get(f"/stats/nfl/regular/{SLEEPER_STATS_SEASON}")
    # Prior-season stats power FP_VALUES.ppgPrior → tier table's prior-season
    # PPG column. Optional: if Sleeper returns nothing the overlay just skips.
    sleeper_stats_prior = sleeper_get(f"/stats/nfl/regular/{SLEEPER_STATS_PRIOR_SEASON}", optional=True)

    overlay = build_sleeper_overlay(sleeper_players, sleeper_stats, sleeper_stats_prior)
    info(f"  built sleeper overlay for {len(overlay)} players (stats seasons {SLEEPER_STATS_SEASON} + prior {SLEEPER_STATS_PRIOR_SEASON})")

    # Load rolling rank history for 30-day trend computation
    history = load_history()

    # Assemble player + ADP + pick maps (overlay applied per-player)
    players, adp_map, picks = assemble_player_records(adp_resp, tv_resp, auction_resp, season_resp, overlay, history)
    matched_ppg = sum(1 for v in players.values() if v.get("ppg") is not None)
    matched_age = sum(1 for v in players.values() if v.get("age") is not None)
    info(f"  built {len(players)} player records, {len(adp_map)} adp records, {len(picks)} picks")
    info(f"  matched sleeper overlay: ppg={matched_ppg} age={matched_age} of {len(players)}")

    # Force-include manual entries for players FP omits (veteran FAs / below-
    # cutoff rookies). See apply_values_supplement() docstring + the
    # data/source/values-supplement.csv file.
    sup_added, sup_skipped = apply_values_supplement(players, overlay)
    if sup_added or sup_skipped:
        info(f"  values-supplement: added {sup_added} player{'s' if sup_added != 1 else ''}, skipped {sup_skipped} already in FP response")

    # Articles: scan bodies for player-name mentions.
    # Exclude team defenses — "Washington Commanders" / "Pittsburgh Steelers" /
    # etc. would otherwise grab every article that mentions the team.
    real_player_names = [n for n, rec in players.items() if (rec or {}).get("pos") != "DEF"]
    articles_map = build_articles_map(articles_resp, real_player_names)
    info(f"  built articles map for {len(articles_map)} players ({len(players) - len(real_player_names)} DEF entries excluded)")

    now = datetime.now(timezone.utc).isoformat()

    atomic_write_json(DATA_DIR / "values.json",      {"version": now, "players": players})
    atomic_write_json(DATA_DIR / "picks.json",       {"version": now, "picks": picks})
    # data/adp.json + data/auction.json + data/pick-availability.json are owned
    # by sync-adp.py (dynasty pipeline). sync-fp.py runs AFTER sync-adp.py in
    # push.bat, so writing them here would clobber the dynasty pipeline output.
    # The FP /v2/adp/ call is still made above for rank -> player-name resolution;
    # its values are simply not persisted.
    atomic_write_json(DATA_DIR / "articles.json",    {"version": now, "players": articles_map})

    # Record today's snapshot, prune old entries, persist history
    history = record_snapshot(history, players)
    history = prune_history(history)
    history["lastUpdated"] = now
    atomic_write_json(HISTORY_PATH, history)
    info(f"  rank-history.json: {len(history['snapshots'])} snapshot(s) retained")

    info("OK -- wrote 3 files to data/ + rank-history.json (adp/auction/pick-availability owned by sync-adp.py)")


if __name__ == "__main__":
    main()
