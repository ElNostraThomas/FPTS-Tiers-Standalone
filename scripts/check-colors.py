#!/usr/bin/env python3
"""
check-colors.py -- exhaustive brand-color audit for the FPTS Trade Database.

Walks every .html / .css / .js file in the repo and reports any color value
that drifts from the canonical brand palette documented in assets/css/brand.css
(the COLOR USAGE RULE comment block).

What it catches
---------------
- Hex hardcodes in CSS property values that don't match a known brand color
- Hex hardcodes in JS color strings (e.g. el.style.color = '#xxx')
- rgba() / rgb() values that aren't either (a) brand RGB at any opacity, or
  (b) a legitimate non-chromatic shadow / overlay / neutral

What it intentionally ignores
-----------------------------
- :root and [data-theme="light"] variable DECLARATIONS — those define the
  palette; the audit only checks USAGE
- SVG path fill attributes (the wordmark uses var(--red) already)
- rgba(0,0,0,X) — black for shadows / dark overlays (non-chromatic depth)
- rgba(255,255,255,X) — white for subtle highlights / disabled states
- rgba(128,128,128,X) — neutral gray fallback for missing-data states
- rgba(BRAND-RGB, X) at any opacity — brand colors used as tints
- #888 / #555 / #444 / #333 — IDP-position fallback + tier-D/E/F intentional
  diminishing-value grayscale

Run it
------
    python scripts/check-colors.py

Exit codes:
    0 = clean (no drift found)
    1 = drift found (script prints the offending file:line + suggested fix)

Recommended pre-push workflow: run before every `push.bat` so any new color
drift is caught before it ships.

When adding a new brand color: extend BRAND_HEXES below + document the
new variable in brand.css's COLOR USAGE RULE block.

When adding a new "legitimate non-chromatic rgba" pattern: extend
is_legitimate_rgba().
"""

import os
import re
import sys
from collections import defaultdict

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ──────────────────────────────────────────────────────────────────────────
# Brand palette — every hex in this set is considered "on-brand".
# Authoritative source: assets/css/brand.css's :root + [data-theme=light]
# blocks. Keep this in sync when brand.css adds a new var.
# ──────────────────────────────────────────────────────────────────────────
BRAND_HEXES = {
    # Primary brand + secondary green
    '#ed810c',          # var(--red) dynasty orange
    '#4caf6e',          # var(--green) brand green
    '#66dd84',          # .trend.up foreground exception
    '#f0c040',          # var(--yellow)
    # Position pills (dark theme)
    '#e05252',          # var(--pos-qb-bg)
    '#5b9bd5',          # var(--pos-wr-bg)
    '#e09a30',          # var(--pos-te-bg)
    '#9b91d4',          # var(--pos-k-bg) / --pos-pick-bg
    '#e8732a',          # tiers --orange (kept variant for shopping/hold)
    # Surfaces / borders (dark theme)
    '#111111', '#1a1a1a', '#222222', '#2a2a2a', '#333333', '#ffffff',
    # Position pills (light theme)
    '#b02020', '#1a7a3a', '#2a6fa8', '#c97a1a', '#5a4eaa',
    # Surfaces (light theme)
    '#f0f0f0', '#e8e8e8', '#dedede', '#cccccc', '#bbbbbb',
    # Grayscale spectrum (tier-D/E/F intentional, IDP fallback, etc.)
    '#555555', '#444444', '#888',
    # 3-char canonical forms
    '#fff', '#000', '#111', '#ccc', '#bbb', '#555', '#444', '#333',
}

# rgba(R,G,B,*) patterns that are legitimate non-drift.
# RGB triples here are: brand colors as rgba tints + the standard
# non-chromatic depth/highlight pairings + neutral gray fallback.
LEGIT_RGBA_RGB = {
    # Brand colors (any opacity = legitimate tint)
    (237, 129, 12),    # --red
    (76, 175, 110),    # --green
    (102, 221, 132),   # #66dd84 trend-up (rgba form, in case)
    (240, 192, 64),    # --yellow
    (232, 115, 42),    # --orange (tiers-specific buy/sell variant)
    (224, 82, 82),     # --pos-qb-bg
    (91, 155, 213),    # --pos-wr-bg
    (224, 154, 48),    # --pos-te-bg
    (155, 145, 212),   # --pos-k-bg / --pos-pick-bg
    # Non-chromatic depth
    (0, 0, 0),         # shadows / overlays
    (17, 17, 17),      # --white in light theme + muted text on bright fills (post-doctrine-inversion)
    (255, 255, 255),   # subtle highlights / outline / disabled fade
    (128, 128, 128),   # neutral fallback gray
}


