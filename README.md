# pdf-cut

Turn a 2-up scanned book PDF into a print-quality, one-page-per-page PDF:

1. **rasterize** — each scan page → grayscale PNG at 600 DPI (`pdftoppm`)
2. **split** — gutter detection cuts each landscape scan into left/right book pages
3. **deskew** — projection-profile skew detection (±3°, 0.02° precision), one high-quality grayscale rotation
4. **preclean** — scanner residue connected to the page edge is erased; the content block of every page is registered to identical margins
5. **analyze** *(AI)* — Gemini vision finds punch-hole damage (with the text it covers) and QA-checks every page
6. **inpaint** *(AI)* — OpenAI `gpt-image-1` mask-inpaints each hole from a 1024×1024 context patch; only the masked pixels are composited back
7. **binarize** — adaptive threshold → crisp 1-bit pages, despeckled, CCITT G4 TIFF
8. **cover** *(AI)* — Gemini 3 Pro Image recreates the cover in full color (4K)
9. **assemble** — `img2pdf` embeds the G4 TIFFs losslessly at the exact physical page size

Every stage is resumable: intermediates live in `work/NN-<stage>/` with manifests, so re-runs
only redo what changed. `--force <stage>` rebuilds a stage and everything after it.

## Setup (WSL + podman)

```sh
cp .env.example .env          # fill in GEMINI_API_KEY, OPENAI_API_KEY (ANTHROPIC_API_KEY optional)
podman build -t pdf-cut .
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

# Full book including color cover recreation (front + back):
podman run --rm -v "$PWD":/data --env-file .env pdf-cut \
  process /data/input.pdf --workdir /data/work --out /data/out.pdf --back-cover

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
| `--skip-ai` | offline mode: skip analyze/inpaint/cover |
| `--from/--to <stage>` | run part of the pipeline |
| `--force <stage>` | rebuild a stage (and downstream) after tuning |
| `--page-size auto\|A5\|148x210mm` | physical output page size (auto = derived from content) |
| `--back-cover` | also recreate the back cover as the last page |
| `--swap-order` | right page before left page (other binding direction) |
| `--vision-provider gemini\|anthropic` | analysis model provider |
| `--dpi 600` | rasterization DPI (use the scan's native resolution) |
| `--cover-prompt "..."` | custom cover recreation prompt |

## Tuning with the debug report

Run with `--debug`, then open `work/debug/index.html`. Every stage shows annotated
overlays per page: detected gutter + projection profile, deskew before/after with the
measured angle, the content box and erased residue zones, AI-reported hole boxes,
patch/mask/AI-result/composite for each inpaint, grayscale-vs-1-bit comparison, and
scan-vs-AI cover. Tweak thresholds in `src/config.js`, re-run with `--force <stage>`,
refresh the report.

## Notes

- The first scan page is treated as the cover (left half = back, right half = front).
  The cover is fully recreated by AI; with `--skip-ai` it falls back to the binarized scan.
- API keys are never baked into the image — pass them with `--env-file .env`.
  Model IDs can be overridden via env vars (see `.env.example`).
- Inner pages are emitted as 1-bit 600 DPI CCITT G4 — ideal for book printing and tiny files.
- Tests: `npm test` (the E2E part needs poppler/imagemagick/img2pdf on the host).
