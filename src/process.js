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

/** Read a PNG's pixel dimensions via ImageMagick `identify`. */
async function getSize(magick, file) {
  const { cmd, args } = withBase(magick.identify, ['-format', '%w %h', file]);
  const { stdout } = await run(cmd, args);
  const [w, h] = stdout.trim().split(/\s+/).map(Number);
  return { w, h };
}

/** Mean brightness (0=black .. 1=white) of an explicit crop region of the sheet. */
async function stripBrightness(magick, sheet, geometry) {
  const { cmd, args } = withBase(magick.convert, [
    sheet,
    '-colorspace', 'Gray',
    '-crop', geometry,
    '+repage',
    '-format', '%[fx:mean]',
    'info:',
  ]);
  const { stdout } = await run(cmd, args);
  return parseFloat(stdout.trim());
}

/**
 * Decide which way to cut a two-up sheet. The reliable signal is the *gutter*:
 * the empty band between the two book pages has far less ink than a band cut
 * through text. We compare a centered vertical strip (would be the gutter when
 * the pages are side by side → cut left/right) against a centered horizontal
 * strip (the gutter when the pages are stacked → cut top/bottom) and split along
 * whichever central band is emptier/brighter. Aspect ratio is only a tie-break,
 * because it is unreliable (e.g. two tall pages side by side make a portrait
 * sheet that must still be cut left/right). 'lr'/'tb' force the choice.
 */
async function chooseAxis(magick, sheet, axis, w, h) {
  if (axis === 'lr' || axis === 'tb') return axis;
  // Single centered strips (explicit WxH+X+Y so ImageMagick doesn't tile).
  const vw = Math.max(1, Math.round(w * 0.08));
  const hh = Math.max(1, Math.round(h * 0.08));
  const vertical = await stripBrightness(magick, sheet, `${vw}x${h}+${Math.round((w - vw) / 2)}+0`);
  const horizontal = await stripBrightness(magick, sheet, `${w}x${hh}+0+${Math.round((h - hh) / 2)}`);
  // The gutter band is brighter (emptier); even a small but consistent margin is
  // meaningful. Only fall back to aspect ratio when the two are all but equal.
  if (Math.abs(vertical - horizontal) < 0.004) return w >= h ? 'lr' : 'tb';
  return vertical > horizontal ? 'lr' : 'tb';
}

/**
 * Split a two-up sheet into its two book pages along the detected gutter axis
 * (see chooseAxis): side-by-side pages are cut left/right, stacked pages
 * top/bottom. Cutting the wrong axis leaves two pages on every output page
 * ("double pages") or a full-height sliver ("double height").
 *
 * `axis` forces a choice: 'auto' (default), 'lr' (left/right), or 'tb' (top/bottom).
 * Returns the produced file paths in reading order plus what was decided.
 */
async function splitSheet(magick, sheet, outDir, { rightToLeft, axis }) {
  const { w, h } = await getSize(magick, sheet);
  const used = await chooseAxis(magick, sheet, axis, w, h);

  const outPattern = path.join(outDir, 'half-%d.png');
  // lr: 50%x100% → tile 0 = left, tile 1 = right.
  // tb: 100%x50% → tile 0 = top,  tile 1 = bottom.
  const geometry = used === 'lr' ? '50%x100%' : '100%x50%';
  const { cmd, args } = withBase(magick.convert, [
    sheet,
    '-crop',
    geometry,
    '+repage',
    '+adjoin',
    outPattern,
  ]);
  await run(cmd, args);

  const first = path.join(outDir, 'half-0.png');
  const second = path.join(outDir, 'half-1.png');
  // Top/bottom is always read top-then-bottom; only left/right honors RTL.
  const halves = used === 'lr' && rightToLeft ? [second, first] : [first, second];
  return { halves, w, h, used };
}

