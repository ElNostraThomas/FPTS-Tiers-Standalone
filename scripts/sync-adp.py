"""
sync-adp.py -- read sleeper_dynasty_adp parquet snapshots and emit JSON files
for the FPTS site to consume.

Inputs (paths come from sync-adp.config.json):
  - {snapshot_dir}/adp_time_series/adp_time_series_ALL.parquet
  - {snapshot_dir}/auction_price_series/auction_price_series_ALL.parquet
  - {snapshot_dir}/draft_catalog/draft_catalog_ALL.parquet
  - {picks_dir}/picks_{season}.parquet
  - Sleeper /v1/players/nfl (for resolving player_id -> full_name)

Outputs (atomic) to data/:
  - data/adp.json              per-player ADP keyed by month + view_key (startup_sf, startup_1qb, rookie)
  - data/auction.json          per-player auction price range (avg, med, min, max) by view_key
  - data/pick-availability.json per-player [round][slot] -> probability heatmap, top-N players

Exits non-zero on failure so push.bat aborts cleanly.
Local-only -- gitignored along with sync-adp.config.json.
"""

import json
import os
import sys
import unicodedata
import re
from datetime import date, datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CFG_PATH  = REPO_ROOT / "sync-adp.config.json"
DATA_DIR  = REPO_ROOT / "data"


def die(msg, code=1):
    sys.stderr.write(f"[sync-adp] ERROR: {msg}\n")
    sys.exit(code)


def info(msg):
    print(f"[sync-adp] {msg}")


# ── Offense-only contract ─────────────────────────────────────────────────
# Every record written to data/adp-*.json / auction-*.json / pick-availability-
# *.json must carry one of these positions. Anything else (IDP variants,
# punters, defensive special teams, fullbacks) is dropped at write time so
# every year's JSON matches the 2026 board's offense-only contract — no
# year-specific frontend filtering required. K stays in the corpus because
# the picks bucket uses Sleeper-K player_ids as pick-as-asset placeholders
# (Mason Crosby = "the 5.01 pick" in picks-as-K leagues).
_OFFENSIVE_POSITIONS = {"QB", "RB", "WR", "TE", "K"}


def _is_offensive(rec):
    pos = (rec.get("position") or "").upper()
    return pos in _OFFENSIVE_POSITIONS


def _filter_offense_inplace(by_month_dict):
    """Walk a {month: {view_key: [records]}} dict and drop non-offensive
    records from every list. Mutates in-place. No-op if dict is None/empty."""
    if not by_month_dict:
        return
    for month, sub in by_month_dict.items():
        if not isinstance(sub, dict):
            continue
        for vk in list(sub.keys()):
            recs = sub.get(vk) or []
            sub[vk] = [r for r in recs if _is_offensive(r)]


