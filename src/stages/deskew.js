import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { toGrayRaw, detectSkew } from '../img/projection.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return { dpi: ctx.cfg.dpi, deskew: ctx.cfg.deskew };
}

// Rotate by `deg` (clockwise, same convention as sharp.rotate) with a
// high-quality interpolator, then crop back to the original size so scan-edge
// residue keeps touching the canvas border for the preclean stage.
export async function rotateGray(input, deg, { width, height }) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotated = await sharp(input)
    .affine([[cos, -sin], [sin, cos]], {
      interpolator: 'lbb',
      background: '#ffffff'
    })
    .toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.round((rotated.info.width - width) / 2));
  const top = Math.max(0, Math.round((rotated.info.height - height) / 2));
  return sharp(rotated.data)
    .extract({
      left,
      top,
      width: Math.min(width, rotated.info.width),
      height: Math.min(height, rotated.info.height)
    });
}

export async function run(ctx, io) {
  const srcDir = stageDir(ctx.workdir, 'split');
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();
  const angles = {};

  for (const file of pages) {
    const key = file.replace('.png', '');
    if (io.isDone(key)) {
      angles[key] = io.manifest.items[key].angle;
      continue;
    }
    const srcPath = path.join(srcDir, file);
    const meta = await sharp(srcPath).metadata();
    const analysisMaxDim = Math.max(
      200,
      Math.round((Math.max(meta.width, meta.height) * ctx.cfg.deskew.analysisDpi) / ctx.cfg.dpi)
    );
    const raw = await toGrayRaw(srcPath, { maxDim: analysisMaxDim });
    const { angle, inkPx } = detectSkew(raw, ctx.cfg.deskew);

    const outPath = path.join(io.dir, file);
    if (Math.abs(angle) < 0.01) {
      await fs.copyFile(srcPath, outPath);
    } else {
      const img = await rotateGray(srcPath, -angle, meta);
      await img.grayscale().png().toFile(outPath);
    }

    if (ctx.debug) {
      await ctx.debug.addSideBySide('deskew', key, [
        { input: srcPath, title: 'before' },
        { input: outPath, title: 'after' }
      ], {
        meta: { detectedSkewDeg: Number(angle.toFixed(3)), inkPx }
      });
    }

    angles[key] = Number(angle.toFixed(4));
    io.done(key, { angle: angles[key] });
    log.stage('deskew', `${key}: ${angle.toFixed(3)}°`);
  }

  await fs.writeFile(path.join(io.dir, 'angles.json'), JSON.stringify(angles, null, 2));
}
