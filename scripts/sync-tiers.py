"""
sync-tiers.py -- regenerate the TIER_PLAYERS block in tiers.html AND write
data/tiers.json from an exported Sheet CSV (preferred) or the Google API
(fallback).

Data source priority:
  1. data/source/tiers/tiers.csv          (PREFERRED, committed to repo)
  2. Google Sheets API via service-account.json + sync-tiers.config.json
     (fallback when the CSV doesn't exist)

Recommended workflow (CSV mode):
  - Drop the latest analyst rankings CSV at data/source/tiers/tiers.csv
    (or paste into your Google Sheet, hand-edit, File -> Download -> CSV).
  - push.bat runs sync-tiers.py which reads the CSV, regenerates tiers.html
    + data/tiers.json, then git commits + pushes. No API auth needed.
  - The committed CSV gives you a versioned audit trail of every tier change.

The original API-based flow still works when CSV is absent (backward-compat
for older setups that haven't migrated). Both paths produce identical
tiers.html / data/tiers.json output.

How it works:
  1. Look for data/source/tiers/tiers.csv. If present, parse it.
  2. Otherwise, read sync-tiers.config.json + auth with Google + fetch
     the configured sheet tab.
  3. Either way, map each row to a TIER_PLAYERS object via the header row.
  4. Replace the block between `// TIERS:START` / `// TIERS:END` markers
     inside tiers.html, atomically.
  5. Write data/tiers.json (name-keyed dict) so data-bootstrap.js can
     hydrate window.TIERS_DATA on every page. Lets compare.html (and any
     future page) render a tier+B/S/H badge without having to inline-import
     tiers.html's TIER_PLAYERS constant.

Fails LOUDLY (non-zero exit) on any problem so push.bat aborts before commit:
  - markers not found in tiers.html
  - 0 rows parsed from chosen source
  - fewer than MIN_ROWS_SANITY rows (refuses to overwrite a populated file
    with a near-empty one)

Local-only -- listed in .gitignore.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------- config -----------------------------------------------------------

REPO_ROOT   = Path(__file__).resolve().parent.parent
TIERS_HTML  = REPO_ROOT / "index.html"
TIERS_JSON  = REPO_ROOT / "data" / "tiers.json"
TIERS_CSV   = REPO_ROOT / "data" / "source" / "tiers" / "tiers.csv"
CFG_PATH    = REPO_ROOT / "sync-tiers.config.json"
KEY_PATH    = REPO_ROOT / "service-account.json"

# Header name in Sheet -> key in TIER_PLAYERS. Header lookup is case- and
# whitespace-insensitive; non-alphanumeric chars are stripped before lookup.
FIELDS = [
    "tier", "name",
    "trending", "buySell", "priority", "contender", "notes",
    # posRank is computed by compute_pos_ranks() below — walks records in
    # tier-then-row order and assigns "WR1", "WR2", "QB1", ... per position.
    # Sheet row order = positional rank. FP's PRK no longer touches the page.
    "posRank",
]

# Maps normalized sheet header text -> internal field key.
# Aliases cover the FPTS sheet's descriptive column names.
HEADER_ALIASES = {
    "tier":              "tier",
    "player":            "name",
    "name":              "name",
    "trending":          "trending",
    "buysellhold":       "buySell",
    "buysell":           "buySell",
    "prioritylevel":     "priority",
    "priority":          "priority",
    "contenderrebuild":  "contender",
    "contender":         "contender",
    "playernotes":       "notes",
    "notes":             "notes",
}

# Canonical tier codes — rows whose "tier" cell isn't one of these are treated
# as decorative dividers and skipped.
VALID_TIERS = {
    "S++", "S+", "S",
    "A+", "A", "A-",
    "B+", "B", "B-",
    "C+", "C", "C-",
}

START_MARKER = "// TIERS:START"
END_MARKER   = "// TIERS:END"

SYNCED_START = "<!-- TIERS:SYNCED:START -->"
SYNCED_END   = "<!-- TIERS:SYNCED:END -->"

MIN_ROWS_SANITY    = 50   # refuse to write if fewer than this many player rows are parsed
HEADER_SEARCH_DEPTH = 20  # scan this many rows for the header row
MIN_HEADER_MATCHES  = 5   # a row must hit this many known fields to be the header


# ---------- helpers ----------------------------------------------------------

def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"[sync-tiers] ERROR: {msg}\n")
    sys.exit(code)


def info(msg: str) -> None:
    sys.stdout.write(f"[sync-tiers] {msg}\n")


def load_cfg() -> dict:
    if not CFG_PATH.exists():
        die(f"missing config: {CFG_PATH.name}. Copy sync-tiers.config.example.json and fill in your sheet details.")
    try:
        cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        die(f"could not parse {CFG_PATH.name}: {e}")
    for required in ("spreadsheet_id", "tab_name"):
        if not cfg.get(required):
            die(f"{CFG_PATH.name} is missing required field: {required}")
    return cfg


# ──────────────────────────────────────────────────────────────────────────
# Value-divider parser (auto-detected from data/source/tiers/tiers.csv)
# ──────────────────────────────────────────────────────────────────────────
# The analyst rankings CSV uses tier-divider rows like
#     "VALUE = 3 BASE 1s (+/-)"
# in column A, followed by numbered player rows (Rank,Player,Position,Team,
# Recent Movement). We map each divider to a tier code and emit FIELDS-
# shaped records so the rest of the pipeline is unchanged.
VALUE_DIVIDER_TO_TIER = {
    "VALUE = 3 BASE 1s (+/-)":                            "S++",
    "VALUE = 2.5 BASE 1s (+/-)":                          "S+",
    "VALUE = 2 BASE 1s (+/-)":                            "S",
    "VALUE = 1.5 BASE 1s (+/-)":                          "A+",
    "VALUE = 1.25 BASE 1s (+/-)":                         "A",
    "VALUE = 1 BASE 1 (+/-)":                             "A-",
    'VALUE = "LATE" 1 (+/-) // 0.75 BASE 1s (+/-)':       "B+",
    'VALUE = "EARLY" 2 (+/-) // 0.5 BASE 1s (+/-)':       "B",
    'VALUE = "BASE" 2 // 0.33 BASE 1s (+/-)':             "B-",
    'VALUE = "LATE" 2 (+/-)':                             "C+",
    'VALUE = "EARLY" 3 (+/-)':                            "C",
    'VALUE = "BASE" 3 (+/-)':                             "C-",
}
_VALUE_DIVIDER_NORMALIZED = {" ".join(k.split()): v for k, v in VALUE_DIVIDER_TO_TIER.items()}


def _looks_like_value_divider_csv(rows: list[list[str]]) -> bool:
    """Sniff the first ~10 rows for a 'VALUE = X BASE' tier-divider row."""
    for row in rows[:10]:
        for cell in (row or []):
            c = " ".join(str(cell).split()).strip()
            if c in _VALUE_DIVIDER_NORMALIZED:
                return True
    return False


def parse_value_divider_rows(rows: list[list[str]]) -> list[dict]:
    """Parse value-divider rows -> FIELDS-shaped records. Tier comes from
    the most recently-seen VALUE divider. The trending / buySell / priority
    / contender / notes fields are left empty so the admin scratchpad can
    layer overrides on top."""
    out = []
    current_tier = None
    for row in rows:
        if not row:
            continue
        c1 = " ".join(str(row[0]).split()).strip()
        if c1 in _VALUE_DIVIDER_NORMALIZED:
            current_tier = _VALUE_DIVIDER_NORMALIZED[c1]
            continue
        # Need: column 0 is a numeric rank, current_tier is set, column 1 has a name
        if not c1.isdigit() or current_tier is None:
            continue
        name = (str(row[1]).strip() if len(row) > 1 else "")
        if not name:
            continue
        # Recent Movement column (col 4) is ignored — trending arrows are
        # reserved for manual admin entry.
        out.append({
            "tier":      current_tier,
            "name":      name,
            "trending":  "",
            "buySell":   "",
            "priority":  "",
            "contender": "",
            "notes":     "",
        })
    info(f"parsed {len(out)} value-divider player rows")
    if len(out) < MIN_ROWS_SANITY:
        die(f"only {len(out)} rows parsed -- refusing to overwrite tiers.html. "
            f"Check that the CSV has 'VALUE = X BASE' divider rows + numbered player rows.")
    return out


def fetch_rows_from_csv(path: Path) -> list[list[str]]:
    """Read the exported Sheet CSV and return rows (list of cells).
    Matches the shape that fetch_rows() returns from the Google API so
    map_rows() can consume either."""
    import csv as _csv
    info(f"reading CSV {path}")
    rows: list[list[str]] = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in _csv.reader(f):
            rows.append([str(c) for c in row])
    info(f"loaded {len(rows)} rows from CSV")
    return rows


def fetch_rows(cfg: dict) -> list[list[str]]:
    """Read the configured tab from Google Sheets and return rows (list of cells)."""
    if not KEY_PATH.exists():
        die(f"missing credentials: {KEY_PATH.name}. See setup instructions.")

    try:
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build
    except ImportError:
        die("Python deps not installed. Run:  python -m pip install google-api-python-client google-auth")

    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    creds = Credentials.from_service_account_file(str(KEY_PATH), scopes=scopes)
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)

    # Tab names with spaces or non-alphanumeric chars must be single-quoted
    # in the A1 range syntax. Escape any embedded single quotes by doubling.
    tab = cfg["tab_name"]
    quoted_tab = "'" + tab.replace("'", "''") + "'"
    rng = quoted_tab
    if cfg.get("range"):
        rng = f"{quoted_tab}!{cfg['range']}"

    info(f"reading {cfg['spreadsheet_id']} -> {rng}")
    resp = svc.spreadsheets().values().get(
        spreadsheetId=cfg["spreadsheet_id"],
        range=rng,
        valueRenderOption="FORMATTED_VALUE",
    ).execute()
    return resp.get("values", [])


def normalize_header(s: str) -> str:
    """Lowercase and strip every non-alphanumeric character."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def find_header_row(rows: list[list[str]]) -> int:
    """Scan the top of the sheet for the row that looks like a header.
       Returns the 0-indexed row number. Raises if no candidate is found."""
    best_idx = -1
    best_hits = 0
    depth = min(HEADER_SEARCH_DEPTH, len(rows))
    for i in range(depth):
        norm = [normalize_header(c) for c in rows[i]]
        hits = sum(1 for n in norm if n in HEADER_ALIASES)
        if hits > best_hits:
            best_hits = hits
            best_idx = i
    if best_idx == -1 or best_hits < MIN_HEADER_MATCHES:
        die(f"could not find a header row in the first {depth} rows "
            f"(best match had only {best_hits} recognized columns). "
            f"Make sure the sheet has columns like Tier / Player / Position / 2026 ADP etc.")
    info(f"header row detected at sheet row {best_idx + 1} ({best_hits} columns matched)")
    return best_idx


