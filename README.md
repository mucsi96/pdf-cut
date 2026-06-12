# pdf-cut

Restore a 2-up scanned book PDF into print-quality, single-page PDFs.

A Node.js CLI (packaged in Docker, designed for **WSL + podman**) that takes a book
scanned two-pages-per-sheet at 600 DPI and produces:

- `output/book.pdf` — one book page per PDF page, deskewed, cleaned of scanner
  residue, punch holes repaired with AI inpainting (LaMa), crisp anti-aliased
  text with grayscale illustrations preserved.
- `output/cover.pdf` — the wrap-around cover (back + spine + front) recreated
  **in color** by Gemini (`gemini-3-pro-image`, Nano Banana Pro) as a single landscape page.
- `output/book.md` + `output/images/` — *(opt-in)* the book body transcribed to
  Markdown by Gemini vision: German text with hyphenation repaired, BASIC
  listings as fenced code blocks, every figure recreated **in color** and
  straightened by the image model (raw scan crops kept in debug/); front
  matter, TOC, page numbers and running heads dropped.
- `output/book-print.pdf` — *(opt-in)* the Markdown typeset back into a print
  book with WeasyPrint: original trim size, fonts matching the original
  (Times/Helvetica/Courier-era TeX Gyre clones), generated table of contents
  with page numbers, every chapter on a new page, running heads + footer page
  numbers, German hyphenation, and the color figures placed at their size in
  the original book.

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
| 95 | `markdown` | **opt-in** (one Gemini call per page, never part of a default run): transcribes each cleaned page to GitHub-flavored Markdown — body text only (page numbers / running heads / front matter dropped), BASIC listings as ` ```basic ` fences, figures cropped from the full-res scan and recreated in color (`gemini-3-pro-image`) into `output/images/`, paragraphs/listings/tables stitched across page breaks → `output/book.md` | per-page raw model output + token usage, raw scan crops of the figures, `prompt.txt` |
| 97 | `render` | **opt-in**: typesets `output/book.md` into `output/book-print.pdf` with WeasyPrint — TOC with leader dots + live page numbers followed by a blank page, chapters on new pages, mirrored book margins with running head and page number, justified text with German hyphenation, figures at their original printed size | `book.html` (the exact typeset document), `weasyprint.log` |

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

### Markdown conversion (after the pipeline has run)

```bash
# whole book; the model skips front matter / TOC pages on its own:
podman run --rm --userns=keep-id -v "$PWD:/data:Z" --env-file .env pdf-cut markdown

# or pin the body explicitly by book page number (cheaper, deterministic):
podman run --rm --userns=keep-id -v "$PWD:/data:Z" --env-file .env \
  pdf-cut markdown --body-pages 12-181
```

Writes `output/book.md` and `output/images/`. Every figure is recreated in
color (and straightened) by `markdown.figureModel`; the raw scan crops stay in
`work/95-markdown/debug/…-scan.png` for comparison, and
`--set markdown.figureRecreate=false` keeps the raw crops instead.

Per-page transcriptions are cached in `work/95-markdown/` — an interrupted run
resumes where it stopped, and a page is only re-sent to Gemini when its `.md`
is missing or a parameter that affects it changed (figure-parameter changes
redo only the figures, reusing the cached text); `--force` redoes everything.
Spot-check `work/95-markdown/page-NNNN.md` against `work/report.html`; to redo
a single page, delete its `.md` file and re-run — same for a single figure in
`work/95-markdown/images/`. The default text model is `gemini-3.1-pro-preview`
(best on the BASIC listings); switch with
`--set markdown.model=gemini-3.5-flash` to convert cheaper.

### Print rendering (after the markdown conversion)

```bash
podman run --rm --userns=keep-id -v "$PWD:/data:Z" pdf-cut render
```

Typesets `output/book.md` + `output/images/` into `output/book-print.pdf` (no
Gemini key needed). The page size is measured from the cleaned scans, so the
book keeps its original trim size; figures are placed at the size they had in
the original book (measured from the scan crops in `work/95-markdown/debug/`),
capped at the text column.

The typography is tuned for a young reader with the right 80s flavor:
**URW Bookman** (the ITC Bookman clone — the warm, wide face all over 1980s
computer books) for body text at a child-friendly 12.5 pt, and the **genuine
Sinclair ZX Spectrum character set** (public-domain TTF, full German umlaut
coverage) for headings and BASIC listings — at the default sizes a listing
line fits ~32 characters, the Spectrum's actual screen width. URW Gothic
(Avant Garde) and the TeX Gyre Times/Helvetica/Courier clones are also baked
into the image; swap any face with e.g. `--set render.fontBody="TeX Gyre Termes"`.

Useful knobs (see `src/config.js` → `render` for all of them):

- `render.title` / `render.author` — adds a centered title page
- `render.chapterBreak=right` — chapters start on recto pages like a hardcover
- `render.figureScale` / `render.figureMaxFrac` — global figure sizing
- `render.tocDepth` — `1` lists only chapters in the TOC

The exact HTML/CSS that was typeset lands in `work/97-render/debug/book.html`
— open it in a browser to iterate on styling questions quickly.

### VS Code tasks (Terminal → Run Task…)

- **pdfcut: build image**
- **pdfcut: run on test pages** — prompts for a page range (default `1-3`)
- **pdfcut: run single stage (dev mounts, force)** — re-runs one stage with
  `src/` and `scripts/` mounted from the workspace, so code edits apply
  without rebuilding the image
- **pdfcut: run from stage onward (dev mounts, force)** — re-cascade after tuning
- **pdfcut: render print PDF** — `output/book.md` → `output/book-print.pdf` at A5
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
pdfcut markdown [--body-pages 12-181] [--set markdown.key=value]... [--force]
pdfcut render [--set render.key=value]...   # output/book.md → output/book-print.pdf
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
