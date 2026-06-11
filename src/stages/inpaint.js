import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { mmToPx } from '../img/geometry.js';
import { pythonAvailable, runPythonOp } from '../util/pythonStage.js';
import { log } from '../util/log.js';

// Punch-hole repair: OpenCV detects solid round dark blobs in the expected
// physical size range (a morphological opening first erases text strokes, so
// holes overlapping a header still present their round core), then LaMa
// inpaints a small crop around each hole — only the masked pixels change.
// Local and deterministic; no remote AI involved. Falls back to a passthrough
// copy when the python/torch toolchain is unavailable.
export const aiStage = false;

export function params(ctx) {
  return { inpaint: ctx.cfg.inpaint, dpi: ctx.cfg.dpi, window: ctx.window || null };
}

export async function run(ctx, io) {
  const cfg = ctx.cfg.inpaint;
  const srcDir = stageDir(ctx.workdir, 'preclean');
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();
  const pending = pages.filter((f) => !io.isDone(f.replace('.png', '')));
  if (pending.length === 0) return;

  if (!(await pythonAvailable({ needLama: true }))) {
    log.warn('inpaint: OpenCV/LaMa toolchain unavailable — punch holes are left as-is');
    for (const file of pending) {
      await fs.copyFile(path.join(srcDir, file), path.join(io.dir, file));
      io.done(file.replace('.png', ''), { skipped: true });
    }
    return;
  }

  log.stage('inpaint', `detecting + LaMa-filling punch holes on ${pending.length} page(s)`);
  const results = await runPythonOp(
    'holes',
    pending.map((file) => ({
      key: file.replace('.png', ''),
      input: path.join(srcDir, file),
      output: path.join(io.dir, file),
      debugPrefix: ctx.debug ? path.join(io.dir, file.replace('.png', '')) : undefined
    })),
    {
      dpi: ctx.cfg.dpi,
      'hole-min-mm': cfg.holeMinMm,
      'hole-max-mm': cfg.holeMaxMm,
      'hole-circularity': cfg.holeCircularity,
      'hole-solidity': cfg.holeSolidity,
      'hole-dilate': cfg.holeDilate,
      'dark-threshold': cfg.darkThreshold,
      context: mmToPx(cfg.contextMm, ctx.cfg.dpi)
    }
  );

  for (const file of pending) {
    const key = file.replace('.png', '');
    const r = results.get(key);
    if (!r) throw new Error(`inpaint: python helper returned no result for ${key}`);

    if (ctx.debug && r.holes.length) {
      const context = mmToPx(cfg.contextMm, ctx.cfg.dpi);
      const meta = await sharp(path.join(io.dir, file)).metadata();
      for (let i = 0; i < r.holes.length; i++) {
        const b = r.holes[i];
        const region = {
          left: Math.max(0, b.x - context),
          top: Math.max(0, b.y - context)
        };
        region.width = Math.min(meta.width, b.x + b.w + context) - region.left;
        region.height = Math.min(meta.height, b.y + b.h + context) - region.top;
        const composited = await sharp(path.join(io.dir, file)).extract(region).png().toBuffer();
        const panels = [];
        for (const [suffix, title] of [['patch', 'before'], ['mask', 'mask'], ['ai', 'LaMa result']]) {
          const p = path.join(io.dir, `${key}-${suffix}-${i}.png`);
          try {
            await fs.access(p);
            panels.push({ input: p, title });
          } catch {
            // hole crop produced no debug artifact (mask empty) — skip panel
          }
        }
        panels.push({ input: composited, title: 'composited' });
        await ctx.debug.addSideBySide('inpaint', key, panels, {
          meta: { hole: i, box: b },
          label: `hole-${i}`
        });
      }
    }

    io.done(key, { holes: r.holes.length, boxes: r.holes });
    if (r.holes.length) log.stage('inpaint', `${key}: filled ${r.holes.length} hole(s)`);
  }
}
