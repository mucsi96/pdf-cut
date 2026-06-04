# pdf-cut

Turn a scanned book PDF — where **two book pages are scanned onto one
landscape sheet** and the scan is **slightly rotated** — into a clean PDF with
**one scanned page per PDF page**, automatically straightened (deskewed) and
aligned.

It is a small Node.js CLI that orchestrates a battle-tested binary toolchain,
all bundled in a Docker image so it runs anywhere (including **WSL with
podman**) with no local setup:

| Tool | Role |
| --- | --- |
| [`pdftoppm`](https://poppler.freedesktop.org/) (poppler-utils) | Rasterize each PDF page to a high-resolution PNG |
| [ImageMagick](https://imagemagick.org/) (`convert`) | Split each landscape sheet in half, remove dark scanner-bed edges, trim margins, add a clean border |
| [OpenCV](https://opencv.org/) (Python) | Robust text-based **deskew** and **punch-hole detection** |
| [LaMa](https://github.com/enesmsahin/simple-lama-inpainting) (PyTorch) | **AI inpainting** that fills the detected punch holes |
| [`img2pdf`](https://gitlab.mister-muffin.de/josch/img2pdf) | Re-assemble the cleaned pages into a PDF **losslessly** |

> The Python/AI stage (OpenCV + LaMa) is optional: if it (or its dependencies)
> isn't present, `pdf-cut` automatically falls back to ImageMagick's deskew and
> simply skips hole-filling. The Docker image bundles everything, including the
> LaMa model weights, so no download happens at run time.

## What it does

```
   ┌─────────────────────────┐          ┌───────────┐   ┌───────────┐
   │   Page 1   │   Page 2    │          │           │   │           │
   │  (skewed landscape sheet)│   ──▶    │  Page 1   │   │  Page 2   │
   │                          │          │ (straight)│   │ (straight)│
   └─────────────────────────┘          └───────────┘   └───────────┘
        one input PDF page                two output PDF pages
```

1. **Rasterize** every landscape sheet at a chosen DPI.
2. **Split** each sheet down the middle into a left and a right page.
3. **Clean edges** — remove the dark scanner-bed bars along the page borders
   (flood-filled from the corners). This happens *before* deskew, because the
   black frame would otherwise bias the rotation detection and survive trimming.
4. **Deskew** each page so the text is perfectly horizontal (text-based, via
   OpenCV; falls back to ImageMagick when the Python stage is unavailable).
5. **Fill punch holes** — detect the solid, round, dark blobs left by a
   hole-punched book and inpaint them with LaMa, reconstructing the background
   (and even text) underneath.
6. **Trim** the surrounding scanner margin and add a clean, uniform border.
7. **Re-assemble** everything into a new one-page-per-page PDF.

## Quick start (Docker / podman)

Build the image once:

```bash
# Docker
docker build -t pdf-cut .

# podman (e.g. inside WSL)
podman build -t pdf-cut .
```

Then run it on a PDF in the current directory. The current directory is mounted
to `/data` inside the container, so input/output paths are relative to it:

```bash
# Docker
docker run --rm -v "$PWD":/data pdf-cut scan.pdf -o book.pdf

# podman (WSL)
podman run --rm -v "$PWD":/data:Z pdf-cut scan.pdf -o book.pdf
```

That reads `./scan.pdf` and writes the cleaned `./book.pdf`.

> **WSL + podman tips**
> - Keep your PDFs on the Linux filesystem (e.g. `~/scans`), not under
>   `/mnt/c/...`, for much faster I/O.
> - The `:Z` volume suffix relabels the mount for SELinux; it is harmless if
>   SELinux is not enforcing and required if it is.
> - If podman runs rootless and you hit permission issues on the output file,
>   add `--userns=keep-id`.

A convenient shell alias:

```bash
alias pdf-cut='podman run --rm -v "$PWD":/data:Z pdf-cut'
pdf-cut scan.pdf -o book.pdf --dpi 400
```

## Usage

```
pdf-cut [options] <input>

Arguments:
  input                     source PDF file

Options:
  -o, --output <file>       output PDF file (default: <input>.cut.pdf)
  -r, --dpi <n>             rasterization resolution in DPI (default: 300)
  --no-split                do not split sheets in half (deskew only)
  --right-to-left           order the two halves right-to-left (e.g. manga/Hebrew)
  --no-deskew               disable automatic deskew/straightening
  --deskew-threshold <pct>  deskew sensitivity in percent (default: 40)
  --rotate <deg>            fixed rotation applied to every page before deskew (default: 0)
  --no-clean-edges          do not remove dark scanner-bed bars from page edges
  --edge-fuzz <pct>         tolerance for detecting dark edge bars (default: 30)
  --no-trim                 do not trim surrounding scanner margins
  --fuzz <pct>              trim color tolerance in percent (default: 15)
  --border <px>             uniform border added back after trim (default: 30)
  --background <color>      fill/border/trim color (default: white)
  --no-smart                disable the Python AI stage (text deskew + hole-fill)
  --no-fill-holes           do not detect and inpaint punch holes
  --deskew-limit <deg>      max skew angle searched by text-based deskew (default: 8)
  --hole-min-mm <mm>        smallest punch-hole diameter (default: 3)
  --hole-max-mm <mm>        largest punch-hole diameter (default: 10)
  --dark-threshold <n>      darkness cutoff 0-255 for hole detection (default: 80)
  --python <bin>            python interpreter for the AI stage (default: python3)
  --device <dev>            torch device for LaMa (cpu/cuda) (default: cpu)
  -j, --jobs <n>            number of pages to process in parallel (default: CPU count)
  --keep-temp               keep the temporary working directory
  -q, --quiet               suppress progress output
  -V, --version             output the version number
  -h, --help                display help
```

### Examples

```bash
# Default: split each landscape sheet into two, deskew, trim, 300 DPI
pdf-cut scan.pdf -o book.pdf

# Higher quality for fine print
pdf-cut scan.pdf -o book.pdf --dpi 400

# Pages were scanned right-to-left (e.g. manga)
pdf-cut scan.pdf -o book.pdf --right-to-left

# Already one page per sheet — just straighten them
pdf-cut scan.pdf -o book.pdf --no-split

# The whole scan is rotated 90° (portrait sheets stored sideways)
pdf-cut scan.pdf -o book.pdf --no-split --rotate 90

# Scans on a dark background, keep a larger white border, looser trim
pdf-cut scan.pdf -o book.pdf --fuzz 25 --border 60

# Book had large reinforced punch holes — widen the size window
pdf-cut scan.pdf -o book.pdf --hole-max-mm 14

# Skip the AI stage entirely (fastest, ImageMagick deskew only, holes left in)
pdf-cut scan.pdf -o book.pdf --no-smart
```

## Tuning notes

- **`--dpi`** drives quality and file size. 300 is good for text; use 400–600
  for fine detail (slower, larger output).
- **Edge cleaning** (`--edge-fuzz`) removes the dark scanner-bed bars that frame
  many scans. It runs before deskew, which also makes the straightening reliable
  (a black frame otherwise dominates the skew detection). Raise `--edge-fuzz` if
  bars are dark-grey rather than black; lower it if real content near the border
  is being eaten. Disable with `--no-clean-edges`.
- **Deskew** (`--deskew-threshold`) works best on pages with clear horizontal
  text. If straightening is too aggressive or not enough, adjust the threshold
  (lower = more eager). Disable with `--no-deskew`.
- **Trim** (`--fuzz`) controls how aggressively the scanner margin is removed.
  Increase it when the page background is off-white or grey; decrease it if real
  content is being cut off. Disable with `--no-trim`.
- **`--border`** adds a clean, uniform margin back after trimming so pages don't
  look cramped.
- **Punch-hole filling** detects solid, round, dark blobs whose diameter falls
  between `--hole-min-mm` and `--hole-max-mm` (default 3–10 mm) and inpaints them
  with LaMa. The detection isolates the round core even when a hole overlaps text
  (e.g. a running header), so the AI can reconstruct what was underneath. Widen
  the size window for reinforced/large punches, raise `--dark-threshold` if the
  holes are dark-grey rather than black, or turn it off with `--no-fill-holes`.
  Real reconstruction quality comes from the AI model, so this needs the Docker
  image (or a local PyTorch + LaMa install).

## Running without Docker

If you prefer to run it natively, install the binary dependencies and use Node
18+:

```bash
# Debian / Ubuntu / WSL
sudo apt-get install -y poppler-utils imagemagick img2pdf

# macOS (Homebrew)
brew install poppler imagemagick img2pdf

npm install
node src/cli.js scan.pdf -o book.pdf
# or after `npm link`:
pdf-cut scan.pdf -o book.pdf
```

Without the Python/AI stack this uses ImageMagick deskew and skips hole-filling.
To enable the robust text-based deskew and AI punch-hole inpainting locally,
add the Python dependencies (a virtualenv is recommended):

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install numpy opencv-python-headless pillow
pip install --no-deps simple-lama-inpainting
```

`pdf-cut` will detect them automatically (override the interpreter with
`--python /path/to/python`).

## How it works internally

The CLI never lets ImageMagick touch the PDF directly (which avoids the usual
ImageMagick PDF policy restrictions). Instead:

1. `pdftoppm -png -r <dpi> input.pdf` → one PNG per sheet.
2. For each sheet, `convert ... -crop 50%x100%` → left/right halves.
3. **Edge clean** (`convert`): flood-fill the dark scanner bars from the corners.
4. **Smart stage** (`python/pdf_fix.py`, batched so the LaMa model loads once):
   text-projection deskew, then detect punch holes (dark + round + solid, via a
   morphological opening that isolates the core from any overlapping text) and
   inpaint a small crop around each with LaMa.
5. **Finish** (`convert`): `-trim` the margin and add a uniform `-border`.
6. `img2pdf` packs the PNGs back into a PDF, preserving image quality and DPI.

## License

MIT © Igor Bari
