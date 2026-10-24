"""Inspect every PDF produced by electron-runner.cjs: pages, extracted Arabic text, rendered pixels, embedded images, fonts, SHA-256 - and, on macOS,
how the SYSTEM's own PDF renderer draws each page.
Usage: python analyze.py <outDir> <fixturesDir>      (needs: pip install pymupdf)

File size alone proves nothing, so a PDF is judged on what is actually drawn: text on the page and non-white pixels in a rendering of it.

Native (system viewer) comparison - why: the app opens the saved PDF with the OS viewer (Preview on macOS, i.e. Quartz/PDFKit), and MuPDF can draw
a file that Preview shows blank. On macOS every page is split into a one-page PDF and rendered with `sips -s format png` (Apple's own image tool; it
draws a PDF's first page through the system PDF engine). The command can be replaced with PDFDIAG_NATIVE_CMD, a template using {in} and {out}
(used to test the plumbing off-macOS; such a run proves nothing about the real viewer). If the renderer fails, the error is recorded, never guessed.
"""
import hashlib, json, os, shlex, shutil, subprocess, sys, tempfile, unicodedata, warnings
warnings.filterwarnings("ignore")
try:
    import pymupdf as fitz  # PyMuPDF >= 1.24
except ImportError:
    import fitz

out_dir, fx_dir = sys.argv[1], sys.argv[2]
manifest = {m["name"]: m for m in json.load(open(os.path.join(fx_dir, "manifest.json"), encoding="utf-8"))}
norm = lambda s: unicodedata.normalize("NFKC", s)
png_dir = os.path.join(out_dir, "png"); os.makedirs(png_dir, exist_ok=True)
BLANK_PCT = 0.5

native_tpl = os.environ.get("PDFDIAG_NATIVE_CMD") or ("sips -s format png {in} --out {out}" if sys.platform == "darwin" and shutil.which("sips") else None)
native_label = "custom command (plumbing test only)" if os.environ.get("PDFDIAG_NATIVE_CMD") else ("macOS sips" if native_tpl else None)


def nonwhite_pct(pix):
    px, n = pix.samples, pix.n
    nw = sum(1 for k in range(0, len(px), n) if px[k] < 245 or px[k + 1] < 245 or px[k + 2] < 245)
    return 100.0 * nw / (pix.width * pix.height)


def native_render(doc, index, work):
    """Render one page with the system renderer. Returns (pct | None, error | None)."""
    one = fitz.open(); one.insert_pdf(doc, from_page=index, to_page=index)
    src, dst = os.path.join(work, f"p{index}.pdf"), os.path.join(work, f"p{index}.png")
    one.save(src); one.close()
    cmd = [a.replace("{in}", src).replace("{out}", dst) for a in shlex.split(native_tpl, posix=(os.name != "nt"))]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"
    if r.returncode != 0 or not os.path.exists(dst):
        return None, f"exit {r.returncode}: {(r.stderr or r.stdout).strip()[:200]}"
    try:
        return nonwhite_pct(fitz.Pixmap(dst)), None
    except Exception as e:
        return None, f"cannot read rendered PNG: {e}"


def load_run(ver_dir):
    """Prefer the incremental .jsonl files (they survive an Electron crash); fall back to run.json."""
    def jl(name):
        p = os.path.join(ver_dir, name)
        return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []
    meta = json.load(open(os.path.join(ver_dir, "meta.json"), encoding="utf-8")) if os.path.exists(os.path.join(ver_dir, "meta.json")) else None
    results, events = jl("results.jsonl"), jl("events.jsonl")
    complete = os.path.exists(os.path.join(ver_dir, "run.json"))
    if not results and complete:
        rj = json.load(open(os.path.join(ver_dir, "run.json"), encoding="utf-8")); meta, results, events = rj.get("meta"), rj.get("results", []), rj.get("events", [])
    return {"meta": meta, "results": results, "events": events, "complete": complete}