def map_rows(rows: list[list[str]]) -> list[dict]:
    if not rows:
        die("sheet returned 0 rows (is the tab name correct?)")

    header_idx = find_header_row(rows)
    header     = rows[header_idx]
    body       = rows[header_idx + 1:]

    # Build column-index -> internal field-key map via aliases.
    col_to_field: dict[int, str] = {}
    for col_idx, cell in enumerate(header):
        norm = normalize_header(cell)
        if norm in HEADER_ALIASES:
            col_to_field[col_idx] = HEADER_ALIASES[norm]

    if not col_to_field:
        die(f"detected header row but matched 0 columns. Header: {header}")

    # posRank is intentionally computed (not read from Sheet) — don't warn.
    missing_fields = set(FIELDS) - set(col_to_field.values()) - {"posRank"}
    if missing_fields:
        info(f"WARN: sheet is missing columns for: {sorted(missing_fields)} (will default to empty string)")

    out: list[dict] = []
    skipped_dividers = 0
    skipped_blank    = 0

    for row in body:
        rec = {f: "" for f in FIELDS}
        for col_idx, field in col_to_field.items():
            if col_idx < len(row):
                rec[field] = str(row[col_idx]).strip()

        # Drop fully blank rows
        if not any(rec.values()):
            skipped_blank += 1
            continue

        # Drop tier-divider rows (anything whose Tier cell isn't a canonical code)
        if rec.get("tier") not in VALID_TIERS:
            skipped_dividers += 1
            continue

        # Player name is required for a real row
        if not rec.get("name"):
            skipped_blank += 1
            continue

        out.append(rec)

    info(f"kept {len(out)} player rows  (skipped {skipped_dividers} dividers, {skipped_blank} blank/incomplete)")

    if len(out) < MIN_ROWS_SANITY:
        die(f"only {len(out)} rows after parsing -- refusing to overwrite tiers.html. "
            f"Adjust MIN_ROWS_SANITY in this script if your list is intentionally small.")

    return out


