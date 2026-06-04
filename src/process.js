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

/** ImageMagick ops that should run BEFORE unpaper (or as the first half of the
 *  single-pass pipeline): the optional fixed rotation and the corner flood-fill
 *  that strips the dark scanner-bed bars. Cleaning edges first matters even
 *  without unpaper, because a black frame biases the eventual -deskew. */
function pushPreOps(args, opts) {
  const { rotate, cleanEdges, edgeFuzz, background } = opts;
  if (rotate) {
    args.push('-rotate', String(rotate));
  }
  if (cleanEdges) {
    args.push('-fuzz', `${edgeFuzz}%`, '-fill', background);
    args.push('-draw', 'color 0,0 floodfill');
    args.push('-flop', '-draw', 'color 0,0 floodfill');
    args.push('-flip', '-draw', 'color 0,0 floodfill');
    args.push('-flop', '-draw', 'color 0,0 floodfill');
    args.push('-flip');
  }
}

/** ImageMagick ops that run AFTER unpaper (or as the second half of the
 *  single-pass pipeline): deskew, trim, optional unsharp pass for crisper
 *  print output, uniform border, and an optional resample to a lower output
 *  DPI for print. */
function pushPostOps(args, opts) {
  const {
    deskew,
    deskewThreshold,
    trim,
    fuzz,
    border,
    background,
    sharpen,
    sharpenAmount,
    dpi,
    outputDpi,
  } = opts;
  if (deskew) {
    args.push('-deskew', `${deskewThreshold}%`);
  }
  if (trim) {
    args.push('-fuzz', `${fuzz}%`, '-trim', '+repage');
  }
  if (sharpen) {
    args.push('-unsharp', sharpenAmount);
  }
  if (border > 0) {
    args.push('-bordercolor', background, '-border', String(border), '+repage');
  }
  if (outputDpi > 0 && outputDpi !== dpi) {
    // -resample scales the pixel grid and updates the PNG density chunk;
    // img2pdf reads that density to set the page size, so the output PDF
    // ends up at the requested print resolution.
    args.push('-units', 'PixelsPerInch', '-density', String(dpi), '-resample', String(outputDpi));
  }
}

/** Args passed to unpaper. Unpaper handles punch-hole removal, scan residue,
 *  noise and blur cleanup; we intentionally leave deskew/border/mask scanning
 *  to ImageMagick so the existing tuning knobs keep working. */
function buildUnpaperArgs(src, dest, opts) {
  const { dpi, unpaperArgs: extra } = opts;
  const args = [
    '--layout', 'single',
    '--dpi', String(dpi),
    '--no-deskew',
    '--no-mask-scan',
    '--no-border-scan',
    '--overwrite',
  ];
  if (extra) {
    args.push(...extra.split(/\s+/).filter(Boolean));
  }
  args.push(src, dest);
  return args;
}

/**
 * Clean up a single page image. With unpaper enabled the work is split across
 * two ImageMagick passes wrapping an unpaper invocation, so unpaper sees the
 * page after the scanner-bed bars are gone but before deskew has changed the
 * geometry. With unpaper off this collapses to a single ImageMagick pipeline
 * that matches the original behaviour.
 */
async function cleanPage(magick, src, dest, opts) {
  const { background } = opts;

  if (!opts.unpaper) {
    const args = [src, '-background', background];
    pushPreOps(args, opts);
    pushPostOps(args, opts);
    args.push('-alpha', 'remove', '-alpha', 'off', dest);
    const { cmd, args: full } = withBase(magick.convert, args);
    await run(cmd, full);
    return;
  }

  const stage1 = `${dest}.s1.png`;
  const stage2 = `${dest}.s2.png`;
  try {
    const preArgs = [src, '-background', background];
    pushPreOps(preArgs, opts);
    // unpaper 7 rejects 16-bit input ("unsupported pixel format"); force 8-bit
    // so any earlier IM op that promoted depth doesn't trip it.
    preArgs.push('-depth', '8', '-alpha', 'remove', '-alpha', 'off', stage1);
    const { cmd: c1, args: a1 } = withBase(magick.convert, preArgs);
    await run(c1, a1);

    await run('unpaper', buildUnpaperArgs(stage1, stage2, opts));

    const postArgs = [stage2, '-background', background];
    pushPostOps(postArgs, opts);
    postArgs.push('-alpha', 'remove', '-alpha', 'off', dest);
    const { cmd: c2, args: a2 } = withBase(magick.convert, postArgs);
    await run(c2, a2);
  } finally {
    await rm(stage1, { force: true });
    await rm(stage2, { force: true });
  }
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
 * @param {boolean} options.cleanEdges  Strip dark scanner-bed bars from corners.
 * @param {number} options.edgeFuzz     Tolerance for edge-bar detection (percent).
 * @param {boolean} options.unpaper     Run unpaper to remove punch holes / scan residue.
 * @param {string} options.unpaperArgs  Extra space-separated args forwarded to unpaper.
 * @param {boolean} options.sharpen     Apply a gentle unsharp pass for crisper text.
 * @param {string} options.sharpenAmount  ImageMagick -unsharp argument (e.g. "0x1").
 * @param {number} options.outputDpi    Downsample final pages to this DPI (0 = same as dpi).
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
    cleanEdges,
    edgeFuzz,
    unpaper,
    unpaperArgs: unpaperExtraArgs,
    sharpen,
    sharpenAmount,
    outputDpi,
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

  const required = ['pdftoppm', 'img2pdf'];
  if (unpaper) required.push('unpaper');
  await ensureTools(required);
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

    log(
      `Cleaning ${rawPages.length} page(s) (clean-edges=${cleanEdges}, unpaper=${unpaper}, ` +
        `deskew=${deskew}, trim=${trim}, sharpen=${sharpen}, jobs=${jobs})...`
    );
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
        cleanEdges,
        edgeFuzz,
        unpaper,
        unpaperArgs: unpaperExtraArgs,
        sharpen,
        sharpenAmount,
        dpi,
        outputDpi,
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
