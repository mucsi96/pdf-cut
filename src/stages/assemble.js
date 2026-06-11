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
    out: ctx.opts.out,
    window: ctx.window || null
  };
}

// Assemble the book pages (the cover lives in its own PDF, see the cover
// stage). Grayscale PNGs are embedded losslessly by img2pdf.
export async function run(ctx, io) {
  const srcDir = stageDir(ctx.workdir, 'deskew');
  const pngs = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();
  if (pngs.length === 0) throw new Error('assemble: no processed pages found');

  const scans = [...new Set(pngs.map((f) => Number(f.match(/\d{4}/)[0])))].sort((a, b) => a - b);
  const sides = ctx.opts.swapOrder ? ['R', 'L'] : ['L', 'R'];
  const files = [];
  for (const scan of scans) {
    for (const side of sides) {
      const f = path.join(srcDir, `page-${String(scan).padStart(4, '0')}-${side}.png`);
      try {
        await fs.access(f);
        files.push(f);
      } catch {
        // half page missing (partial run) — skip
      }
    }
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