def normalize_hex(h):
    """Expand 3-char hex (#abc) to 6-char (#aabbcc) for consistent compare."""
    h = h.lower()
    if len(h) == 4 and h[0] == '#':
        h = '#' + h[1] * 2 + h[2] * 2 + h[3] * 2
    return h


BRAND_NORM = set(normalize_hex(h) for h in BRAND_HEXES if h.startswith('#'))

SKIP_DIRS = {'.git', 'data', 'docs', 'node_modules', 'fonts', 'scripts'}

HEX_PAT  = re.compile(r'#[0-9a-fA-F]{3,8}\b')
RGBA_PAT = re.compile(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[0-9.]+)?\s*\)')

# ──────────────────────────────────────────────────────────────────────────
# Branding hard-rule patterns (see brand.css "THE BRANDING HARD RULES" + CLAUDE.md).
# These extend the basic hex-drift audit with two compounding-bug checks.
# ──────────────────────────────────────────────────────────────────────────

# A CSS rule has a "bright fill" if its body contains a background using one
# of these tokens or literal brand hexes.
BRIGHT_BG_PATTERNS = [
    'var(--red)', 'var(--green)', 'var(--yellow)', 'var(--orange)',
    'var(--pos-qb-bg)', 'var(--pos-rb-bg)', 'var(--pos-wr-bg)',
    'var(--pos-te-bg)', 'var(--pos-k-bg)', 'var(--pos-pick-bg)',
    '#ed810c', '#4caf6e', '#f0c040', '#e8732a',
    '#e05252', '#5b9bd5', '#e09a30', '#9b91d4',
]

# Selector substrings that mark a rule as targeting a pill / badge / chip /
# active button — the compounding-bug risk class. opacity: < 1 on these
# dims any nested colored content.
PILL_CONTAINER_HINTS = (
    'pill', 'badge', 'chip', 'tier-bsh', 'mvs-vol-',
    '.active', '.up', '.down',
)

# Matches "selector { body }" — non-greedy, no nested braces.
RULE_BLOCK_PAT = re.compile(r'([^{}\n][^{}]*?)\{([^{}]*?)\}', re.MULTILINE)

# Matches opacity: 0.X or opacity: .X (less than 1).
OPACITY_PAT = re.compile(r'opacity:\s*0?\.\d+')

# State-transitions + intentionally-muted variant markers. Matches either
# `.X` (standalone class) or `-X` (suffix), so `.mvs-vol-cold` triggers via
# `-cold` and `.empty` triggers as itself. Also catches pseudo-classes.
SKIP_MARKER_PAT = re.compile(
    r':hover|:focus|:disabled|@keyframes'
    r'|[.-](?:disabled|dim|empty|cold|cool|muted|na|placeholder|archived)\b'
)


def find_brand_rule_violations(content):
    """Walk CSS rule blocks and report:
       - opacity: < 1 on a pill/badge/active-button container that also has a
         bright-color background (the actual compounding hazard).

    NOTE: The previous "dim-text-on-bright-bg" pattern (which flagged
    color: #111 on bright fills as drift against the "white on bright"
    doctrine) was REMOVED on 2026-05-20 when the doctrine inverted to
    "BLACK text on every bright fill". The new rule is documented in
    brand.css + CLAUDE.md but not lint-enforced — adding a "white on bright"
    detector would be straightforward if regression-prevention becomes
    needed.

    Heuristic refinements to avoid false positives on the opacity check:
      - Only fires when the LAST simple selector matches a pill hint (so
        `.X .label` doesn't flag — `.label` is a leaf child of `.X`) AND
        the rule body has a literal bright bg (surface / transparent /
        border-only chips don't compound dangerously).
      - Selectors with intentional-muted suffixes (`.cold`, `.dim`, `.empty`,
        `.na`, `.muted`) are skipped — the class name itself signals
        intentional fade.

    Returns list of (line_no, kind, value, line_text) hits."""
    hits = []
    for m in RULE_BLOCK_PAT.finditer(content):
        selector = m.group(1).strip()
        body = m.group(2)
        line_no = content[:m.start()].count('\n') + 1
        body_lower = body.lower()
        sel_lower = selector.lower()

        has_bright_bg = any(p in body_lower for p in BRIGHT_BG_PATTERNS)

        # opacity: < 1 on a pill/badge/active-button container WITH a
        # bright-fill background in the same rule.
        # Skip state transitions and intentionally-muted variants.
        if SKIP_MARKER_PAT.search(sel_lower):
            continue
        # Get the LAST simple-selector segment (after the last whitespace /
        # combinator). Only flag if THAT segment matches a pill hint.
        last_segment = re.split(r'[\s>+~]', sel_lower)[-1] if sel_lower else ''
        last_is_pill = any(h in last_segment for h in PILL_CONTAINER_HINTS)
        if last_is_pill and has_bright_bg:
            op_match = OPACITY_PAT.search(body)
            if op_match:
                hits.append((
                    line_no, 'opacity-on-pill-with-bright-bg', op_match.group(),
                    f'{selector[:60]} bright bg + {op_match.group()}'
                ))

    return hits


