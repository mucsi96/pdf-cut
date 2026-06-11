import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { toGrayRaw, detectGutter } from '../img/projection.js';
import { mmToPx } from '../img/geometry.js';
import { pageKey } from '../util/pages.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return { dpi: ctx.cfg.dpi, split: ctx.cfg.split };
}

const ANALYSIS_MAX_DIM = 2000;

export async function run(ctx, io) {
  const srcDir = stageDir(ctx.workdir, 'rasterize');
  const scans = (await fs.readdir(srcDir)).filter((f) => /^scan-\d{4}\.png$/.test(f)).sort();

  for (const file of scans) {
    const scanNum = Number(file.match(/\d{4}/)[0]);
    const key = `scan-${file.match(/\d{4}/)[0]}`;
    if (io.isDone(key)) continue;

    const srcPath = path.join(srcDir, file);
    const meta = await sharp(srcPath).metadata();
    const raw = await toGrayRaw(srcPath, { maxDim: ANALYSIS_MAX_DIM });
    const gutter = detectGutter(raw, {
      ...ctx.cfg.split,
      minRunPx: Math.max(2, (mmToPx(ctx.cfg.split.minGutterRunMm, ctx.cfg.dpi) * raw.width) / meta.width)
    });
    const splitX = Math.round((gutter.x / raw.width) * meta.width);

    for (const [side, region] of [
      ['L', { left: 0, top: 0, width: splitX, height: meta.height }],
      ['R', { left: splitX, top: 0, width: meta.width - splitX, height: meta.height }]
    ]) {
      await sharp(srcPath)
        .extract(region)
        .png()
        .toFile(path.join(io.dir, `${pageKey(scanNum, side)}.png`));
    }

    if (ctx.debug) {
      const sx = gutter.x;
      const profilePts = [];
      for (let x = 0; x < raw.width; x += 2) {
        profilePts.push(`${x},${Math.round(raw.height - gutter.profile[x] * raw.height * 0.9)}`);
      }
      const svg = `<svg width="${raw.width}" height="${raw.height}" xmlns="http://www.w3.org/2000/svg">
        <polyline points="${profilePts.join(' ')}" fill="none" stroke="#00a0ff" stroke-width="3"/>
        <line x1="${sx}" y1="0" x2="${sx}" y2="${raw.height}" stroke="red" stroke-width="4"/>
      </svg>`;
      await ctx.debug.add('split', key, {
        image: await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 1 } })
          .toColourspace('srgb')
          .composite([{ input: Buffer.from(svg) }])
          .png()
          .toBuffer(),
        label: 'gutter',
        meta: {
          splitX,
          fallbackMidpoint: gutter.fallback,
          valleyContrast: Number(gutter.contrast.toFixed(3))
        }
      });
    }

    io.done(key, { splitX, fallback: gutter.fallback });
    log.stage('split', `${key} → L/R at x=${splitX}${gutter.fallback ? ' (midpoint fallback)' : ''}`);
  }
}