rows, runs = [], {}
for ver in sorted(d for d in os.listdir(out_dir) if d[:1].isdigit() and os.path.isdir(os.path.join(out_dir, d))):
    runs[ver] = load_run(os.path.join(out_dir, ver))
    for variant in sorted(os.listdir(os.path.join(out_dir, ver))):
        vdir = os.path.join(out_dir, ver, variant)
        if not os.path.isdir(vdir): continue
        for fn in sorted(os.listdir(vdir)):
            if not fn.endswith(".pdf"): continue
            name = fn[:-4]; path = os.path.join(vdir, fn); m = manifest.get(name, {})
            doc = fitz.open(path); pages = []
            fonts, images = set(), 0
            with tempfile.TemporaryDirectory() as work:
                for i, p in enumerate(doc):
                    text = norm(p.get_text())
                    pct = nonwhite_pct(p.get_pixmap(dpi=40))
                    imgs = p.get_images(full=True); images += len(imgs)
                    for f in p.get_fonts(): fonts.add(f[3])
                    page = {"page": i + 1, "w": round(p.rect.width), "h": round(p.rect.height), "chars": len(text.strip()), "nonwhite_pct": round(pct, 2), "images": len(imgs)}
                    if native_tpl:
                        npct, nerr = native_render(doc, i, work)
                        page["native_nonwhite_pct"] = None if npct is None else round(npct, 2)
                        if nerr: page["native_error"] = nerr
                    pages.append(page)
                    if i == 0: p.get_pixmap(dpi=60).save(os.path.join(png_dir, f"{ver}__{variant}__{name}__p1.png"))
            alltext = norm(" ".join(p.get_text() for p in doc))
            words = [w for ph in m.get("expect", []) for w in norm(ph).split() if len(w) > 1]
            found = sorted({w for w in words if w in alltext}); missing = sorted(set(words) - set(found))
            blank_pages = [q["page"] for q in pages if q["chars"] == 0 and q["nonwhite_pct"] < BLANK_PCT]
            if not pages or len(blank_pages) == len(pages): verdict = "BLANK"
            elif pages[0]["chars"] == 0 and pages[0]["nonwhite_pct"] < BLANK_PCT: verdict = "FIRST-PAGE-BLANK"
            elif missing: verdict = "TEXT-MISSING"
            elif blank_pages: verdict = "SOME-BLANK-PAGES"
            else: verdict = "OK"
            exp_land = m.get("landscape")
            if pages and exp_land is not None and (pages[0]["w"] > pages[0]["h"]) != exp_land and verdict == "OK": verdict = "ORIENTATION-MISMATCH"
            # system-viewer comparison (only when a native renderer ran)
            native = "n/a"
            if native_tpl:
                errs = [q["page"] for q in pages if q.get("native_error")]
                diff = [q["page"] for q in pages if q.get("native_nonwhite_pct") is not None and q["nonwhite_pct"] >= BLANK_PCT and q["native_nonwhite_pct"] < BLANK_PCT]
                both = [q["page"] for q in pages if q.get("native_nonwhite_pct") is not None and q["nonwhite_pct"] < BLANK_PCT and q["native_nonwhite_pct"] < BLANK_PCT]
                if errs: native = "NATIVE-ERROR p" + ",".join(map(str, errs))
                elif diff: native = "BLANK-IN-NATIVE-ONLY p" + ",".join(map(str, diff))
                elif both and len(both) == len(pages): native = "BLANK-IN-BOTH"
                else: native = "OK"
            sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
            rows.append({"electron": ver, "variant": variant, "fixture": name, "verdict": verdict, "native_viewer": native, "pages": len(pages), "bytes": os.path.getsize(path),
                         "sha256": sha, "page_size": f'{pages[0]["w"]}x{pages[0]["h"]}' if pages else None, "blank_pages": blank_pages, "images": images,
                         "fonts": sorted(fonts), "words_expected": len(words), "words_found": len(found), "words_missing": missing, "per_page": pages})
            doc.close()

json.dump({"native_renderer": native_label, "runs": {v: r["meta"] for v, r in runs.items()}, "pdfs": rows}, open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
    f.write("# PDF diagnostic report\n\n")
    for v, r in runs.items():
        meta = r.get("meta") or {}
        f.write(f"- Electron {v} (Chromium {meta.get('chrome')}) on {meta.get('platform')}/{meta.get('arch')} {meta.get('osRelease')}"
                f"{'' if r['complete'] else '  **RUN INCOMPLETE - Electron stopped before finishing (partial results kept)**'}\n")
    f.write(f"- System-viewer comparison: {native_label or 'not available (needs macOS sips, or PDFDIAG_NATIVE_CMD)'}\n")
    f.write("\n| Electron | variant | fixture | MuPDF verdict | system viewer | pages | size | blank pages | images | words found |\n|---|---|---|---|---|---|---|---|---|---|\n")
    for r in rows:
        f.write(f"| {r['electron']} | {r['variant']} | {r['fixture']} | **{r['verdict']}** | {r['native_viewer']} | {r['pages']} | {r['page_size']} | {r['blank_pages'] or '-'} | {r['images']} | {r['words_found']}/{r['words_expected']} |\n")
    f.write("\n## SHA-256 of every PDF\n\n")
    for r in rows: f.write(f"- `{r['sha256']}`  {r['electron']}/{r['variant']}/{r['fixture']}.pdf\n")
    f.write("\n## Electron / OS events (load failures, renderer crashes, console errors, failed variants, native print result and printers)\n\n")
    for v, r in runs.items():
        f.write(f"### Electron {v}\n")
        for e in r["events"]: f.write(f"- {json.dumps(e, ensure_ascii=False)}\n")
        for x in r["results"]:
            if x.get("variant") == "print-native" or not x.get("ok") or x.get("fontsReadyError") or x.get("framesWaitError"): f.write(f"- {json.dumps(x, ensure_ascii=False)}\n")
        f.write("\n")
bad = [r for r in rows if r["verdict"] != "OK" or r["native_viewer"] not in ("OK", "n/a")]
print(f"analysed {len(rows)} PDFs: {len(rows) - len(bad)} OK, {len(bad)} not OK  (system viewer: {native_label or 'n/a'})")
for r in bad: print(f"  {r['verdict']} / viewer {r['native_viewer']}: electron {r['electron']} {r['variant']}/{r['fixture']} blank_pages={r['blank_pages']} missing={r['words_missing'][:4]}")
sys.exit(0)  # a bad verdict is DATA for the diagnosis, not a build failure
