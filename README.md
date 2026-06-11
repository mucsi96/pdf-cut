# pdf-cut

Turn a 2-up scanned book PDF into a print-quality, one-page-per-page PDF:

1. **rasterize** — extracts each page's embedded scan bitmap losslessly at native resolution
   (`pdfimages`); falls back to `pdftoppm` rendering for non-single-image pages or with `--no-extract`
2. **split** — gutter detection cuts each landscape scan into left/right book pages
3. **preclean** — OpenCV residue removal: a morphological opening isolates thick dark masses
   (binding shadows, edge bars) and paints them white *in place* — text strokes are thin and can
   never be dragged along; hairline bars are caught by a stroke-width classifier; every page's
   content block is then registered to identical margins
4. **analyze** *(AI, optional)* — Gemini vision QA per page (quality flags, residual skew)
5. **inpaint** *(local ML)* — OpenCV detects punch holes (solid round dark blobs in a physical
   size range, scored by circularity/solidity) and **LaMa** inpaints a small crop around each —
   only the masked pixels change; runs fully offline, no API key
6. **deskew** — projection-profile skew detection (±3°, 0.02° precision, Otsu threshold) on the
   already-cleaned, hole-free pages; illustrations are excluded from the projection so their
   diagonal strokes cannot out-vote the text lines; one high-quality grayscale rotation, then the
   straightened content is re-registered
7. **cover** *(AI)* — the cover scan (scan 1) never enters the book pipeline: Gemini 3 Pro
   Image recreates the WHOLE cover (back + spine + front) as one full-color image (4K) and it
   is written to its own separate PDF (default `<out>-cover.pdf`)
8. **assemble** — `img2pdf` embeds the grayscale pages losslessly at the exact physical page size

Every stage is resumable: intermediates live in `work/NN-<stage>/` with manifests, so re-runs
only redo what changed. `--force <stage>` rebuilds a stage and everything after it.

## Setup (WSL + podman)

```sh
cp .env.example .env          # GEMINI_API_KEY for QA + cover (hole inpainting needs NO key)
podman build -t pdf-cut .     # bundles OpenCV + CPU torch + LaMa weights — no runtime downloads
```

Put your scanned book at `./input.pdf` (600 DPI scans, two book pages per landscape PDF page).

## Usage

```sh
# Quick test on the first 3 scans, no AI calls:
podman run --rm -v "$PWD":/data pdf-cut \
  process /data/input.pdf --pages 1-3 --workdir /data/work --out /data/out.pdf --skip-ai --debug

# Same with AI (hole repair + analysis):
podman run --rm -v "$PWD":/data --env-file .env pdf-cut \
  process /data/input.pdf --pages 1-3 --workdir /data/work --out /data/out.pdf --debug

# Full book (book pages → out.pdf, color cover → out-cover.pdf):
podman run --rm -v "$PWD":/data --env-file .env pdf-cut \
  process /data/input.pdf --workdir /data/work --out /data/out.pdf

# Cover only:
podman run --rm -v "$PWD":/data --env-file .env pdf-cut \
  cover /data/input.pdf --workdir /data/work

# Synthetic test input (no real scan needed):
podman run --rm -v "$PWD":/data pdf-cut fixture --out /data/test-input.pdf --pages 4
```

In VSCode, use the tasks in `.vscode/tasks.json` (`Terminal → Run Task…`): build image,
test a page range offline or with AI, cover only, open the debug report.

### Key flags

| Flag | Meaning |
|---|---|
| `--pages 1-3,7` | process only these scan pages |
| `--skip-ai` | no remote AI: skip vision QA, cover PDF uses the original scan (LaMa hole-fill still runs — it is local) |
| `--from/--to <stage>` | run part of the pipeline |
| `--force <stage>` | rebuild a stage (and downstream) after tuning |
| `--page-size auto\|A5\|148x210mm` | physical output page size (auto = derived from content) |
| `--no-cover` | treat scan 1 as a regular 2-up spread, not a cover |
| `--cover-out file.pdf` | where to write the cover PDF (default `<out>-cover.pdf`) |
| `--swap-order` | right page before left page (other binding direction) |
| `--vision-provider gemini\|anthropic` | analysis model provider |
| `--dpi 600` | rasterization DPI (use the scan's native resolution) |
| `--cover-prompt "..."` | custom cover recreation prompt |

## Tuning with the debug report

Run with `--debug`, then open `work/debug/index.html`. Every stage shows annotated
overlays per page: detected gutter + projection profile, deskew before/after with the
measured angle, the content box and erased residue zones, AI-reported hole boxes,
before/mask/LaMa-result/composite for each filled hole, and scan-vs-AI cover. Tweak thresholds in `src/config.js`, re-run with `--force <stage>`,
refresh the report.

## Notes

- The first scan page is treated as the cover. It is never split or processed as book pages:
  the whole artwork (back + spine + front) is recreated by AI as ONE color image into its own
  PDF; with `--skip-ai` the original scan image is used instead. `--no-cover` disables this.
- API keys are never baked into the image — pass them with `--env-file .env`.
  Model IDs can be overridden via env vars (see `.env.example`).
- Book pages are emitted as 600 DPI grayscale, embedded losslessly into the PDF.
- Tests: `npm test` (the E2E part needs poppler/imagemagick/img2pdf on the host).
