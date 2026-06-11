import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { run, pdfPageCount } from '../util/exec.js';
import { parsePageRange, scanId } from '../util/pages.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return { dpi: ctx.cfg.dpi, inputHash: ctx.inputHash, extract: ctx.opts.extract !== false };
}

// Scanner PDFs usually wrap one bitmap per page, often on a larger (portrait)
// page canvas that scales the image down. Extracting that bitmap directly
// gives the true native-resolution pixels with no page whitespace and no
// resampling. Returns null when the page is not a single-image page.
async function extractEmbeddedImage(ctx, p, outPath) {
  const { stdout } = await run('pdfimages', ['-list', '-f', String(p), '-l', String(p), ctx.input]);
  const rows = stdout
    .split('\n')
    .slice(2) // header + separator
    .filter((l) => l.trim().length > 0);
  if (rows.length !== 1) return null;
  const cols = rows[0].trim().split(/\s+/);
  // page num type width height color comp bpc enc interp object ID x-ppi y-ppi ...
  const type = cols[2];
  const xPpi = Number(cols[12]);
  if (type !== 'image') return null;

  const prefix = path.join(path.dirname(outPath), `extract-${p}`);
  await run('pdfimages', ['-png', '-f', String(p), '-l', String(p), ctx.input, prefix]);
  const produced = (await fs.readdir(path.dirname(outPath))).find(
    (f) => f.startsWith(`extract-${p}-`) && f.endsWith('.png')
  );
  if (!produced) return null;
  const extractedPath = path.join(path.dirname(outPath), produced);

  // Honor the page's /Rotate so the output matches the rendered orientation.
  const { stdout: info } = await run('pdfinfo', ['-f', String(p), '-l', String(p), ctx.input]);
  const rot = Number(info.match(/rot:\s+(\d+)/)?.[1] || 0);

  let img = sharp(extractedPath).grayscale();
  if (rot) img = img.rotate(rot);
  await img.png().toFile(outPath);
  await fs.rm(extractedPath);

  if (Number.isFinite(xPpi) && xPpi > 0 && Math.abs(xPpi - ctx.cfg.dpi) / ctx.cfg.dpi > 0.05) {
    log.warn(
      `rasterize: page ${p} embedded image is ${xPpi} ppi but --dpi is ${ctx.cfg.dpi}; ` +
        `physical sizes will be off — re-run with --dpi ${xPpi}`
    );
  }
  return { xPpi, rot };
}

export async function run_(ctx, io) {
  const total = await pdfPageCount(ctx.input);
  const pages = parsePageRange(ctx.opts.pages, total) || Array.from({ length: total }, (_, i) => i + 1);

  for (const p of pages) {
    const key = scanId(p);
    if (io.isDone(key)) continue;
    const outPath = path.join(io.dir, `${key}.png`);

    if (ctx.opts.extract !== false) {
      let extracted = null;
      try {
        extracted = await extractEmbeddedImage(ctx, p, outPath);
      } catch (err) {
        log.warn(`rasterize: image extraction failed for page ${p} (${err.message}) — rendering instead`);
      }
      if (extracted) {
        io.done(key, { method: 'extract', ...extracted });
        log.stage('rasterize', `${key}.png (extracted embedded image, ${extracted.xPpi || '?'} ppi)`);
        continue;
      }
    }

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
    await fs.rename(path.join(io.dir, produced), outPath);
    io.done(key, { method: 'render' });
    log.stage('rasterize', `${key}.png (rendered at ${ctx.cfg.dpi} dpi)`);
  }
}

export { run_ as run };
