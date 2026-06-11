import path from 'node:path';
import fs from 'node:fs/promises';
import { run, pdfPageCount } from '../util/exec.js';
import { parsePageRange, scanId } from '../util/pages.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return { dpi: ctx.cfg.dpi, inputHash: ctx.inputHash };
}

export async function run_(ctx, io) {
  const total = await pdfPageCount(ctx.input);
  const pages = parsePageRange(ctx.opts.pages, total) || Array.from({ length: total }, (_, i) => i + 1);

  for (const p of pages) {
    const key = scanId(p);
    if (io.isDone(key)) continue;
    const prefix = path.join(io.dir, `tmp-${p}`);
    await run('pdftoppm', [
      '-gray', '-png',
      '-r', String(ctx.cfg.dpi),
      '-f', String(p), '-l', String(p),
      ctx.input, prefix
    ]);
    // pdftoppm appends a page-number suffix of varying width; find it.
    const produced = (await fs.readdir(io.dir)).find(
      (f) => f.startsWith(`tmp-${p}-`) && f.endsWith('.png')
    );
    if (!produced) throw new Error(`pdftoppm produced no output for page ${p}`);
    await fs.rename(path.join(io.dir, produced), path.join(io.dir, `${key}.png`));
    io.done(key);
    log.stage('rasterize', `${key}.png (${ctx.cfg.dpi} dpi)`);
  }
}

export { run_ as run };