def find_files(root):
    """Yield every .html / .css / .js file under root, skipping SKIP_DIRS."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(('.html', '.css', '.js')):
                yield os.path.join(dirpath, fn)


def find_var_decl_lines(content):
    """Return set of line numbers that fall inside :root or [data-theme=light]
    blocks. We skip those — the audit checks USES of color, not the canonical
    declarations themselves."""
    inside = set()
    in_block = False
    depth = 0
    for i, line in enumerate(content.splitlines(), 1):
        if not in_block and (':root' in line or '[data-theme=' in line):
            in_block = True
            depth = line.count('{') - line.count('}')
            inside.add(i)
            continue
        if in_block:
            inside.add(i)
            depth += line.count('{') - line.count('}')
            if depth <= 0:
                in_block = False
    return inside


def is_svg_attribute(line):
    """SVG path/circle/etc. fill="" attributes (e.g. the wordmark) are not
    CSS color values — skip them."""
    return ('fill="' in line and ('viewBox' in line or 'svg' in line.lower())) \
        or 'xmlns=' in line


def is_legitimate_rgba(r, g, b):
    """True if this RGB triple is on the brand-rgba whitelist."""
    return (r, g, b) in LEGIT_RGBA_RGB


def audit(verbose=False):
    """Run the audit. Returns (drift_count, drift_dict) where drift_dict maps
    file_path -> [(line_no, kind, value, line_text), ...]."""
    drift = defaultdict(list)
    file_count = 0

    for path in find_files(REPO_ROOT):
        file_count += 1
        try:
            with open(path, encoding='utf-8', errors='ignore') as fh:
                content = fh.read()
        except OSError:
            continue

        var_lines = find_var_decl_lines(content)

        for line_no, line in enumerate(content.splitlines(), 1):
            if line_no in var_lines:
                continue
            if is_svg_attribute(line):
                continue

            # Check hex literals
            for m in HEX_PAT.finditer(line):
                hex_val = m.group(0)
                if len(hex_val) not in (4, 7):
                    continue  # skip 5-char and 8-char (alpha) forms
                if normalize_hex(hex_val) in BRAND_NORM:
                    continue
                drift[path].append((line_no, 'hex', hex_val.lower(), line.strip()[:140]))

            # Check rgba/rgb literals
            for m in RGBA_PAT.finditer(line):
                r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if is_legitimate_rgba(r, g, b):
                    continue
                drift[path].append((line_no, 'rgba', m.group(0), line.strip()[:140]))

        # Branding-rule checks (operates on full CSS rule blocks, not per-line).
        for hit in find_brand_rule_violations(content):
            drift[path].append(hit)

    return file_count, drift


def main():
    verbose = '--verbose' in sys.argv or '-v' in sys.argv
    file_count, drift = audit(verbose=verbose)

    if not drift:
        print('[check-colors] CLEAN -- zero off-brand color drift across',
              file_count, 'files.')
        return 0

    print('=' * 72)
    print('[check-colors] DRIFT FOUND')
    print('=' * 72)
    total = 0
    for path in sorted(drift):
        hits = drift[path]
        total += len(hits)
        rel = os.path.relpath(path, REPO_ROOT)
        print(f'\n{rel}  ({len(hits)} hit{"s" if len(hits) != 1 else ""})')
        # Group by value for compact output
        by_val = defaultdict(list)
        for line_no, kind, val, line in hits:
            by_val[val].append((line_no, line))
        for val, instances in sorted(by_val.items(), key=lambda x: -len(x[1])):
            print(f'  {val}  ({len(instances)}x)')
            for line_no, line in instances[:3]:
                print(f'    L{line_no}: {line[:100]}')
            if len(instances) > 3:
                print(f'    ... +{len(instances) - 3} more')

    print()
    print(f'TOTAL: {total} drift hit{"s" if total != 1 else ""} '
          f'across {len(drift)} file{"s" if len(drift) != 1 else ""}')
    print()
    print('Fix path: map each off-brand color to a brand var (see brand.css')
    print('COLOR USAGE RULE for the canonical palette). Re-run this script')
    print('to verify zero drift before committing.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
