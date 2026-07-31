@echo off
REM Daily OSCR lead drop -> CRM, in one step.
REM
REM   scripts\IMPORT_OSCR.cmd "C:\path\to\oscr export.xlsx"
REM
REM Converts the raw OSCR export (handling the "Do not call" rows, repeated
REM headers, and month-only birthdays), imports without creating duplicates,
REM then fills in home values and map coordinates.

setlocal
cd /d "%~dp0\.."

if "%~1"=="" (
  echo Usage: scripts\IMPORT_OSCR.cmd "path\to\export.xlsx"
  exit /b 1
)
if "%T65_PASSWORD%"=="" (
  echo Set T65_PASSWORD first:  set T65_PASSWORD=your-password
  exit /b 1
)

echo === 1/4  Cleaning the OSCR export ===
python scripts\oscr_xlsx_to_csv.py "%~1" -o "%TEMP%\oscr_clean.csv" || exit /b 1

echo.
echo === 2/4  Importing (skips anything already in the CRM) ===
node scripts\import-oscr-csv.mjs "%TEMP%\oscr_clean.csv" || exit /b 1

echo.
echo === 3/4  Home values from county parcel data ===
node scripts\enrich-home-value.mjs --limit 1000

echo.
echo === 4/4  Map coordinates for door-knock routing ===
node scripts\geocode-leads.mjs

echo.
echo Done. Open https://ncwealthprotection.me/t65/list/ and the new leads are in the queue.
endlocal