def compute_pos_ranks(records: list[dict]) -> None:
    """Copy each player's posRank verbatim from data/values.json (FP's
    published positional rankings). Mutates `records` in place.

    FP's posRank is the source of truth so the PRK column matches what
    every fantasy outlet shows (Chase=WR1, Burrow=QB3, etc.) rather than
    re-deriving from the analyst CSV's row order (which reflects analyst
    opinion, not industry consensus).

    If values.json is missing or a player's posRank can't be resolved,
    that player's posRank stays blank (page falls back to position pill
    only)."""
    values_path = REPO_ROOT / "data" / "values.json"
    if not values_path.exists():
        info(f"WARN: no {values_path.relative_to(REPO_ROOT)} found -- posRank left blank "
             f"(run sync-fp.py first to populate position data)")
        return
    try:
        payload = json.loads(values_path.read_text(encoding="utf-8"))
        players = payload.get("players", {}) if isinstance(payload, dict) else {}
    except Exception as e:
        info(f"WARN: failed to parse values.json ({e}) -- posRank left blank")
        return

    # Build a case/punctuation-tolerant name → (pos, posRank) lookup. FP's
    # values.json strips Jr/Sr/II/III/IV/V suffixes from names ("Brian
    # Thomas Jr." → "Brian Thomas"), so we strip those here before
    # alphanum-collapsing to match. Mirrors _normNameTiers in index.html.
    _suffix_pat = re.compile(r"\b(jr|sr|ii|iii|iv|v)\.?\b")
    def _norm(s):
        s = str(s or "").lower()
        s = _suffix_pat.sub("", s)
        return "".join(c for c in s if c.isalnum())

    name_to_rec = {}
    for fp_name, rec in players.items():
        if not isinstance(rec, dict):
            continue
        name_to_rec[_norm(fp_name)] = rec

    counters: dict[str, int] = {}
    unresolved = 0
    valid_pos = {"QB", "RB", "WR", "TE", "K"}
    for rec in records:
        name = str(rec.get("name", "")).strip()
        if not name:
            continue
        fp_rec = name_to_rec.get(_norm(name))
        if not fp_rec:
            unresolved += 1
            continue
        pos = str(fp_rec.get("pos", "")).upper().strip()
        fp_pos_rank = str(fp_rec.get("posRank", "")).strip()
        if pos in valid_pos:
            counters[pos] = counters.get(pos, 0) + 1
        if fp_pos_rank:
            rec["posRank"] = fp_pos_rank
        else:
            unresolved += 1

    summary = ", ".join(f"{counters[p]} {p}s" for p in sorted(counters))
    note = f"  ({unresolved} player(s) had no FP posRank — left blank)" if unresolved else ""
    info(f"posRank copied from values.json: {summary}{note}")


