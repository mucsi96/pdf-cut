# pdf-cut

Restore a 2-up scanned book PDF into print-quality, single-page PDFs.

A Node.js CLI (packaged in Docker, designed for **WSL + podman**) that takes a book
scanned two-pages-per-sheet at 600 DPI and produces:

- `output/book.pdf` — one book page per PDF page, deskewed, cleaned of scanner
  residue, punch holes repaired with AI inpainting (LaMa), crisp anti-aliased
  text with grayscale illustrations preserved.
- `output/cover.pdf` — the wrap-around cover (back + spine + front) recreated
  **in color** by Gemini (`gemini-3-pro-image-preview`) as a single landscape page.

## Pipeline

| # | stage | what it does | key debug artifacts (`work/<dir>/debug/`) |
|---|-------|--------------|--------------------------------------------|
| 10 | `extract` | pulls the **raw embedded scan bitmaps** out of the PDF with `pdfimages` (no resampling — true baseline); falls back to `pdftoppm` rendering | `pdfimages-list.txt`, contact sheet |
| 20 | `cover` | sends the cover scan to Gemini, gets a 4K color recreation, Lanczos-upscales to print size; supports multiple variants | prompt, raw variants, response metadata |
| 30 | `split` | cuts each landscape spread into left + right page | scan with the cut line drawn in red |
| 40 | `deskew` | projection-profile angle estimation (±0.05°), single full-res cubic rotation | `angles.json`, page with reference grid |
| 50 | `clean` | illumination flatten (kills gutter shadow), border/edge residue removal, margin despeckle, **smart binarization**: soft-Sauvola text (pure black/white with anti-aliased glyph edges) + detected illustration regions kept as untouched grayscale | before/after, background estimate, blue illustration-region overlay, red changed-pixel mask |
| 60 | `detect-holes` | finds black punch holes near the gutter (size/circularity filters), emits inpainting masks; runs on the *deskewed* pages so cleaning can't destroy the evidence | overlay with accepted (red) and rejected (yellow + reason) candidates |
| 70 | `inpaint` | LaMa (via iopaint, CPU) on 768 px patches around each hole — one batch call, results pasted back | patch before/after pairs, page with patch boxes |
| 80 | `report` | static **HTML report**: every stage for every page side by side | `work/report.html` |
| 90 | `assemble` | `img2pdf` → `output/book.pdf` + `output/cover.pdf`; physical size comes from the 600 DPI PNG metadata | `pdfinfo` summary in the log |

Every stage writes its results to its own `work/NN-stage/` directory and only
reads the previous stage's directory, so **any stage can be re-run and tuned in
isolation**.

## Quick start (WSL + podman)

```bash
podman build -t pdf-cut .

cp .env.example .env            # put your GEMINI_API_KEY in .env (cover stage only)
cp your-scan.pdf input/book.pdf

# test on the first 3 scan pages (page 1 = cover):
podman run --rm --userns=keep-id -v "$PWD:/data:Z" --env-file .env \
  pdf-cut run --input input/book.pdf --pages 1-3

# inspect the result:
xdg-open work/report.html       # or the "pdfcut: open HTML report" VS Code task

# full book:
podman run --rm --userns=keep-id -v "$PWD:/data:Z" --env-file .env pdf-cut run
```

No Gemini key? Use `--skip-cover`, or `--set cover.dryRun=true` to just inspect
the request that would be sent.

### VS Code tasks (Terminal → Run Task…)

- **pdfcut: build image**
- **pdfcut: run on test pages** — prompts for a page range (default `1-3`)
- **pdfcut: run single stage (dev mounts, force)** — re-runs one stage with
  `src/` and `scripts/` mounted from the workspace, so code edits apply
  without rebuilding the image
- **pdfcut: run from stage onward (dev mounts, force)** — re-cascade after tuning
- **pdfcut: open HTML report**
- **pdfcut: clean work dir**
- **pdfcut: create synthetic test PDF** — writes `input/test.pdf` with all the
  defects (2-up, rotation, residue, punch holes) for end-to-end testing

## Tuning a stage

All parameters live in `pdfcut.config.json` (see `src/config.js` for every
knob and its default). Typical loop:

```bash
# 1. look at work/report.html, find the page where e.g. cleaning is too aggressive
# 2. tweak and re-run JUST that stage:
podman run --rm --userns=keep-id -v "$PWD:/data:Z" pdf-cut \
  run --stages clean --force --set clean.picDensity=0.3 --set clean.edgeSoftness=14
# 3. happy? re-cascade the rest:
podman run --rm --userns=keep-id -v "$PWD:/data:Z" pdf-cut run --from detect-holes --force
```

Useful per-page overrides:

- `split.overrides` — gutter drift: `{ "0012": 0.515 }` (cut ratio per scan)
- `deskew.overrides` — fixed angle for illustration-only pages: `{ "0017": -0.4 }`
- `cover.selectedVariant` + `--cover-variants 4` — generate several covers, pick one

## CLI reference

```
pdfcut run [--input <pdf>] [--pages 1-3,7] [--stages a,b | --from s --to s]
           [--set stage.key=value]... [--force] [--skip-cover] [--cover-variants n]
pdfcut report          # regenerate work/report.html
pdfcut stages          # list stages
pdfcut clean-work [--from <stage>]
```

### Input variants

- **2-up spreads** (default): page 1 is the wrap-around cover, every other PDF
  page holds two book pages and gets split.
- **Already-single pages** (portrait scans): detected automatically and passed
  through unsplit. If there is no cover scan, run with
  `--set cover.scanPage=0 --set split.firstBookPage=1`.
- `extract.dpi` must be the **true** resolution of the scans — all physical
  (mm-based) parameters and the output page size derive from it. Stale ppi
  tags inside the PDF are ignored (a warning is printed when they disagree).

### How punch holes are found

A punch machine hits the same spot on every page, so detection clusters
hole-shaped blobs **across pages** (separately for left/right pages): positions
confirmed on enough pages (`detect.clusterMinFrac`) are repaired on *every*
page — even where the hole overlaps artwork or text and is undetectable on
that page alone. The overlay debug shows search regions (green), the voted
punch positions (magenta), per-page candidates (yellow) and applied holes
(red, labeled `detected` or `cluster`).

Notes:

- `--pages` selects **PDF scan pages** (each may hold two book pages). Book
  page numbers stay stable across partial runs.
- Changing `--pages` or any stage parameter invalidates the stage automatically
  (hash check); unchanged stages are skipped unless `--force`.
- The final PDFs inherit physical size from the scan DPI (pixels ÷ 600 = inches).