def normalize_name(name):
    """Same normalization as sync-fp.py so the two pipelines join cleanly."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\.?\b", "", s)
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def atomic_write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_cfg():
    if not CFG_PATH.exists():
        die(f"missing {CFG_PATH.name}. Copy sync-adp.config.example.json and edit the paths.")
    try:
        cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        die(f"could not parse {CFG_PATH.name}: {e}")
    snap = Path(cfg.get("snapshot_dir", ""))
    if not snap.exists():
        die(f"snapshot_dir does not exist: {snap}")
    picks = Path(cfg.get("picks_dir", ""))
    if not picks.exists():
        die(f"picks_dir does not exist: {picks}")
    return cfg, snap, picks


def _age_from_birthdate(bd):
    if not bd or len(bd) < 10:
        return None
    try:
        born = date.fromisoformat(bd[:10])
    except ValueError:
        return None
    today = date.today()
    days = (today - born).days
    return round(days / 365.25, 1) if days > 0 else None


def fetch_sleeper_players():
    """Sleeper /v1/players/nfl - no auth needed. Used to resolve player_id -> full_name."""
    try:
        import requests
    except ImportError:
        die("requests not installed. Run: python -m pip install requests")
    info("GET https://api.sleeper.app/v1/players/nfl")
    r = requests.get("https://api.sleeper.app/v1/players/nfl", timeout=60)
    if r.status_code != 200:
        die(f"sleeper players returned {r.status_code}")
    return r.json()


def _safe_int(v):
    """Best-effort int parse. Returns None on empty / non-numeric values."""
    if v is None:
        return None
    try:
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except (ValueError, TypeError):
        return None


def build_player_lookup(sleeper_players):
    """player_id -> {name, position, team, age, yearsExp, status, draftYear,
    draftRound, draftPick, normKey}. Draft fields come from Sleeper's metadata
    dict; None for UDFAs / unknown."""
    out = {}
    for pid, p in (sleeper_players or {}).items():
        full = p.get("full_name") or " ".join(
            x for x in (p.get("first_name"), p.get("last_name")) if x
        ).strip()
        if not full:
            continue
        md = p.get("metadata") or {}
        out[str(pid)] = {
            "name":       full,
            "position":   (p.get("position") or "").upper(),
            "team":       p.get("team") or "",
            "age":        _age_from_birthdate(p.get("birth_date")),
            "yearsExp":   int(p.get("years_exp") or 0),
            "status":     p.get("status") or "",
            "injury":     p.get("injury_status") or None,
            "draftYear":  _safe_int(md.get("draft_year")),
            "draftRound": _safe_int(md.get("draft_round")),
            "draftPick":  _safe_int(md.get("draft_pick")),
            "normKey":    normalize_name(full),
        }
    return out


# ---------- ADP records ----------

def build_adp(adp_ts, plookup, team_count, min_drafts, season=None, current_season=None):
    """Aggregate ADP across formats within each (start_month, view_key, player_id).
    Pick-weighted ADP so a player drafted in 100 leagues outweighs one with 1."""
    import pandas as pd
    df = adp_ts.copy()
    df = df[df["st_teams"] == team_count]
    if df.empty:
        return {}

    # view_key splits: rookie / startup_sf / startup_1qb
    def view_key(row):
        if row["dynasty_class"] == "rookie":
            return "rookie"
        return "startup_sf" if bool(row["is_superflex"]) else "startup_1qb"

    df["view_key"] = df.apply(view_key, axis=1)
    df["weighted_adp"] = df["adp"] * df["picks"]

    # Second pass: emit rookie_draft_sf / rookie_draft_1qb by duplicating rookie
    # rows with a SF/1QB-split key. The legacy 'rookie' key is preserved for
    # backward compat (used by my-leagues / DB / etc.); the new keys feed the
    # Dynasty Rookie ADP tab in adp-tool.html.
    #
    # FILTER TO INCOMING ROOKIES ONLY: dynasty_class='rookie' identifies the
    # DRAFT type (rookie drafts), not the players within. Some users pick
    # veterans in rookie drafts (e.g. Josh Allen, Tannehill, Watson appearing
    # in 5-20 SF rookie drafts each), which pollutes the rookie board with
    # non-rookies. We filter to players whose Sleeper yearsExp == 0 so the
    # board reflects only the actual 2026 incoming class. The legacy 'rookie'
    # key keeps every player for downstream backward compat.
    import pandas as _pd
    # Incoming-rookie filter — season-aware. In season N, a player who was
    # then a rookie now has years_exp == (current_season - N). For 2026
    # current with season=2024 the target is 2; for season=2026 it's 0.
    # plookup carries CURRENT Sleeper years_exp, so we offset by the gap.
    _ROOKIE_POSITIONS = {"QB", "RB", "WR", "TE", "K"}
    _target_yexp = max(0, (current_season or 0) - (season or 0)) if (current_season and season) else 0
    incoming_rookie_pids = {
        pid for pid, p in plookup.items()
        if p.get("yearsExp") == _target_yexp
        and (p.get("position") or "").upper() in _ROOKIE_POSITIONS
    }
    _rookie_dup = df[
        (df["dynasty_class"] == "rookie")
        & df["player_id"].astype(str).isin(incoming_rookie_pids)
    ].copy()
    if not _rookie_dup.empty:
        _rookie_dup["view_key"] = _rookie_dup["is_superflex"].apply(
            lambda x: "rookie_draft_sf" if bool(x) else "rookie_draft_1qb"
        )
        df = _pd.concat([df, _rookie_dup], ignore_index=True)

    grouped = df.groupby(["start_month", "view_key", "player_id"]).agg(
        sum_adp=("weighted_adp", "sum"),
        sum_picks=("picks", "sum"),
        drafts=("drafts", "sum"),
        min_pick=("min_pick", "min"),
        max_pick=("max_pick", "max"),
    ).reset_index()

    grouped["adp"] = grouped["sum_adp"] / grouped["sum_picks"]
    grouped = grouped[grouped["drafts"] >= min_drafts]
    grouped = grouped.sort_values(["start_month", "view_key", "adp"])
    grouped["rank"] = grouped.groupby(["start_month", "view_key"]).cumcount() + 1

    # Also compute "ALL" rollup per view_key across the whole season
    all_df = df.groupby(["view_key", "player_id"]).agg(
        sum_adp=("weighted_adp", "sum"),
        sum_picks=("picks", "sum"),
        drafts=("drafts", "sum"),
        min_pick=("min_pick", "min"),
        max_pick=("max_pick", "max"),
    ).reset_index()
    all_df["adp"] = all_df["sum_adp"] / all_df["sum_picks"]
    all_df = all_df[all_df["drafts"] >= min_drafts]
    all_df = all_df.sort_values(["view_key", "adp"])
    all_df["rank"] = all_df.groupby(["view_key"]).cumcount() + 1
    all_df["start_month"] = "ALL"

    combined = __import__("pandas").concat([grouped, all_df], ignore_index=True)

    # PosRank per (month, view_key, position)
    out = {}
    skipped_no_name = 0
    for (month, vk), g in combined.groupby(["start_month", "view_key"]):
        records = []
        pos_counters = {}
        for _, row in g.iterrows():
            pid = str(row["player_id"])
            p   = plookup.get(pid)
            if not p:
                skipped_no_name += 1
                continue
            pos = p["position"]
            pos_counters[pos] = pos_counters.get(pos, 0) + 1
            pos_rank = pos_counters[pos]
            records.append({
                "sleeperId": pid,
                "name":      p["name"],
                "position":  pos,
                "team":      p["team"],
                "age":       p["age"],
                "yearsExp":  p["yearsExp"],
                "status":    p["status"],
                "injury":    p["injury"],
                "draftYear":  p.get("draftYear"),
                "draftRound": p.get("draftRound"),
                "draftPick":  p.get("draftPick"),
                "adp":       round(float(row["adp"]), 1),
                "rank":      int(row["rank"]),
                "posRank":   f"{pos}{pos_rank}" if pos else "",
                "drafts":    int(row["drafts"]),
                "picks":     int(row["sum_picks"]),
                "minPick":   int(row["min_pick"]),
                "maxPick":   int(row["max_pick"]),
            })
        out.setdefault(month, {})[vk] = records

    if skipped_no_name:
        info(f"  WARN: {skipped_no_name} ADP rows had unknown player_id (no Sleeper name match)")
    return out


# ---------- Format-bucket ADP (picks / simple / rookies splits) ----------

RDP_EARLY_ROUNDS = 4  # K in rounds 1..N is the picks-as-K fingerprint (matches
                       # app_adp_board.py build_rookie_pick_placeholders early_rounds=4)


def classify_startup_drafts(catalog_df, picks_df, sleeper_players, season=None, current_season=None):
    """For each completed startup draft, determine which UI bucket it belongs to.

    Classification rules (in priority order):
      1) K in rounds 1..RDP_EARLY_ROUNDS         → 'picks'    (picks-as-K
         placeholders are conventionally drafted alongside or before mid-round
         vets; a real K in round 18 is NOT this convention.)
      2) Any incoming-class rookie (years_exp==0) → 'rookies'
      3) Neither                                  → 'simple'  (vets-only)

    Returns a DataFrame: draft_id, bucket, is_superflex, st_teams, start_month.
    """
    import pandas as pd
    import numpy as np

    # Build a slim player_id → (position, years_exp) frame from Sleeper data
    rows = []
    for pid, p in (sleeper_players or {}).items():
        rows.append({
            "player_id": str(pid),
            "position":  (p.get("position") or "").upper(),
            "years_exp": p.get("years_exp"),
        })
    pi = pd.DataFrame(rows)
    pi["player_id"] = pi["player_id"].astype(str)

    p = picks_df.copy()
    p["player_id"] = p["player_id"].astype(str)
    p = p.merge(pi, on="player_id", how="left")
    p["is_k"]      = p["position"].eq("K")
    # Season-aware rookie detection — a player who was a rookie in season N
    # currently has years_exp == (current_season - N).
    _target_yexp = max(0, (current_season or 0) - (season or 0)) if (current_season and season) else 0
    p["is_rookie"] = p["years_exp"].fillna(-1).eq(_target_yexp)

    # Restrict to completed startup drafts only — also gives us st_teams for
    # computing the round each pick happened in.
    startups = catalog_df[
        (catalog_df["dynasty_class"] == "startup")
        & (catalog_df["draft_status"] == "complete")
    ][["draft_id", "is_superflex", "st_teams", "start_month"]].copy()
    startups["draft_id"] = startups["draft_id"].astype(str)
    startups["st_teams"] = pd.to_numeric(startups["st_teams"], errors="coerce")

    p = p.merge(startups[["draft_id", "st_teams"]], on="draft_id", how="inner")
    p["pick_no"] = pd.to_numeric(p["pick_no"], errors="coerce")
    p["st_teams"] = pd.to_numeric(p["st_teams"], errors="coerce")
    p["round_calc"] = np.floor((p["pick_no"] - 1) / p["st_teams"]) + 1
    p["is_early_k"] = p["is_k"] & p["round_calc"].le(RDP_EARLY_ROUNDS)

    flags = p.groupby("draft_id").agg(
        has_early_k=("is_early_k", "any"),
        has_rookie=("is_rookie", "any"),
    ).reset_index()
    flags = flags.merge(startups, on="draft_id", how="inner")

    def _bucket(row):
        if row["has_early_k"]: return "picks"
        if row["has_rookie"]:  return "rookies"
        return "simple"
    flags["bucket"] = flags.apply(_bucket, axis=1)
    return flags


def relabel_picks_K_to_rdp(picks_with_bucket_df, sleeper_players, early_rounds=RDP_EARLY_ROUNDS):
    """Rewrite K-position rows in picks-bucket drafts to ROOKIE_PICK_X.YY ids.

    Mirrors `build_rookie_pick_placeholders` in app_adp_board.py — confirmed by
    reading lines 745-815 and the concat at line 1543. Different mechanics
    though: the factory builds a separate `rp_picks` DataFrame and concats it
    with the original picks (so K rows appear twice and the position filter
    drops the original K copies later). sync-adp.py has no equivalent position
    filter, so we instead rewrite player_id IN PLACE — net effect on the
    aggregated output is identical.

    Requires picks_with_bucket_df to have columns: draft_id, player_id, pick_no,
    bucket, st_teams. Returns (modified_df, rdp_meta) where rdp_meta is
    {rdp_id: display_name} so the record builder can resolve names without a
    plookup entry.

    Sequencing convention (factory line 786-796): K picks within a draft are
    sorted by pick_no, cumcount'd 0..N-1, then mapped to rp_round = seq // st_teams + 1
    and rp_pir = seq % st_teams + 1. So 1st K -> 1.01, 12th K -> 1.12,
    13th K -> 2.01 (in a 12-team draft), and so on.
    """
    import pandas as pd
    import numpy as np

    is_picks = picks_with_bucket_df["bucket"] == "picks"
    if not is_picks.any():
        return picks_with_bucket_df, {}

    picks_subset = picks_with_bucket_df[is_picks].copy()
    other        = picks_with_bucket_df[~is_picks]

    # Merge in position from Sleeper
    pi = pd.DataFrame([
        {"player_id": str(pid), "_pos": (p.get("position") or "").upper()}
        for pid, p in (sleeper_players or {}).items()
    ])
    pi["player_id"] = pi["player_id"].astype(str)
    picks_subset["player_id"] = picks_subset["player_id"].astype(str)
    picks_subset = picks_subset.merge(pi, on="player_id", how="left")

    # Coerce numerics and compute round
    picks_subset["pick_no"]  = pd.to_numeric(picks_subset["pick_no"], errors="coerce")
    picks_subset["st_teams"] = pd.to_numeric(picks_subset["st_teams"], errors="coerce")
    valid = picks_subset["pick_no"].notna() & picks_subset["st_teams"].gt(0)
    picks_subset["_round_calc"] = np.nan
    picks_subset.loc[valid, "_round_calc"] = (
        np.floor((picks_subset.loc[valid, "pick_no"] - 1) / picks_subset.loc[valid, "st_teams"]) + 1
    )

    is_k       = picks_subset["_pos"] == "K"
    is_early_k = is_k & picks_subset["_round_calc"].le(early_rounds)
    qualifying = set(picks_subset.loc[is_early_k, "draft_id"].unique())

    rdp_meta = {}
    if qualifying:
        # All K picks from qualifying drafts (not just early ones — mirror
        # app_adp_board.py line 782).
        pk_mask = is_k & picks_subset["draft_id"].isin(qualifying) & valid
        if pk_mask.any():
            pk = picks_subset.loc[pk_mask].sort_values(["draft_id", "pick_no"]).copy()
            pk["_k_seq"]   = pk.groupby("draft_id").cumcount()
            st             = pk["st_teams"].astype(int)
            pk["_rp_round"] = (pk["_k_seq"] // st) + 1
            pk["_rp_pir"]   = (pk["_k_seq"] %  st) + 1
            pk["_rp_label"] = pk["_rp_round"].astype(int).astype(str) + "." + pk["_rp_pir"].astype(int).map(lambda x: f"{x:02d}")
            pk["_rdp_id"]   = "ROOKIE_PICK_" + pk["_rp_label"]

            # Rewrite player_id in picks_subset at those (index-aligned) rows
            picks_subset.loc[pk.index, "player_id"] = pk["_rdp_id"]

            # Build {rdp_id -> display_name}
            for _, row in pk.drop_duplicates("_rdp_id").iterrows():
                rdp_meta[row["_rdp_id"]] = f"Rookie Pick {row['_rp_label']}"

    # Drop helper columns and recombine
    picks_subset = picks_subset.drop(columns=["_pos", "_round_calc"], errors="ignore")
    if other.empty:
        return picks_subset, rdp_meta
    return pd.concat([picks_subset, other], ignore_index=True), rdp_meta


def build_format_adp(picks_df, catalog_df, sleeper_players, plookup, team_count, min_drafts, season=None, current_season=None):
    """Aggregate ADP per (start_month × format_bucket × is_superflex × player_id).

    Emits per-bucket keys that adp-tool.html consumes:
        picks_sf / picks_1qb / simple_sf / simple_1qb / rookies_sf / rookies_1qb

    Uses raw picks (Sleeper pick_no = average across drafts) instead of the
    pre-aggregated adp_time_series, because the time series doesn't carry the
    per-draft format-bucket distinction needed here.
    """
    import pandas as pd

    cls = classify_startup_drafts(catalog_df, picks_df, sleeper_players, season=season, current_season=current_season)
    if cls.empty:
        return {}

    # Filter by configured team count + canonical lineup sizes
    cls = cls[cls["st_teams"] == team_count]
    if cls.empty:
        return {}

    # Join picks with per-draft bucket + is_superflex + month + st_teams.
    # st_teams is needed by relabel_picks_K_to_rdp to compute the
    # within-draft round for each pick.
    p = picks_df.copy()
    p["player_id"] = p["player_id"].astype(str)
    p = p.merge(cls[["draft_id", "bucket", "is_superflex", "start_month", "st_teams"]], on="draft_id", how="inner")

    # Picks bucket only: rewrite K player_ids to ROOKIE_PICK_X.YY for drafts
    # that fit the picks-as-K fingerprint. After this, aggregation produces a
    # unified pool of real-player records + RDP placeholder records.
    p, rdp_meta = relabel_picks_K_to_rdp(p, sleeper_players)

    p["view_key"] = p["bucket"] + p["is_superflex"].map({True: "_sf", False: "_1qb"})

    def _agg(g):
        return pd.Series({
            "adp":      g["pick_no"].mean(),
            "drafts":   g["draft_id"].nunique(),
            "picks":    g["pick_no"].count(),
            "min_pick": g["pick_no"].min(),
            "max_pick": g["pick_no"].max(),
        })

    # Per-month + ALL rollup
    by_month = p.groupby(["start_month", "view_key", "player_id"]).apply(_agg).reset_index()
    by_all   = p.groupby(["view_key", "player_id"]).apply(_agg).reset_index()
    by_all["start_month"] = "ALL"

    combined = pd.concat([by_month, by_all], ignore_index=True)
    combined = combined[combined["drafts"] >= min_drafts]
    combined = combined.sort_values(["start_month", "view_key", "adp"])
    combined["rank"] = combined.groupby(["start_month", "view_key"]).cumcount() + 1

    # Materialize JSON-friendly records, joining player metadata from plookup
    # (or from rdp_meta for the synthetic ROOKIE_PICK_X.YY ids).
    out = {}
    skipped_no_name = 0
    for (month, vk), g in combined.groupby(["start_month", "view_key"]):
        records = []
        pos_counters = {}
        for _, row in g.iterrows():
            pid = str(row["player_id"])
            if pid in rdp_meta:
                pos = "RDP"
                pos_counters[pos] = pos_counters.get(pos, 0) + 1
                records.append({
                    "sleeperId":  pid,
                    "name":       rdp_meta[pid],
                    "position":   "RDP",
                    "team":       "",
                    "age":        None,
                    "yearsExp":   None,
                    "status":     "",
                    "injury":     None,
                    "draftYear":  None,
                    "draftRound": None,
                    "draftPick":  None,
                    "adp":        round(float(row["adp"]), 1),
                    "rank":       int(row["rank"]),
                    "posRank":    f"RDP{pos_counters[pos]}",
                    "drafts":     int(row["drafts"]),
                    "picks":      int(row["picks"]),
                    "minPick":    int(row["min_pick"]),
                    "maxPick":    int(row["max_pick"]),
                })
                continue
            p_meta = plookup.get(pid)
            if not p_meta:
                skipped_no_name += 1
                continue
            pos = p_meta["position"]
            pos_counters[pos] = pos_counters.get(pos, 0) + 1
            records.append({
                "sleeperId":  pid,
                "name":       p_meta["name"],
                "position":   pos,
                "team":       p_meta["team"],
                "age":        p_meta["age"],
                "yearsExp":   p_meta["yearsExp"],
                "status":     p_meta["status"],
                "injury":     p_meta["injury"],
                "draftYear":  p_meta.get("draftYear"),
                "draftRound": p_meta.get("draftRound"),
                "draftPick":  p_meta.get("draftPick"),
                "adp":        round(float(row["adp"]), 1),
                "rank":       int(row["rank"]),
                "posRank":    f"{pos}{pos_counters[pos]}" if pos else "",
                "drafts":     int(row["drafts"]),
                "picks":      int(row["picks"]),
                "minPick":    int(row["min_pick"]),
                "maxPick":    int(row["max_pick"]),
            })
        out.setdefault(month, {})[vk] = records

    if skipped_no_name:
        info(f"  WARN: {skipped_no_name} format-bucket rows had unknown player_id")
    return out


# ---------- Auction records ----------

def build_auction(auction_ts, plookup, team_count, min_drafts):
    """Per-player auction price aggregates by view_key (startup_sf / startup_1qb / rookie)."""
    df = auction_ts.copy()
    df = df[df["st_teams"] == team_count]
    if df.empty:
        return {}

    def view_key(row):
        if row["dynasty_class"] == "rookie":
            return "rookie"
        return "startup_sf" if bool(row["is_superflex"]) else "startup_1qb"

    df["view_key"] = df.apply(view_key, axis=1)
    df["weighted_avg"] = df["avg_price"] * df["sales"]

    # Aggregate per (start_month, view_key, player_id)
    monthly = df.groupby(["start_month", "view_key", "player_id"]).agg(
        sum_weighted_avg=("weighted_avg", "sum"),
        sum_sales=("sales", "sum"),
        drafts=("drafts", "sum"),
        med_price=("med_price", "mean"),  # mean of medians; close enough for a display value
        min_price=("min_price", "min"),
        max_price=("max_price", "max"),
    ).reset_index()
    monthly["avg_price"] = monthly["sum_weighted_avg"] / monthly["sum_sales"]
    monthly = monthly[monthly["drafts"] >= min_drafts]
    monthly["start_month"] = monthly["start_month"]

    # ALL rollup
    all_df = df.groupby(["view_key", "player_id"]).agg(
        sum_weighted_avg=("weighted_avg", "sum"),
        sum_sales=("sales", "sum"),
        drafts=("drafts", "sum"),
        med_price=("med_price", "mean"),
        min_price=("min_price", "min"),
        max_price=("max_price", "max"),
    ).reset_index()
    all_df["avg_price"] = all_df["sum_weighted_avg"] / all_df["sum_sales"]
    all_df = all_df[all_df["drafts"] >= min_drafts]
    all_df["start_month"] = "ALL"

    combined = __import__("pandas").concat([monthly, all_df], ignore_index=True)

    out = {}
    for (month, vk), g in combined.groupby(["start_month", "view_key"]):
        bucket = []
        for _, row in g.iterrows():
            pid = str(row["player_id"])
            p   = plookup.get(pid)
            if not p:
                continue
            bucket.append({
                "sleeperId": pid,
                "name":      p["name"],
                "position":  p["position"],
                "avg":       round(float(row["avg_price"]), 1),
                "med":       round(float(row["med_price"]), 1),
                "min":       round(float(row["min_price"]), 1),
                "max":       round(float(row["max_price"]), 1),
                "sales":     int(row["sum_sales"]),
                "drafts":    int(row["drafts"]),
            })
        bucket.sort(key=lambda r: -r["avg"])
        out.setdefault(month, {})[vk] = bucket
    return out


# ---------- Pick availability heatmap ----------

HEATMAP_MAX_ROUNDS = 14  # board height — 14 rounds × team_count slots = 168 cells


def _availability_matrix_from_picks(picks, total_drafts, team_count, entity_ids,
                                    max_rounds=HEATMAP_MAX_ROUNDS):
    """Per-entity P(still available at round R, slot S) matrix.

    Math: for each (round, slot), pick_no = (round-1) * team_count + slot. The
    entity is "still on the board" at that pick if its actual pick_no >= target
    in this draft, OR it didn't appear in this draft at all (undrafted = still
    available). Aggregated across all `total_drafts` drafts in the universe.

    Args:
        picks: DataFrame with at least columns player_id (str), pick_no (int).
               Already filtered to the desired draft universe.
        total_drafts: size of the draft universe (denominator).
        team_count: slots per round.
        entity_ids: iterable of player_id strings to emit records for.
        max_rounds: matrix height.

    Returns: dict keyed by entity_id, each value the per-entity heatmap record
    without name/position metadata — the caller layers those in.
    """
    counts = picks.groupby("player_id")["pick_no"].agg(list).to_dict()
    out = {}
    for pid in entity_ids:
        pick_list = counts.get(pid, [])
        n_drafted = len(pick_list)
        if n_drafted == 0:
            continue
        matrix = []
        dropoff = []
        for rnd in range(1, max_rounds + 1):
            row_cells = []
            row_available_count = 0.0
            for slot in range(1, team_count + 1):
                target_pick = (rnd - 1) * team_count + slot
                drafts_where_taken_before = sum(1 for pn in pick_list if pn < target_pick)
                drafts_where_available = total_drafts - drafts_where_taken_before
                prob = drafts_where_available / total_drafts if total_drafts > 0 else 0
                row_cells.append(round(prob * 100))
                row_available_count += prob
            matrix.append(row_cells)
            dropoff.append(round((row_available_count / team_count) * 100))

        exp_pick = float(sum(pick_list) / len(pick_list)) if pick_list else None
        out[pid] = {
            "draftsSampled": n_drafted,
            "expectedPick":  round(exp_pick, 2) if exp_pick is not None else None,
            "matrix":        matrix,
            "dropoff":       dropoff,
            "rounds":        max_rounds,
            "slots":         team_count,
        }
    return out


def build_pick_availability(picks_path, draft_catalog_path, plookup, team_count, top_n, season):
    """For each top-N player, compute P(still available at round R, slot S) for an
    {team_count}-team draft, derived from completed dynasty startup drafts this season.
    """
    import pandas as pd

    info(f"  loading picks parquet: {picks_path}")
    picks = pd.read_parquet(picks_path)
    info(f"  loading draft catalog: {draft_catalog_path}")
    catalog = pd.read_parquet(draft_catalog_path)

    # Restrict to completed dynasty startup drafts of the right team count
    catalog = catalog[
        (catalog["season"] == season)
        & (catalog["draft_status"].astype(str).str.lower() == "complete")
        & (catalog["dynasty_class"].isin(["startup"]))
        & (catalog["st_teams"] == team_count)
    ].copy()
    if catalog.empty:
        info("  WARN: no completed dynasty startup drafts at this team_count; heatmap will be empty")
        return {}

    relevant_drafts = set(catalog["draft_id"].astype(str).tolist())
    info(f"  drafts used for heatmap: {len(relevant_drafts):,}")

    picks = picks[picks["draft_id"].astype(str).isin(relevant_drafts)].copy()
    picks["draft_id"] = picks["draft_id"].astype(str)
    picks["player_id"] = picks["player_id"].astype(str)
    picks["pick_no"] = pd.to_numeric(picks["pick_no"], errors="coerce")
    picks = picks[picks["pick_no"].notna() & picks["player_id"].notna()].copy()
    picks["pick_no"] = picks["pick_no"].astype(int)

    # Top-N by frequency (most-drafted players first)
    freq = picks.groupby("player_id").size().sort_values(ascending=False)
    top_players = freq.head(top_n).index.tolist()
    info(f"  computing heatmap for top {len(top_players)} most-drafted players")

    raw = _availability_matrix_from_picks(
        picks=picks,
        total_drafts=len(relevant_drafts),
        team_count=team_count,
        entity_ids=top_players,
    )
    # Layer in name + position from the Sleeper lookup
    out = {}
    for pid, rec in raw.items():
        p = plookup.get(pid)
        if not p:
            continue
        out[pid] = {"name": p["name"], "position": p["position"], **rec}
    return out


def build_rdp_pick_availability(picks_path, draft_catalog_path, sleeper_players,
                                team_count, season, min_drafts=1):
    """Per-RDP-placeholder availability heatmap. Companion to build_pick_availability.

    Only consumes picks-bucket drafts (those whose K placements fit the picks-as-K
    fingerprint). K player_ids in those drafts are rewritten to ROOKIE_PICK_X.YY
    via relabel_picks_K_to_rdp BEFORE the matrix is computed, so each [round][slot]
    cell answers "P(this RDP slot still on the board?)" across picks-style startups.

    Output is keyed by ROOKIE_PICK_X.YY, same record shape as build_pick_availability,
    so the downstream Heatmap.render and pick-availability.json consumers don't care.
    """
    import pandas as pd

    picks_all = pd.read_parquet(picks_path)
    catalog   = pd.read_parquet(draft_catalog_path)

    # Filter catalog to this season's completed startups at our team_count, then
    # classify into picks/simple/rookies and keep only picks-bucket drafts.
    catalog = catalog[
        (catalog["season"] == season)
        & (catalog["draft_status"].astype(str).str.lower() == "complete")
        & (catalog["dynasty_class"] == "startup")
        & (catalog["st_teams"] == team_count)
    ].copy()
    if catalog.empty:
        return {}

    cls = classify_startup_drafts(catalog, picks_all, sleeper_players)
    cls = cls[(cls["st_teams"] == team_count) & (cls["bucket"] == "picks")]
    if cls.empty:
        info("  no picks-bucket drafts found; RDP heatmap empty")
        return {}

    # Restrict picks to picks-bucket drafts, merge bucket metadata (relabel
    # needs st_teams for round_calc).
    p = picks_all.copy()
    p["player_id"] = p["player_id"].astype(str)
    p["draft_id"]  = p["draft_id"].astype(str)
    p = p.merge(
        cls[["draft_id", "bucket", "is_superflex", "start_month", "st_teams"]],
        on="draft_id", how="inner",
    )

    # K -> ROOKIE_PICK_X.YY rewrite (returns the modified DataFrame + name dict).
    p, rdp_meta = relabel_picks_K_to_rdp(p, sleeper_players)
    if not rdp_meta:
        return {}

    # Keep RDP rows only — real-player heatmap is already built upstream.
    p["pick_no"] = pd.to_numeric(p["pick_no"], errors="coerce")
    rdp_only = p[(p["player_id"].isin(rdp_meta.keys())) & p["pick_no"].notna()].copy()
    rdp_only["pick_no"] = rdp_only["pick_no"].astype(int)
    if rdp_only.empty:
        return {}

    total_drafts = cls["draft_id"].nunique()
    info(f"  RDP heatmap: {total_drafts:,} qualifying picks-bucket drafts, {len(rdp_meta)} RDP slots")

    raw = _availability_matrix_from_picks(
        picks=rdp_only,
        total_drafts=total_drafts,
        team_count=team_count,
        entity_ids=list(rdp_meta.keys()),
    )
    # Filter by min_drafts and layer in synthetic metadata
    out = {}
    for rdp_id, rec in raw.items():
        if rec["draftsSampled"] < min_drafts:
            continue
        out[rdp_id] = {
            "name":     rdp_meta[rdp_id],
            "position": "RDP",
            **rec,
        }
    return out


def build_rookie_draft_pick_availability(picks_path, draft_catalog_path, plookup,
                                         team_count, season, min_drafts=1, current_season=None):
    """Per-rookie availability heatmap built from rookie-only drafts.

    Companion to build_pick_availability — but instead of feeding off
    completed dynasty STARTUP drafts, this consumes drafts where
    dynasty_class == 'rookie' (Sleeper's rookie-class drafts that
    happen alongside dynasty leagues each spring, ≤6 rounds).

    Keyed by sleeperId so the existing Heatmap.render path can look
    rookies up by the same id. Emitted to a separate `rookiePlayers`
    section of pick-availability.json so it doesn't collide with the
    startup heatmaps for players who appear in both universes.
    """
    import pandas as pd

    info(f"  loading picks parquet: {picks_path}")
    picks = pd.read_parquet(picks_path)
    info(f"  loading draft catalog: {draft_catalog_path}")
    catalog = pd.read_parquet(draft_catalog_path)

    catalog = catalog[
        (catalog["season"] == season)
        & (catalog["draft_status"].astype(str).str.lower() == "complete")
        & (catalog["dynasty_class"] == "rookie")
        & (catalog["st_teams"] == team_count)
    ].copy()
    if catalog.empty:
        info("  WARN: no completed rookie drafts at this team_count; rookie heatmap empty")
        return {}

    relevant_drafts = set(catalog["draft_id"].astype(str).tolist())
    info(f"  rookie drafts used for heatmap: {len(relevant_drafts):,}")

    picks = picks[picks["draft_id"].astype(str).isin(relevant_drafts)].copy()
    picks["draft_id"]  = picks["draft_id"].astype(str)
    picks["player_id"] = picks["player_id"].astype(str)
    picks["pick_no"]   = pd.to_numeric(picks["pick_no"], errors="coerce")
    picks = picks[picks["pick_no"].notna() & picks["player_id"].notna()].copy()
    picks["pick_no"]   = picks["pick_no"].astype(int)
    if picks.empty:
        return {}

    # Take every player who appears in at least min_drafts rookie drafts,
    # restricted to the actual incoming class for THIS season — a player who
    # was a rookie in season N currently has years_exp == (current_season - N).
    # plookup carries current Sleeper years_exp, so we offset by the gap.
    _ROOKIE_POSITIONS = {"QB", "RB", "WR", "TE", "K"}
    _target_yexp = max(0, (current_season or 0) - (season or 0)) if (current_season and season) else 0
    incoming_rookie_pids = {
        pid for pid, p in plookup.items()
        if p.get("yearsExp") == _target_yexp
        and (p.get("position") or "").upper() in _ROOKIE_POSITIONS
    }
    freq = picks.groupby("player_id").size()
    entity_ids = [pid for pid in freq[freq >= min_drafts].index.tolist()
                  if pid in incoming_rookie_pids]
    info(f"  rookie heatmap entities (>={min_drafts} drafts, target yearsExp={_target_yexp}): {len(entity_ids)}")

    raw = _availability_matrix_from_picks(
        picks=picks,
        total_drafts=len(relevant_drafts),
        team_count=team_count,
        entity_ids=entity_ids,
        max_rounds=6,   # rookie drafts are ≤6 rounds
    )
    out = {}
    for pid, rec in raw.items():
        p = plookup.get(pid)
        if not p:
            continue
        out[pid] = {"name": p["name"], "position": p["position"], **rec}
    return out


# ---------- main ----------

def _build_one_season(s, *, adp_ts, auction_ts, catalog_df, catalog_path, picks_dir,
                      sleeper, plookup, team_count, min_drafts, top_n, current_season):
    """Build adp_out / auc_out / pa_out / rookie_pa for a single season.

    Returns (adp_out, auc_out, pa_out, rookie_pa) or None if the season has
    no usable data. Format-bucket views (Picks/Simple/With-Rookies) and the
    heatmap require a per-season picks_{s}.parquet; if absent, those views
    are silently omitted but legacy view_keys (startup_sf / startup_1qb /
    rookie) still emit so the year is still browsable.
    """
    import pandas as pd

    picks_path = picks_dir / f"picks_{s}.parquet"
    has_picks  = picks_path.exists()

    # Filter time series to this season's months so byMonth.ALL aggregates
    # only this year's drafts (not all 8 years).
    adp_ts_s     = adp_ts[adp_ts["start_month"].astype(str).str.startswith(f"{s}-")].copy()
    auction_ts_s = auction_ts[auction_ts["start_month"].astype(str).str.startswith(f"{s}-")].copy()

    if adp_ts_s.empty and auction_ts_s.empty and not has_picks:
        info(f"  [{s}] no data found; skipping")
        return None

    # ADP — legacy view_keys (rookie / startup_sf / startup_1qb)
    info(f"  [{s}] aggregating ADP (legacy view_keys)...")
    adp_out = build_adp(adp_ts_s, plookup, team_count=team_count, min_drafts=min_drafts,
                        season=s, current_season=current_season)
    info(f"    ADP buckets: {len(adp_out)} months (incl. ALL)")

    # ADP — format buckets (picks/simple/rookies × sf/1qb), needs per-season picks
    if has_picks:
        info(f"  [{s}] aggregating ADP by format bucket...")
        picks_df = pd.read_parquet(picks_path)
        fmt_out = build_format_adp(picks_df, catalog_df, sleeper, plookup,
                                    team_count=team_count, min_drafts=min_drafts,
                                    season=s, current_season=current_season)
        for month, sub in fmt_out.items():
            adp_out.setdefault(month, {}).update(sub)
        bucket_counts = {}
        for month, sub in fmt_out.items():
            for vk, rows in sub.items():
                bucket_counts[vk] = bucket_counts.get(vk, 0) + len(rows)
        if bucket_counts:
            info(f"    format-bucket records: " + ", ".join(f"{k}={v}" for k, v in sorted(bucket_counts.items())))
    else:
        info(f"  [{s}] no picks_{s}.parquet; skipping format-bucket views (Picks/Simple/With-Rookies will be unavailable)")

    # Auction
    info(f"  [{s}] aggregating auction...")
    auc_out = build_auction(auction_ts_s, plookup, team_count=team_count, min_drafts=min_drafts)
    info(f"    auction buckets: {len(auc_out)} months (incl. ALL)")

    # Pick availability — needs per-season picks parquet
    pa_out, rookie_pa = {}, {}
    if has_picks:
        info(f"  [{s}] computing pick availability heatmap...")
        pa_out = build_pick_availability(picks_path, catalog_path, plookup,
                                          team_count=team_count, top_n=top_n, season=s)
        info(f"    heatmap players: {len(pa_out)}")

        info(f"  [{s}] computing RDP pick availability heatmap...")
        rdp_pa = build_rdp_pick_availability(picks_path, catalog_path, sleeper,
                                              team_count=team_count, season=s,
                                              min_drafts=min_drafts)
        info(f"    RDP heatmap entries: {len(rdp_pa)}")
        pa_out.update(rdp_pa)

        info(f"  [{s}] computing rookie-only-draft heatmap...")
        rookie_pa = build_rookie_draft_pick_availability(
            picks_path, catalog_path, plookup,
            team_count=team_count, season=s, min_drafts=min_drafts,
            current_season=current_season,
        )
        info(f"    rookie-draft heatmap entries: {len(rookie_pa)}")

    # Offense-only contract — drop any IDP / DST / P / FB records that
    # leaked through (older Sleeper datasets are noisier). 2026 records
    # are already offense-only; this is a no-op for them.
    _filter_offense_inplace(adp_out)
    _filter_offense_inplace(auc_out)

    return adp_out, auc_out, pa_out, rookie_pa


# ---------- main ----------

def main():
    cfg, snap, picks_dir = load_cfg()
    # Season rollover: NFL Draft is end of April. From Apr-onwards the new
    # class is the "current" one; Jan-Mar still belongs to last April's class.
    # Config value wins when set; otherwise auto-detect so the pipeline keeps
    # working through next April without anyone touching the config file.
    _today = date.today()
    _auto_season    = _today.year if _today.month >= 4 else _today.year - 1
    current_season  = int(cfg.get("season") or _auto_season)
    if not cfg.get("season"):
        info(f"  current season auto-detected: {current_season} (today={_today.isoformat()})")

    # Per-year archival: emit data/adp-{year}.json + data/auction-{year}.json
    # + data/pick-availability-{year}.json for each season in this list. The
    # current_season's payload is ALSO written to the canonical (no-suffix)
    # filenames so existing site behavior is unchanged for current-year data.
    # 2022 is the first year where Sleeper's dynasty draft corpus has rich
    # format-bucket data (picks/simple/rookies variants + rookie drafts +
    # RDP placeholders) so every year in this range can render with the same
    # 2026-style board layout. Older years (2019-2021) only had legacy
    # startup-only ADP and looked visually different — they're omitted
    # rather than show an inconsistent UI experience.
    seasons_to_export = cfg.get("seasons_to_export") or list(range(2022, current_season + 1))
    seasons_to_export = [int(s) for s in seasons_to_export]
    if current_season not in seasons_to_export:
        seasons_to_export.append(current_season)
    seasons_to_export = sorted(set(seasons_to_export))
    info(f"  seasons to export: {seasons_to_export}")

    team_count   = int(cfg.get("team_count") or 12)
    min_drafts   = int(cfg.get("min_drafts") or 5)
    top_n        = int(cfg.get("top_n_heatmap") or 300)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    try:
        import pandas as pd
    except ImportError:
        die("pandas not installed. Run: python -m pip install pandas pyarrow")

    # Load all-season snapshots once; per-season filtering happens inside the loop.
    adp_ts_path  = snap / "adp_time_series"     / "adp_time_series_ALL.parquet"
    auction_path = snap / "auction_price_series" / "auction_price_series_ALL.parquet"
    catalog_path = snap / "draft_catalog"        / "draft_catalog_ALL.parquet"

    for required in (adp_ts_path, auction_path, catalog_path):
        if not required.exists():
            die(f"missing input parquet: {required}")

    info(f"reading ADP time series: {adp_ts_path}")
    adp_ts = pd.read_parquet(adp_ts_path)
    info(f"  rows: {len(adp_ts):,}")

    info(f"reading auction time series: {auction_path}")
    auction_ts = pd.read_parquet(auction_path)
    info(f"  rows: {len(auction_ts):,}")

    info(f"reading draft catalog: {catalog_path}")
    catalog_df = pd.read_parquet(catalog_path)
    info(f"  rows: {len(catalog_df):,}")

    # Fetch sleeper names (one HTTP call, shared across seasons)
    sleeper = fetch_sleeper_players()
    plookup = build_player_lookup(sleeper)
    info(f"  built sleeper lookup: {len(plookup):,} players")

    now = datetime.now(timezone.utc).isoformat()

    # ── Weekly snapshot rotation (current-year only) ──────────────────────
    # Before overwriting the current-year adp.json, copy the EXISTING file to
    # adp-prev.json if either (a) no prev exists yet, or (b) the current prev
    # snapshot is 5+ days old. adp-prev.json is the "~7 day ago" ADP picture
    # used by the adp-tool board's weekly trend arrows.
    cur_path  = DATA_DIR / "adp.json"
    prev_path = DATA_DIR / "adp-prev.json"
    if cur_path.exists():
        should_rotate = True
        if prev_path.exists():
            try:
                prev_meta = json.loads(prev_path.read_text(encoding="utf-8"))
                prev_as_of = prev_meta.get("asOf") or prev_meta.get("version") or ""
                if prev_as_of:
                    prev_dt = datetime.fromisoformat(prev_as_of.replace("Z","+00:00")) if "T" in prev_as_of else datetime.strptime(prev_as_of, "%Y-%m-%d")
                    if prev_dt.tzinfo is None: prev_dt = prev_dt.replace(tzinfo=timezone.utc)
                    age_days = (datetime.now(timezone.utc) - prev_dt).days
                    if age_days < 5:
                        should_rotate = False
                        info(f"  adp-prev.json age {age_days}d (<5d); skipping rotation")
            except Exception as e:
                info(f"  could not parse adp-prev.json age, will rotate: {e}")
        if should_rotate:
            try:
                cur_payload = json.loads(cur_path.read_text(encoding="utf-8"))
                cur_payload["asOf"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                atomic_write_json(prev_path, cur_payload)
                info(f"  rotated existing adp.json → adp-prev.json (asOf={cur_payload['asOf']})")
            except Exception as e:
                info(f"  rotation failed (continuing): {e}")

    # ── Per-season build + write loop ─────────────────────────────────────
    available_years = []
    for s in seasons_to_export:
        info(f"\n=== building year {s} ===")
        result = _build_one_season(
            s,
            adp_ts=adp_ts, auction_ts=auction_ts, catalog_df=catalog_df,
            catalog_path=catalog_path, picks_dir=picks_dir,
            sleeper=sleeper, plookup=plookup,
            team_count=team_count, min_drafts=min_drafts, top_n=top_n,
            current_season=current_season,
        )
        if result is None:
            continue
        adp_out, auc_out, pa_out, rookie_pa = result

        # Year-stamped files
        adp_year_path = DATA_DIR / f"adp-{s}.json"
        auc_year_path = DATA_DIR / f"auction-{s}.json"
        pa_year_path  = DATA_DIR / f"pick-availability-{s}.json"

        adp_payload = {
            "version":    now,
            "season":     s,
            "teamCount":  team_count,
            "minDrafts":  min_drafts,
            "byMonth":    adp_out,
        }
        auc_payload = {
            "version":    now,
            "season":     s,
            "teamCount":  team_count,
            "minDrafts":  min_drafts,
            "byMonth":    auc_out,
        }
        pa_payload = {
            "version":       now,
            "season":        s,
            "teamCount":     team_count,
            "topN":          top_n,
            "players":       pa_out,
            "rookiePlayers": rookie_pa,
        }

        atomic_write_json(adp_year_path, adp_payload)
        atomic_write_json(auc_year_path, auc_payload)
        atomic_write_json(pa_year_path,  pa_payload)
        info(f"  [{s}] wrote adp-{s}.json + auction-{s}.json + pick-availability-{s}.json")
        available_years.append(s)

        # The current-year payload is ALSO written to the canonical no-suffix
        # filenames so existing site behavior is preserved for current data.
        if s == current_season:
            # Inject availableYears into the canonical adp.json so the frontend
            # can populate its year dropdown without probing for files.
            canonical_adp = dict(adp_payload)
            canonical_adp["availableYears"] = sorted(available_years + [
                y for y in seasons_to_export if y > current_season  # not yet built
            ])
            atomic_write_json(cur_path, canonical_adp)
            atomic_write_json(DATA_DIR / "auction.json", auc_payload)
            atomic_write_json(DATA_DIR / "pick-availability.json", pa_payload)
            info(f"  [{s}] also wrote canonical adp.json / auction.json / pick-availability.json")

    # Re-write canonical adp.json once more with the final availableYears list
    # (in case current_season wasn't last in the loop).
    if cur_path.exists() and available_years:
        try:
            canonical_payload = json.loads(cur_path.read_text(encoding="utf-8"))
            canonical_payload["availableYears"] = sorted(available_years)
            atomic_write_json(cur_path, canonical_payload)
        except Exception as e:
            info(f"  could not re-stamp availableYears (continuing): {e}")

    info(f"\nOK -- wrote {len(available_years)} season(s): {available_years}")


if __name__ == "__main__":
    main()
