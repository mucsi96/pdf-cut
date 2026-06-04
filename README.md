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
| [ImageMagick](https://imagemagick.org/) (`convert`) | Split each landscape sheet in half, auto-**deskew**, trim margins, add a clean border |
| [`unpaper`](https://github.com/unpaper/unpaper) | Remove **punch holes**, scan residue, noise and blur from each page |
| [`img2pdf`](https://gitlab.mister-muffin.de/josch/img2pdf) | Re-assemble the cleaned pages into a PDF **losslessly** |

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
4. **Unpaper** — remove punch holes, scan residue, noise and blur from inside
   the page. Runs after edge cleaning and before deskew so it sees the page
   without the dark frame but in its original geometry.
5. **Deskew** each page so the text is perfectly horizontal.
6. **Trim** the surrounding scanner margin, optionally sharpen, and add a
   clean, uniform border.
7. **Re-assemble** everything into a new one-page-per-page PDF (optionally
   downsampled to a target print DPI).

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
  --no-unpaper              disable unpaper cleanup (punch holes, scan residue)
  --unpaper-args <s>        extra arguments forwarded to unpaper (space-separated)
  --no-trim                 do not trim surrounding scanner margins
  --fuzz <pct>              trim color tolerance in percent (default: 15)
  --sharpen                 apply a gentle unsharp-mask pass to crisp text
  --sharpen-amount <s>      ImageMagick -unsharp argument (default: 0x1)
  --border <px>             uniform border added back after trim (default: 30)
  --background <color>      fill/border/trim color (default: white)
  --output-dpi <n>          downsample final pages to this DPI (default: same as --dpi)
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

# Print-ready: 600 DPI source, unpaper cleanup, gentle sharpen,
# downsampled to 300 DPI in the output PDF
pdf-cut scan.pdf -o book.pdf --dpi 600 --output-dpi 300 --sharpen

# Pages were scanned right-to-left (e.g. manga)
pdf-cut scan.pdf -o book.pdf --right-to-left

# Already one page per sheet — just straighten them
pdf-cut scan.pdf -o book.pdf --no-split

# The whole scan is rotated 90° (portrait sheets stored sideways)
pdf-cut scan.pdf -o book.pdf --no-split --rotate 90

# Scans on a dark background, keep a larger white border, looser trim
pdf-cut scan.pdf -o book.pdf --fuzz 25 --border 60
```

## Tuning notes

- **`--dpi`** drives quality and file size. 300 is good for text; use 400–600
  for fine detail (slower, larger output).
- **Edge cleaning** (`--edge-fuzz`) removes the dark scanner-bed bars that frame
  many scans. It runs before deskew, which also makes the straightening reliable
  (a black frame otherwise dominates the skew detection). Raise `--edge-fuzz` if
  bars are dark-grey rather than black; lower it if real content near the border
  is being eaten. Disable with `--no-clean-edges`.
- **Unpaper** removes punch holes, scan residue, noise and blur from inside the
  page. It runs after edge cleaning (so the corner bars don't confuse its black
  filter) and before deskew (so deskew sees the cleanest possible page).
  Disable with `--no-unpaper`; forward extra flags via
  `--unpaper-args "--noisefilter-intensity 5 ..."`.
- **Sharpen** (`--sharpen`) applies a single mild unsharp-mask pass after trim,
  which crisps text edges without the ringing artifacts heavier sharpening
  introduces around glyphs. Tune with `--sharpen-amount 0x1.2` etc.
- **Output DPI** (`--output-dpi`) downsamples the final pages while still
  rasterizing and cleaning at the high source `--dpi`. For print, scan at
  600 DPI for processing headroom and emit at 300 DPI to keep the PDF small
  without losing print quality.
- **Deskew** (`--deskew-threshold`) works best on pages with clear horizontal
  text. If straightening is too aggressive or not enough, adjust the threshold
  (lower = more eager). Disable with `--no-deskew`.
- **Trim** (`--fuzz`) controls how aggressively the scanner margin is removed.
  Increase it when the page background is off-white or grey; decrease it if real
  content is being cut off. Disable with `--no-trim`.
- **`--border`** adds a clean, uniform margin back after trimming so pages don't
  look cramped.

## Running without Docker

If you prefer to run it natively, install the binary dependencies and use Node
18+:

```bash
# Debian / Ubuntu / WSL
sudo apt-get install -y poppler-utils imagemagick unpaper img2pdf

# macOS (Homebrew)
brew install poppler imagemagick unpaper img2pdf

npm install
node src/cli.js scan.pdf -o book.pdf
# or after `npm link`:
pdf-cut scan.pdf -o book.pdf
```

## How it works internally

The CLI never lets ImageMagick touch the PDF directly (which avoids the usual
ImageMagick PDF policy restrictions). Instead:

1. `pdftoppm -png -r <dpi> input.pdf` → one PNG per sheet.
2. For each sheet, `convert ... -crop 50%x100%` → left/right halves.
3. For each page, when unpaper is enabled, two `convert` passes wrap an
   `unpaper` invocation: pass 1 does rotate + edge cleanup, `unpaper`
   removes punch holes / scan residue, pass 2 does deskew + trim +
   optional sharpen + border + optional `-resample` to the output DPI.
   When unpaper is disabled it collapses to a single `convert` pipeline.
4. `img2pdf` packs the PNGs back into a PDF, preserving image quality and DPI.

## License

MIT © Igor Bari
