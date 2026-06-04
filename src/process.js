import { mkdtemp, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, commandExists, ensureTools } from './exec.js';

/**
 * Resolve which ImageMagick entry points are available. ImageMagick 7 ships
 * the `magick` driver; ImageMagick 6 (Debian/Ubuntu default) ships `convert`
 * and `identify` as separate binaries.
 */
async function detectImageMagick() {
  if (await commandExists('magick')) {
    return {
      convert: ['magick'],
      identify: ['magick', 'identify'],
    };
  }
  if (await commandExists('convert')) {
    return {
      convert: ['convert'],
      identify: ['identify'],
    };
  }
  throw new Error('ImageMagick not found: install the "imagemagick" package.');
}

/** Build a command + args helper from a base argv array. */
function withBase(base, args) {
  return { cmd: base[0], args: [...base.slice(1), ...args] };
}

/** Natural sort so page-2 comes before page-10. */
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Rasterize every page of the source PDF to a PNG using poppler's pdftoppm.
 * Returns the list of produced image paths in page order.
 */
async function rasterize(input, workDir, dpi) {
  const prefix = path.join(workDir, 'sheet');
  await run('pdftoppm', ['-png', '-r', String(dpi), input, prefix]);

  const files = (await readdir(workDir))
    .filter((f) => f.startsWith('sheet') && f.endsWith('.png'))
    .sort(naturalSort)
    .map((f) => path.join(workDir, f));

  if (files.length === 0) {
    throw new Error('pdftoppm produced no pages — is the input a valid PDF?');
  }
  return files;
}

/**
 * Split a single landscape sheet into its two halves. Returns the produced
 * file paths ordered for reading (left→right, or right→left when requested).
 */
async function splitSheet(magick, sheet, outDir, { rightToLeft }) {
  const outPattern = path.join(outDir, 'half-%d.png');
  // -crop 50%x100% yields tile 0 (left) and tile 1 (right).
  const { cmd, args } = withBase(magick.convert, [
    sheet,
    '-crop',
    '50%x100%',
    '+repage',
    '+adjoin',
    outPattern,
  ]);
  await run(cmd, args);

  const left = path.join(outDir, 'half-0.png');
  const right = path.join(outDir, 'half-1.png');
  return rightToLeft ? [right, left] : [left, right];
}

/**
 * Clean up a single page image: optional rotation for sideways scans,
 * automatic deskew, trim of surrounding scanner margin, and a uniform border.
 */
async function cleanPage(magick, src, dest, opts) {
  const { deskew, deskewThreshold, rotate, trim, fuzz, border, background } = opts;

  const args = [src, '-background', background];

  if (rotate) {
    args.push('-rotate', String(rotate));
  }
  if (deskew) {
    // -deskew straightens text-bearing scans; corners are filled with -background.
    args.push('-deskew', `${deskewThreshold}%`);
  }
  if (trim) {
    args.push('-fuzz', `${fuzz}%`, '-trim', '+repage');
  }
  if (border > 0) {
    args.push('-bordercolor', background, '-border', String(border), '+repage');
  }
  // Ensure clean, alpha-free output that img2pdf packs without transcoding surprises.
  args.push('-alpha', 'remove', '-alpha', 'off', dest);

  const { cmd, args: full } = withBase(magick.convert, args);
  await run(cmd, full);
}

/** Simple bounded-concurrency map. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Main entry point. Converts a scanned book PDF (two pages per landscape sheet,
 * possibly slightly skewed) into a clean one-page-per-page PDF.
 *
 * @param {object} options
 * @param {string} options.input        Path to the source PDF.
 * @param {string} options.output       Path to the destination PDF.
 * @param {number} options.dpi          Rasterization resolution.
 * @param {boolean} options.split       Split each sheet into two halves.
 * @param {boolean} options.rightToLeft Order halves right→left.
 * @param {boolean} options.deskew      Auto-straighten each page.
 * @param {number} options.deskewThreshold  Deskew sensitivity (percent).
 * @param {number} options.rotate       Fixed rotation applied before deskew.
 * @param {boolean} options.trim        Trim scanner margins.
 * @param {number} options.fuzz         Trim color tolerance (percent).
 * @param {number} options.border       Uniform border to add back (pixels).
 * @param {string} options.background   Fill/border/trim color.
 * @param {number} options.jobs         Concurrency.
 * @param {boolean} options.keepTemp    Keep the temp working directory.
 * @param {(msg: string) => void} [options.log]
 */
export async function processPdf(options) {
  const {
    input,
    output,
    dpi,
    split,
    rightToLeft,
    deskew,
    deskewThreshold,
    rotate,
    trim,
    fuzz,
    border,
    background,
    jobs,
    keepTemp,
    log = () => {},
  } = options;

  if (!existsSync(input)) {
    throw new Error(`Input file not found: ${input}`);
  }
  const inputStat = await stat(input);
  if (!inputStat.isFile()) {
    throw new Error(`Input is not a file: ${input}`);
  }

  await ensureTools(['pdftoppm', 'img2pdf']);
  const magick = await detectImageMagick();

  const workDir = await mkdtemp(path.join(tmpdir(), 'pdf-cut-'));
  const halvesDir = path.join(workDir, 'halves');
  const finalDir = path.join(workDir, 'final');
  await mkdir(halvesDir);
  await mkdir(finalDir);

  try {
    log(`Rasterizing "${path.basename(input)}" at ${dpi} DPI...`);
    const sheets = await rasterize(input, workDir, dpi);
    log(`  ${sheets.length} sheet(s) found.`);

    // Build the ordered list of raw page images (split halves or whole sheets).
    const rawPages = [];
    if (split) {
      log('Splitting sheets into single pages...');
      for (let i = 0; i < sheets.length; i++) {
        const sheetDir = path.join(halvesDir, String(i));
        await mkdir(sheetDir);
        const halves = await splitSheet(magick, sheets[i], sheetDir, { rightToLeft });
        rawPages.push(...halves);
      }
    } else {
      rawPages.push(...sheets);
    }

    log(`Cleaning ${rawPages.length} page(s) (deskew=${deskew}, trim=${trim}, jobs=${jobs})...`);
    const finalPages = await mapPool(rawPages, jobs, async (src, index) => {
      const dest = path.join(finalDir, `page-${String(index + 1).padStart(5, '0')}.png`);
      await cleanPage(magick, src, dest, {
        deskew,
        deskewThreshold,
        rotate,
        trim,
        fuzz,
        border,
        background,
      });
      return dest;
    });

    log(`Assembling ${finalPages.length}-page PDF...`);
    const outDir = path.dirname(path.resolve(output));
    if (!existsSync(outDir)) {
      await mkdir(outDir, { recursive: true });
    }
    await run('img2pdf', ['--output', output, ...finalPages]);

    log(`Done → ${output}`);
    return { pages: finalPages.length, output };
  } finally {
    if (keepTemp) {
      log(`Temp files kept at: ${workDir}`);
    } else {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