def render_block(records: list[dict], source_label: str = "Google Sheet") -> str:
    """Render the JS array exactly matching the existing in-file shape.
    source_label appears in the leading comment so the file shows whether
    the latest sync read from the CSV export or the Google API."""
    lines = [f"{START_MARKER} -- DO NOT EDIT BY HAND. Regenerated from {source_label} by sync-tiers.py",
             "const TIER_PLAYERS = ["]
    for i, rec in enumerate(records):
        lines.append("  {")
        for j, f in enumerate(FIELDS):
            val = rec.get(f, "")
            val_json = json.dumps(val, ensure_ascii=False)
            comma = "," if j < len(FIELDS) - 1 else ""
            lines.append(f'    "{f}": {val_json}{comma}')
        trail = "," if i < len(records) - 1 else ""
        lines.append("  }" + trail)
    lines.append("];")
    lines.append(END_MARKER)
    return "\n".join(lines)


def replace_block(html: str, new_block: str) -> str:
    start_idx = html.find(START_MARKER)
    end_idx   = html.find(END_MARKER)
    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        die(f"could not find {START_MARKER} / {END_MARKER} in tiers.html. Did the markers get edited out?")

    # Replace from the start of the START line to the end of the END line.
    before = html[: start_idx]
    after_start = html.find("\n", end_idx)
    if after_start == -1:
        after = ""
    else:
        after = html[after_start:]   # keeps the trailing newline + rest of file
    return before + new_block + after


