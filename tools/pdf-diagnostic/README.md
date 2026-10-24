# pdf-diagnostic

Diagnoses the "blank page" report when CheckIn (Electron) exports PDF or prints on macOS. Diagnostic only: it changes nothing in the app, uses no
database and no ZKTeco device, and builds no installer.

## What it does
1. `build-fixtures.mjs` builds the REAL documents the app sends to `pdf:export` / `print:html`: table reports (`reportTemplate.js`: landscape,
   portrait, empty, mixed Arabic/Latin, with logo/stamp as a `data:` image and as an unreachable URL) and payroll documents (`SalaryCard`,
   `CompactSalarySheet`, wrapped by the real `buildSalaryDoc` sliced out of `FinalSalaryModal.jsx`). Uses the frontend's own esbuild/react.
2. `bundle-security.mjs` bundles the app's real `electron/security.js` into one CommonJS file (same esbuild options as `build-mojave-main.mjs`).
3. `electron-runner.cjs` replays `electron/ipc.js` (`pdf:export`: hidden window -> `loadFile` -> `document.fonts.ready` -> `printToPDF`) and runs
   variants that each change exactly ONE thing versus `asis`:

   | variant | the single difference |
   |---|---|
   | `asis` | none - the app's own sequence (hidden window, default size, temp file) |
   | `visible` | the export window is shown |
   | `nothrottle` | `backgroundThrottling: false` |
   | `dataurl` | loaded from a `data:` URL instead of a temp file |
   | `wait-images` | also waits for every `<img>` to load or fail |
   | `wait-frames` | also waits two animation frames (a hidden window may never produce them; that is recorded) |
   | `wait-300ms` | also waits 300 ms |
   | `with-main-window` | a visible window is open during the export (the packaged app always has one) |
   | `app-guards` | the app's REAL `security.js` guards are installed (runs last; needs the bundle from step 2; `IS_DEV` is true because the harness is not packaged; skipped, never simulated, when the bundle is missing) |

   It also calls `webContents.print` (`print:html`) at a printer name that cannot exist, so nothing is ever printed, and records the failure
   (`errorType`) and the printers the OS reports (name / default / status).
   Results and events are appended to `results.jsonl` / `events.jsonl` as they happen, so an Electron crash loses nothing already measured.
4. `analyze.py` (PyMuPDF) judges each PDF by what is drawn: pages and size, extracted Arabic words, non-white pixels per page, images, fonts,
   SHA-256, and writes `report.md` / `report.json` plus a PNG of page 1.
   **System viewer comparison (macOS only):** each page is split into a one-page PDF and redrawn with `sips -s format png` (Apple's own tool, drawing
   through the system PDF engine that Preview uses). The report then shows `OK`, `BLANK-IN-NATIVE-ONLY` (MuPDF draws content, the system engine does
   not), `BLANK-IN-BOTH`, or `NATIVE-ERROR` (the failure text is kept). `PDFDIAG_NATIVE_CMD` can replace the command (`{in}`, `{out}`); that is only for
   testing the plumbing off-macOS and the report labels such a run as such.

MuPDF verdicts: `OK`, `BLANK`, `FIRST-PAGE-BLANK`, `SOME-BLANK-PAGES`, `TEXT-MISSING`, `ORIENTATION-MISMATCH`. A bad verdict is data, not a failure.

## Run locally (Windows or macOS)
    cd frontend && npm ci            # once
    pip install pymupdf
    node tools/pdf-diagnostic/run-local.mjs --electron <path to an Electron binary> --out <empty folder> [--variants asis,visible] [--logging]

`PDFDIAG_SELFTEST_CRASH_AFTER=N` makes the runner kill itself after N results (to check that partial results survive).

## macOS CI
`.github/workflows/diagnose-mac-pdf.yml` (manual, `contents: read`) runs this on Electron 32.3.3 and 26.6.10 and uploads PDFs, PNGs, reports, Electron
logs, the macOS system log and the printer list as Artifacts kept 14 days. No Release is created.

## Limits (read before concluding anything)
- A Windows run (Electron 30.5.1) shows the HTML and the app's PDF flow are sound there. It does not decide the macOS cause.
- The macOS CI runner is macOS 15 on Intel. It does NOT prove behaviour on macOS 10.13 / 10.14, the native print dialog (no printer, nobody to
  click), or the installed unsigned CheckIn Mac.app. Real tests on the iMacs are still required.
- The `sips` comparison has not been run on a Mac yet: only its plumbing (OK / blank / error handling) was exercised, with stand-in commands.
