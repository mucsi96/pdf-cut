import { mkdtemp, rm, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { run, commandExists, ensureTools } from './exec.js';

const PY_SCRIPT = fileURLToPath(new URL('../python/pdf_fix.py', import.meta.url));

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
 * Stage 1 — rotate sideways scans and remove the dark scanner-bed bars.
 *
 * The bars are stripped BEFORE any deskew because the black frame would
 * otherwise (a) bias deskew, which weighs every dark pixel, so the rotation
 * never gets corrected, and (b) survive the white trim as a skewed frame inside
 * the margin. flip/flop brings each corner to (0,0) in turn and the four
 * transforms compose back to the original orientation.
 */
async function imEdgeClean(magick, src, dest, { rotate, cleanEdges, edgeFuzz, background }) {
  const args = [src, '-background', background];
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
  args.push('+repage', dest);
  const { cmd, args: full } = withBase(magick.convert, args);
  await run(cmd, full);
}

/** Fallback straightening when the Python text-based deskew is unavailable. */
async function imDeskew(magick, src, dest, { deskew, deskewThreshold, background }) {
  const args = [src, '-background', background];
  if (deskew) {
    args.push('-deskew', `${deskewThreshold}%`);
  }
  args.push('+repage', dest);
  const { cmd, args: full } = withBase(magick.convert, args);
  await run(cmd, full);
}

/** Stage 3 — trim the scanner margin, add a clean border, flatten alpha. */
async function imFinish(magick, src, dest, { trim, fuzz, border, background }) {
  const args = [src, '-background', background];
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

/** Map a few named colors to the "r,g,b" form the Python helper expects. */
function colorToRgb(color) {
  const named = { white: '255,255,255', black: '0,0,0', gray: '128,128,128', grey: '128,128,128' };
  if (named[color]) return named[color];
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (m) return [1, 2, 3].map((i) => parseInt(m[i], 16)).join(',');
  return '255,255,255';
}

/**
 * Probe whether the Python "smart" stage (robust deskew + LaMa hole-fill) and
 * its dependencies are importable, so we can transparently fall back otherwise.
 */
async function detectPython(pythonBin, fillHoles) {
  if (!existsSync(PY_SCRIPT)) return false;
  try {
    const { stdout } = await run(pythonBin, [
      PY_SCRIPT,
      '--check',
      fillHoles ? '--fill-holes' : '--no-fill-holes',
    ]);
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

/**
 * Stage 2 (smart) — run the batched Python helper over every edge-cleaned page.
 * Loads the LaMa model once and writes deskewed, hole-filled PNGs.
 */
async function runPythonStage(pythonBin, pairs, params, workDir) {
  const manifestPath = path.join(workDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(pairs));

  const args = [
    PY_SCRIPT,
    '--manifest', manifestPath,
    '--dpi', String(params.dpi),
    params.deskew ? '--deskew' : '--no-deskew',
    params.fillHoles ? '--fill-holes' : '--no-fill-holes',
    '--deskew-limit', String(params.deskewLimit),
    '--hole-min-mm', String(params.holeMinMm),
    '--hole-max-mm', String(params.holeMaxMm),
    '--dark-threshold', String(params.darkThreshold),
    '--device', params.device,
    '--background', colorToRgb(params.background),
  ];

  // stdout/stderr inherited so the helper's per-page progress streams through.
  await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Python stage failed (exit ${code}).`))
    );
  });
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
 * @param {boolean} options.cleanEdges  Remove dark scanner-bed bars.
 * @param {number} options.edgeFuzz     Edge-bar detection tolerance (percent).
 * @param {boolean} options.smart       Use the Python deskew/hole-fill stage.
 * @param {boolean} options.fillHoles   Detect and inpaint punch holes (LaMa).
 * @param {number} options.deskewLimit  Max skew angle searched (degrees).
 * @param {number} options.holeMinMm    Smallest punch-hole diameter (mm).
 * @param {number} options.holeMaxMm    Largest punch-hole diameter (mm).
 * @param {number} options.darkThreshold Darkness cutoff for hole detection.
 * @param {string} options.pythonBin    Python interpreter to use.
 * @param {string} options.device       Torch device for LaMa (cpu/cuda).
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
    smart,
    fillHoles,
    deskewLimit,
    holeMinMm,
    holeMaxMm,
    darkThreshold,
    pythonBin,
    device,
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

  // Decide whether the AI/Python stage (robust deskew + LaMa hole-fill) is usable.
  let usePython = false;
  if (smart && (deskew || fillHoles)) {
    usePython = await detectPython(pythonBin, fillHoles);
    if (!usePython) {
      log(
        fillHoles
          ? '  Note: Python AI stage unavailable — falling back to ImageMagick deskew; ' +
              'punch holes will NOT be filled. (Use the Docker image, or install ' +
              'python3 + opencv + torch + simple-lama-inpainting.)'
          : '  Note: Python deskew stage unavailable — falling back to ImageMagick deskew.'
      );
    }
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'pdf-cut-'));
  const halvesDir = path.join(workDir, 'halves');
  const edgesDir = path.join(workDir, 'edges');
  const smartDir = path.join(workDir, 'smart');
  const finalDir = path.join(workDir, 'final');
  await mkdir(halvesDir);
  await mkdir(edgesDir);
  await mkdir(smartDir);
  await mkdir(finalDir);

  const pad = (n) => String(n + 1).padStart(5, '0');

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

    // Stage 1 — rotate + remove dark scanner-bed edges (parallel).
    log(`Cleaning edges of ${rawPages.length} page(s) (clean-edges=${cleanEdges}, jobs=${jobs})...`);
    const edged = await mapPool(rawPages, jobs, async (src, i) => {
      const dest = path.join(edgesDir, `page-${pad(i)}.png`);
      await imEdgeClean(magick, src, dest, { rotate, cleanEdges, edgeFuzz, background });
      return dest;
    });

    // Stage 2 — straighten and fill punch holes.
    let processed;
    if (usePython) {
      log(
        `Smart stage: text-based deskew=${deskew}, AI hole-fill=${fillHoles} (this can take a moment)...`
      );
      const pairs = edged.map((src, i) => ({
        input: src,
        output: path.join(smartDir, `page-${pad(i)}.png`),
      }));
      await runPythonStage(
        pythonBin,
        pairs,
        { dpi, deskew, fillHoles, deskewLimit, holeMinMm, holeMaxMm, darkThreshold, device, background },
        workDir
      );
      processed = pairs.map((p) => p.output);
    } else {
      log(`Deskewing ${edged.length} page(s) (ImageMagick, deskew=${deskew})...`);
      processed = await mapPool(edged, jobs, async (src, i) => {
        const dest = path.join(smartDir, `page-${pad(i)}.png`);
        await imDeskew(magick, src, dest, { deskew, deskewThreshold, background });
        return dest;
      });
    }

    // Stage 3 — trim margins + add border (parallel).
    log(`Trimming and bordering ${processed.length} page(s) (trim=${trim})...`);
    const finalPages = await mapPool(processed, jobs, async (src, i) => {
      const dest = path.join(finalDir, `page-${pad(i)}.png`);
      await imFinish(magick, src, dest, { trim, fuzz, border, background });
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
