import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { toGrayRaw, detectSkew } from '../img/projection.js';
import { analyzeContent } from '../img/content.js';
import { registerToWindow } from '../img/register.js';
import { mmToPx } from '../img/geometry.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return {
    dpi: ctx.cfg.dpi,
    deskew: ctx.cfg.deskew,
    source: ctx.opts.skipAi ? 'preclean' : 'inpaint',
    window: ctx.window || null
  };
}

// Rotate by `deg` (clockwise, same convention as sharp.rotate) with a
// high-quality interpolator, then crop back to the original size.
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

// Runs late in the pipeline, on pages already cleaned of residue and punch
// holes, so the projection profile sees nothing but real content. After the
// rotation the content box is measured again and re-registered into the
// window — registration on still-skewed content (preclean) is only
// approximate.
export async function run(ctx, io) {
  const sourceStage = ctx.opts.skipAi ? 'preclean' : 'inpaint';
  const srcDir = stageDir(ctx.workdir, sourceStage);
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();
  const win = ctx.window;
  if (!win) throw new Error('deskew: page window unknown (run preclean first)');
  const pad = mmToPx(ctx.cfg.preclean.keepPadMm, ctx.cfg.dpi);
  const angles = {};

  for (const file of pages) {
    const key = file.replace('.png', '');
    if (io.isDone(key)) {
      angles[key] = io.manifest.items[key].angle;
      continue;
    }
    const srcPath = path.join(srcDir, file);
    // Full-bleed covers: dark-pixel projection profiles are meaningless on
    // white-on-black artwork — pass through unchanged.
    if (key.startsWith('page-0001')) {
      await fs.copyFile(srcPath, path.join(io.dir, file));
      angles[key] = 0;
      io.done(key, { angle: 0, cover: true });
      log.stage('deskew', `${key}: cover, passed through`);
      continue;
    }
    const meta = await sharp(srcPath).metadata();
    const analysisMaxDim = Math.max(
      200,
      Math.round((Math.max(meta.width, meta.height) * ctx.cfg.deskew.analysisDpi) / ctx.cfg.dpi)
    );
    const raw = await toGrayRaw(srcPath, { maxDim: analysisMaxDim });
    const { angle, inkPx } = detectSkew(raw, ctx.cfg.deskew);

    const outPath = path.join(io.dir, file);
    const straight =
      Math.abs(angle) < 0.01
        ? sharp(srcPath)
        : await rotateGray(srcPath, -angle, meta);
    const straightPng = await straight.grayscale().png().toBuffer();

    // Re-register the straightened content into the window.
    const regRaw = await toGrayRaw(straightPng, { maxDim: ctx.cfg.preclean.analysisMaxDim });
    const scale = meta.width / regRaw.width;
    const { bbox } = analyzeContent(regRaw, ctx.cfg.preclean);
    const fullBbox = bbox
      ? {
          x: Math.round(bbox.x * scale),
          y: Math.round(bbox.y * scale),
          w: Math.round(bbox.w * scale),
          h: Math.round(bbox.h * scale)
        }
      : null;
    await registerToWindow({ src: straightPng, bbox: fullBbox, window: win, pad, outPath });

    if (ctx.debug) {
      await ctx.debug.addSideBySide('deskew', key, [
        { input: srcPath, title: 'before' },
        { input: outPath, title: 'after (re-registered)' }
      ], {
        meta: { detectedSkewDeg: Number(angle.toFixed(3)), inkPx, bbox: fullBbox }
      });
    }

    angles[key] = Number(angle.toFixed(4));
    io.done(key, { angle: angles[key] });
    log.stage('deskew', `${key}: ${angle.toFixed(3)}°`);
  }

  await fs.writeFile(path.join(io.dir, 'angles.json'), JSON.stringify(angles, null, 2));
}
