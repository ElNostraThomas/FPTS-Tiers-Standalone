# CLAUDE.md — standalone tiers project conventions

Forked from `FPTS-Trade_Database`. Same branding doctrine, slimmer surface.

## Branding hard rule (inherited from parent)

1. **BLACK text (`#111111`) on every bright-colored fill.** Position pills,
   tier badges, heat tints, `*.active` button states, `.hm-flash-label`,
   every place a bright brand color is a `background`. The text inside is
   `#111111` (or the `var(--pos-*)` tokens, which now resolve to `#111111`).
   The one exception: bg is white/muted/surface — then theme-aware
   `var(--white)` text is correct.
2. **Never use `opacity:` on a parent that contains a colored child.**
   CSS opacity compounds down and can't be overridden by `opacity:1` on the
   child. Use `color: rgba(17,17,17,X)` on bright fills or
   `rgba(255,255,255,X)` on dark surfaces.
3. **Brand tokens are the source of truth in `assets/css/brand.css`.** Never
   hardcode `color: var(--white)` on a bright fill — use `#111111` literal.
4. **`python scripts/check-colors.py` must print CLEAN after any change.**
   Wired into `push.bat` as a hard gate.

Recipes (tables / pills / button-active states / muted text) — same as the
parent's `CLAUDE.md`. Always reach for an existing pattern before inventing.

## Cache bump

Any change to `assets/css/brand.css` or a shared JS module in `assets/js/`
requires bumping `?v=...` on the corresponding `<link>` / `<script>` tag in
`index.html`. Browsers cache hard.

## Files in scope

- `index.html` — the only HTML page. Inline `<style>` + inline `<script>`
  carry the tier-render logic + sort + filter dropdowns.
- `assets/css/brand.css` — palette, typography, position pills, tier badges,
  topnav base, etc. Source of truth for `.pos-*` and tier-badge colors.
- `assets/js/admin-tiers.js` — the admin scratchpad (kept fully intact).
- `assets/js/adp-comparator.js` — the Previous-ADP calendar popup.
- `assets/js/data-bootstrap.js` — trimmed to fetch only values/adp/auction/picks.
- `assets/js/custom-select.js`, `iframe-scroll-fix.js`, `obs-zoom-controls.js`,
  `team-helpers.js`, `sleeper-helpers.js` — utility modules.

## Sync scripts

All under `scripts/`. Each computes `REPO_ROOT = Path(__file__).resolve()
.parent.parent` because they sit one level deeper than in the parent project.

- `scripts/sync-fp.py` — FP API → `data/values.json` + `picks.json` +
  `auction.json` + `rank-history.json`. Needs `sync-fp.config.json` at root.
- `scripts/sync-adp.py` — sleeper_dynasty_adp parquets → `data/adp.json` +
  `data/adp-YYYY.json`. Needs `sync-adp.config.json` at root.
- `scripts/sync-tiers.py` — `data/source/tiers/tiers.csv` (or the Google
  Sheet via `sync-tiers.config.json`) → `TIER_PLAYERS` block inside
  `index.html`. Targets `REPO_ROOT / "index.html"` (was `tiers.html` in parent).
- `scripts/check-colors.py` — brand audit. Walks `REPO_ROOT` recursively,
  skips `data/`, `docs/`, `node_modules/`, `fonts/`, `scripts/`.

## Admin Scratchpad notes

- `DEFAULT_GH_REPO` is intentionally **empty** (top of `admin-tiers.js`) so
  Publish can't accidentally write to the parent project's repo.
- `PASSWORD_HASH` starts empty too — operator must set via `?admin=hash` flow
  and commit the resulting hash before admin mode can activate.
- The admin's `.lg-trigger` / Formulas-link visibility-gating from the parent
  was removed because both targets no longer exist in this standalone.