/**
 * Stage 1 — rotate sideways scans and (fallback only) remove dark scanner-bed
 * bars by flood-filling inward from each corner. When the Python stage is
 * available it does detection-based residue removal instead, so this flood-fill
 * runs only when Python is missing. flip/flop brings each corner to (0,0) in
 * turn and the four transforms compose back to the original orientation.
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

/**
 * Stage 3 — final touch-ups only. By default this changes nothing about the
 * page geometry: each page keeps the exact pixel size it had after the split.
 * Trim and border are strictly opt-in (and do change size when used).
 */
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
async function detectPython(pythonBin) {
  const check = async (flag) => {
    try {
      const { stdout } = await run(pythonBin, [PY_SCRIPT, '--check', flag]);
      return stdout.trim() === 'ok';
    } catch {
      return false;
    }
  };
  if (!existsSync(PY_SCRIPT)) return { available: false, canFillHoles: false };
  // OpenCV alone covers residue removal + deskew; torch/LaMa adds hole-filling.
  const available = await check('--no-fill-holes');
  const canFillHoles = available ? await check('--fill-holes') : false;
  return { available, canFillHoles };
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
    params.cleanEdges ? '--clean-edges' : '--no-clean-edges',
    params.deskew ? '--deskew' : '--no-deskew',
    params.fillHoles ? '--fill-holes' : '--no-fill-holes',
    '--deskew-limit', String(params.deskewLimit),
    '--hole-min-mm', String(params.holeMinMm),
    '--hole-max-mm', String(params.holeMaxMm),
    '--dark-threshold', String(params.darkThreshold),
    '--residue-threshold', String(params.residueThreshold),
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
 * @param {string} options.splitAxis    Split axis: 'auto' | 'lr' | 'tb'.
 * @param {boolean} options.rightToLeft Order halves right→left.
 * @param {boolean} options.deskew      Auto-straighten each page.
 * @param {number} options.deskewThreshold  Deskew sensitivity (percent).
 * @param {number} options.rotate       Fixed rotation applied before deskew.
 * @param {boolean} options.trim        Crop scanner margins (off by default; breaks uniform size).
 * @param {number} options.fuzz         Trim color tolerance (percent).
 * @param {number} options.border       Uniform white border added to every page (pixels).
 * @param {string} options.background   Fill/border/trim color.
 * @param {boolean} options.cleanEdges  Remove dark scanner-bed bars.
 * @param {number} options.edgeFuzz     Edge-bar detection tolerance (percent).
 * @param {boolean} options.smart       Use the Python deskew/hole-fill stage.
 * @param {boolean} options.fillHoles   Detect and inpaint punch holes (LaMa).
 * @param {number} options.deskewLimit  Max skew angle searched (degrees).
 * @param {number} options.holeMinMm    Smallest punch-hole diameter (mm).
 * @param {number} options.holeMaxMm    Largest punch-hole diameter (mm).
 * @param {number} options.darkThreshold Darkness cutoff for hole detection.
 * @param {number} options.residueThreshold Darkness cutoff for residue detection.
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
    splitAxis,
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
    residueThreshold,
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

  // Decide whether the Python stage is usable. OpenCV alone covers detection-
  // based residue removal + text deskew; torch/LaMa adds punch-hole inpainting.
  let usePython = false;
  let effFillHoles = false;
  if (smart && (cleanEdges || deskew || fillHoles)) {
    const cap = await detectPython(pythonBin);
    usePython = cap.available;
    effFillHoles = fillHoles && cap.canFillHoles;
    if (!usePython) {
      log(
        '  Note: Python stage unavailable — falling back to ImageMagick edge flood-fill ' +
          '+ deskew; detection-based residue removal and punch-hole filling are skipped. ' +
          '(Use the Docker image, or install python3 + opencv [+ torch + simple-lama-inpainting].)'
      );
    } else if (fillHoles && !cap.canFillHoles) {
      log(
        '  Note: OpenCV present but torch/LaMa missing — residue removal and deskew are ' +
          'active, but punch holes will NOT be filled.'
      );
    }
  }
  // The Python stage handles residue detection in place; only fall back to the
  // ImageMagick corner flood-fill when Python is unavailable.
  const imFloodFill = cleanEdges && !usePython;

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
        const { halves, w, h, used } = await splitSheet(magick, sheets[i], sheetDir, {
          rightToLeft,
          axis: splitAxis,
        });
        log(`  sheet ${i + 1}: ${w}x${h}px → ${used === 'lr' ? 'left/right' : 'top/bottom'}`);
        rawPages.push(...halves);
      }
    } else {
      rawPages.push(...sheets);
    }

    // Stage 1 — rotate (+ ImageMagick edge flood-fill only as a fallback).
    log(`Preparing ${rawPages.length} page(s) (rotate=${rotate || 0}, jobs=${jobs})...`);
    const edged = await mapPool(rawPages, jobs, async (src, i) => {
      const dest = path.join(edgesDir, `page-${pad(i)}.png`);
      await imEdgeClean(magick, src, dest, { rotate, cleanEdges: imFloodFill, edgeFuzz, background });
      return dest;
    });

    // Stage 2 — detection-based residue removal, deskew, and hole-fill (all in
    // place, so page dimensions are preserved).
    let processed;
    if (usePython) {
      log(
        `Smart stage: residue-clean=${cleanEdges}, text-deskew=${deskew}, ` +
          `AI hole-fill=${effFillHoles} (this can take a moment)...`
      );
      const pairs = edged.map((src, i) => ({
        input: src,
        output: path.join(smartDir, `page-${pad(i)}.png`),
      }));
      await runPythonStage(
        pythonBin,
        pairs,
        {
          dpi, cleanEdges, deskew, fillHoles: effFillHoles, deskewLimit,
          holeMinMm, holeMaxMm, darkThreshold, residueThreshold, device, background,
        },
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

    // Stage 3 — final touch-ups (size-preserving by default).
    log(`Finishing ${processed.length} page(s) (trim=${trim}, border=${border})...`);
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
