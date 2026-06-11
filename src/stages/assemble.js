import path from 'node:path';
import fs from 'node:fs/promises';
import { stageDir } from '../config.js';
import { run as exec } from '../util/exec.js';
import { pxToMm } from '../img/geometry.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return {
    dpi: ctx.cfg.dpi,
    swapOrder: Boolean(ctx.opts.swapOrder),
    backCover: Boolean(ctx.opts.backCover),
    skipAi: Boolean(ctx.opts.skipAi),
    out: ctx.opts.out,
    window: ctx.window || null
  };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function run(ctx, io) {
  const binDir = stageDir(ctx.workdir, 'binarize');
  const coverDir = stageDir(ctx.workdir, 'cover');
  const tifs = (await fs.readdir(binDir)).filter((f) => /^page-\d{4}-[LR]\.tif$/.test(f)).sort();
  if (tifs.length === 0) throw new Error('assemble: no binarized pages found');

  const scans = [...new Set(tifs.map((f) => Number(f.match(/\d{4}/)[0])))].sort((a, b) => a - b);
  const sides = ctx.opts.swapOrder ? ['R', 'L'] : ['L', 'R'];
  const pageFile = (scan, side) => path.join(binDir, `page-${String(scan).padStart(4, '0')}-${side}.tif`);

  const files = [];
  const hasCoverScan = scans.includes(1);
  if (hasCoverScan) {
    const aiFront = path.join(coverDir, 'front.jpg');
    files.push((await exists(aiFront)) ? aiFront : pageFile(1, 'R'));
  }
  for (const scan of scans) {
    if (scan === 1) continue;
    for (const side of sides) {
      const f = pageFile(scan, side);
      if (await exists(f)) files.push(f);
    }
  }
  if (hasCoverScan && ctx.opts.backCover) {
    const aiBack = path.join(coverDir, 'back.jpg');
    files.push((await exists(aiBack)) ? aiBack : pageFile(1, 'L'));
  }

  const win = ctx.window;
  if (!win) throw new Error('assemble: page window unknown (run preclean first)');
  const wMm = pxToMm(win.w, ctx.cfg.dpi).toFixed(2);
  const hMm = pxToMm(win.h, ctx.cfg.dpi).toFixed(2);

  const outPath = path.resolve(ctx.opts.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await exec('img2pdf', ['--pagesize', `${wMm}mmx${hMm}mm`, '-o', outPath, ...files]);
  io.done('output', { pages: files.length, out: outPath });
  log.stage('assemble', `${outPath}: ${files.length} page(s) at ${wMm}x${hMm} mm`);
}
