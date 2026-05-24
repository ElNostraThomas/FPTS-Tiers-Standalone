@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===============================================================
echo   FPTS TIERS STANDALONE -- DEPLOY
echo ===============================================================
echo.

REM ── [0/5] Sync local with remote (pulls in admin-Publish commits) ──
REM The admin scratchpad's "Publish" button commits to GitHub via the Contents
REM API, so origin can be ahead of local. Pull-rebase first to avoid a
REM "fetch first" rejection in step [5/5].
echo [0/5] Syncing local with remote...
git pull --rebase origin main 2>nul
echo.

REM ── [1/5] Sync dynasty ADP (writes data\adp.json + adp-YYYY.json) ──
if exist "scripts\sync-adp.py" if exist "sync-adp.config.json" (
  echo [1/5] Syncing dynasty ADP...
  python "%~dp0scripts\sync-adp.py"
  if errorlevel 1 (
    echo.
    echo ADP sync failed - aborting before commit.
    pause
    exit /b 1
  )
  echo.
) else (
  echo [1/5] ADP sync skipped ^(scripts\sync-adp.py or sync-adp.config.json missing^).
  echo.
)

REM ── [2/5] Sync Fantasy Points API data (writes data\values.json etc) ──
if exist "scripts\sync-fp.py" if exist "sync-fp.config.json" (
  echo [2/5] Syncing FP API data...
  python "%~dp0scripts\sync-fp.py"
  if errorlevel 1 (
    echo.
    echo FP sync failed - aborting before commit.
    pause
    exit /b 1
  )
  echo.
) else (
  echo [2/5] FP sync skipped ^(scripts\sync-fp.py or sync-fp.config.json missing^).
  echo.
)

REM ── [3/5] Sync tier rankings into index.html ──
if exist "scripts\sync-tiers.py" if exist "sync-tiers.config.json" (
  echo [3/5] Syncing tier rankings...
  python "%~dp0scripts\sync-tiers.py"
  if errorlevel 1 (
    echo.
    echo Tiers sync failed - aborting before commit.
    pause
    exit /b 1
  )
  echo.
) else (
  echo [3/5] Tiers sync skipped ^(scripts\sync-tiers.py or sync-tiers.config.json missing^).
  echo.
)

REM ── [4/5] Brand-color audit (hard gate) ──
echo [4/5] Running brand-audit...
python "%~dp0scripts\check-colors.py"
if errorlevel 1 (
  echo.
  echo BRAND AUDIT FAILED - fix the drift above and rerun push.bat.
  pause
  exit /b 1
)
echo.

REM ── [5/5] Commit + push ──
echo [5/5] Checking for changes to commit...
echo.

set "has_changes="
for /f "delims=" %%A in ('git status --porcelain') do set "has_changes=1"

if not defined has_changes (
  echo No changes to commit. Site is already up to date.
  pause
  exit /b 0
)

echo Pending changes:
git status --short
echo.

set "default_msg=Update site + refresh data"
set /p msg="Commit message (Enter for ^"!default_msg!^"): "
if "!msg!"=="" set "msg=!default_msg!"

git add -A
git commit -m "!msg!"
if errorlevel 1 (
  echo.
  echo Commit failed - nothing was pushed.
  pause
  exit /b 1
)

git push origin main
if errorlevel 1 (
  echo.
  echo Push failed.
  pause
  exit /b 1
)

echo.
echo ===============================================================
echo   DEPLOY COMPLETE -- GitHub Pages redeploys in ~2 minutes
echo ===============================================================
pause