def write_tiers_json(records: list[dict]) -> bool:
    """Write data/tiers.json in name-keyed dict form for data-bootstrap.js to
    hydrate as window.TIERS_DATA. Returns True if the file changed."""
    players = {}
    for rec in records:
        name = (rec.get("name") or "").strip()
        if not name:
            continue
        players[name] = {k: v for k, v in rec.items() if k != "name"}

    payload = {
        "version":     datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "source":      "Google Sheet via sync-tiers.py",
        "playerCount": len(players),
        "players":     players,
    }
    new_text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

    if TIERS_JSON.exists():
        try:
            old_text = TIERS_JSON.read_text(encoding="utf-8")
        except Exception:
            old_text = ""
        # Skip rewrite when only the version timestamp changed — same data,
        # cleaner git history. Compare players dict only.
        try:
            old_payload = json.loads(old_text)
            if old_payload.get("players") == players:
                return False
        except Exception:
            pass

    TIERS_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = TIERS_JSON.with_suffix(".json.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(tmp, TIERS_JSON)
    return True


def update_synced_stamp(html: str) -> str:
    """Replace the human-readable last-synced timestamp shown in the nav bar."""
    start_idx = html.find(SYNCED_START)
    end_idx   = html.find(SYNCED_END)
    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        info(f"WARN: synced-stamp markers not found in tiers.html, skipping nav timestamp update")
        return html
    stamp = datetime.now().strftime("%b %-d, %Y %-I:%M %p") if os.name != "nt" \
            else datetime.now().strftime("%b %#d, %Y %#I:%M %p")
    inside = stamp
    before = html[: start_idx + len(SYNCED_START)]
    after  = html[end_idx:]
    return before + inside + after


# ---------- main -------------------------------------------------------------

def main() -> int:
    if not TIERS_HTML.exists():
        die(f"missing {TIERS_HTML.name} -- is this script running from the repo root?")

    # Prefer the committed CSV export (data/source/tiers/tiers.csv) when
    # present -- that's the recommended workflow per the docstring. Fall
    # back to the Google Sheets API if the CSV doesn't exist (backward-
    # compat for setups that haven't migrated yet).
    if TIERS_CSV.exists():
        rows = fetch_rows_from_csv(TIERS_CSV)
        # Auto-detect value-divider format (VALUE = X BASE divider rows).
        # The simplest workflow is "drop rankings CSV here -> push.bat".
        # When the CSV is in Sheet-format (Tier/Player headers), fall
        # through to map_rows() unchanged.
        if _looks_like_value_divider_csv(rows):
            info("value-divider CSV detected (VALUE = X BASE dividers found)")
            records = parse_value_divider_rows(rows)
            source_label = f"data/source/tiers/{TIERS_CSV.name} (value-divider format)"
        else:
            info("Sheet-format CSV detected (header row parsing)")
            records = map_rows(rows)
            source_label = f"data/source/tiers/{TIERS_CSV.name}"
    else:
        info(f"no {TIERS_CSV.relative_to(REPO_ROOT)} found -- falling back to Google Sheets API")
        cfg = load_cfg()
        rows = fetch_rows(cfg)
        records = map_rows(rows)
        source_label = "Google Sheet"

    info(f"using {len(records)} player rows from {source_label}")

    # Compute positional rank from Sheet order — walks records in tier order
    # then CSV-row order, assigning "<POS><N>" per position. Sheet becomes
    # the sole source of truth for both tier AND positional rank.
    compute_pos_ranks(records)

    html = TIERS_HTML.read_text(encoding="utf-8")
    block = render_block(records, source_label=source_label)
    updated = replace_block(html, block)
    updated = update_synced_stamp(updated)

    html_changed = (updated != html)
    if html_changed:
        # Atomic write
        tmp = TIERS_HTML.with_suffix(".html.tmp")
        tmp.write_text(updated, encoding="utf-8")
        os.replace(tmp, TIERS_HTML)
        info(f"OK -- updated {TIERS_HTML.name}")
    else:
        info(f"no changes to {TIERS_HTML.name} (sheet matched current inline)")

    # Always check data/tiers.json — it can drift independently if added late
    # or if the previous run failed mid-way. write_tiers_json is a no-op
    # when the players dict already matches.
    if write_tiers_json(records):
        info(f"OK -- updated data/{TIERS_JSON.name}")
    else:
        info(f"no changes to data/{TIERS_JSON.name}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
