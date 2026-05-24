# FPTS Tiers (Standalone)

A single-page tier viewer forked off the Fantasy Points Front Office multi-page
project at `C:\Users\deons\Desktop\05_11_26 dynasty Tool\FPTS-Trade_Database`.
Deployable to GitHub Pages from `main` as a static site (entry: `index.html`).

## Scope

- One page: `index.html` (was `tiers.html` in the parent project).
- Renders the dynasty tier board with **sort + dropdowns**: column header sort
  in flat view, Position filter, Tier filter, Grouped/Sortable view toggle.
- Keeps the **"Previous ADP" calendar popup** (month-to-month ADP compare).
- Keeps the **Admin Scratchpad** (URL flags `?admin=hash`, `?admin=1`,
  `?admin=0`; password gate; tier/B-S-H/priority/contender/trending edits;
  drag-and-drop player + tier reorder; GitHub Publish via Contents API).
- FPTS branding kept (logo, fonts, color palette).

## Stripped from the parent

- Player drawer (`player-panel.js` + `player-panel.css`) and the inline modal
  fallback. Clicking a player name does nothing.
- Legend drawer (`legend.js` + `legend.css` + `legend-content.js`).
- Back-to-top floating button.
- Cross-page handoff helpers (Open in Database / Calculator / ADP / My Leagues).
- MVS recent-trades, ADP heatmap, and player articles modules — all only fed
  the drawer, so they were dropped along with `data/mvs.json`,
  `data/articles.json`, `data/pick-availability.json`, and `data/stats.json`.

## Run it locally

```
start.bat
```

Serves the folder on `http://localhost:8000/`.

## Refresh data

```
push.bat
```

Steps:

1. `git pull --rebase` (integrates admin Publish commits from the live site)
2. `scripts/sync-adp.py` — rebuilds `data/adp.json` and `data/adp-YYYY.json`
3. `scripts/sync-fp.py` — rebuilds `data/values.json`, `picks.json`,
   `auction.json`, `rank-history.json`
4. `scripts/sync-tiers.py` — rewrites the `TIER_PLAYERS` block inside
   `index.html` from `data/source/tiers/tiers.csv`
5. `scripts/check-colors.py` — brand audit; aborts on drift
6. `git add -A && git commit && git push`

The three `sync-*.py` scripts need matching `sync-*.config.json` files at the
project root (these are gitignored — copy/recreate from the parent project).

## Admin Scratchpad setup

The admin features are intact but the standalone ships with **no default
GitHub repo configured** (so a stray Publish click can't write to the parent
project). First-run setup:

1. Visit `index.html?admin=hash` once. Enter a new password when prompted.
   Copy the printed SHA-256 hash and paste it into the `PASSWORD_HASH`
   constant inside `assets/js/admin-tiers.js`. Commit that change.
2. Visit `index.html?admin=1`. Enter the password. Admin chrome activates.
3. Click ⚙ **Settings**. Fill in:
   - GitHub PAT (fine-grained, Contents: Read & write on the new repo only)
   - Repo (`owner/name`)
   - Branch (default `main`)
   - Path (default `data/source/tiers/tiers.csv` is correct for this layout)
4. Make a tier edit, click **Publish ⬆**, confirm the diff preview, commit.
5. `?admin=0` disables admin mode on this browser.

## Caveats

- `adp-comparator.js` lazy-fetches `data/adp-{year}.json` only when the user
  picks a prior-year month from the calendar. Without those files present
  for older years, those months silently no-op.
- Without MVS data the player **value** is not displayed in the table (the
  parent project's `.value` column was MVS-driven). The table still shows
  Tier, Player, Age, Pos, PRK, Team, ADP, Previous ADP, Chg, Auction, PPG,
  Buy/Sell, Priority, Contender.
- This standalone has its own GitHub repo + Pages deploy. Do not point the
  admin scratchpad at the parent project's repo.
