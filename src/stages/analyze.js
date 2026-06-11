import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { stageDir } from '../config.js';
import * as gemini from '../ai/gemini.js';
import * as anthropic from '../ai/anthropic.js';
import { log } from '../util/log.js';

export const aiStage = true;

export function params(ctx) {
  return {
    analyze: ctx.cfg.analyze,
    provider: ctx.opts.visionProvider || 'gemini',
    model:
      (ctx.opts.visionProvider || 'gemini') === 'gemini'
        ? ctx.cfg.models.vision
        : ctx.cfg.models.anthropicVision,
    window: ctx.window || null
  };
}

export async function run(ctx, io) {
  const provider = ctx.opts.visionProvider === 'anthropic' ? anthropic : gemini;
  const model =
    ctx.opts.visionProvider === 'anthropic' ? ctx.cfg.models.anthropicVision : ctx.cfg.models.vision;
  const srcDir = stageDir(ctx.workdir, 'preclean');
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();
  const limit = pLimit(Number(ctx.opts.concurrency) || 4);

  await Promise.all(
    pages.map((file) =>
      limit(async () => {
        const key = file.replace('.png', '');
        if (io.isDone(key)) return;
        const srcPath = path.join(srcDir, file);
        const png = await sharp(srcPath)
          .resize(ctx.cfg.analyze.maxDim, ctx.cfg.analyze.maxDim, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .png()
          .toBuffer();
        const result = await provider.analyzePage(png, model);
        await fs.writeFile(path.join(io.dir, `${key}.json`), JSON.stringify(result, null, 2));

        if (ctx.debug) {
          const meta = await sharp(srcPath).metadata();
          const sw = 800 / meta.width;
          const rects = result.holes
            .map((hole) => {
              const x = (hole.box.xmin / 1000) * meta.width * sw;
              const y = (hole.box.ymin / 1000) * meta.height * sw;
              const w = ((hole.box.xmax - hole.box.xmin) / 1000) * meta.width * sw;
              const h = ((hole.box.ymax - hole.box.ymin) / 1000) * meta.height * sw;
              return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${hole.overText ? 'red' : 'orange'}" stroke-width="3"/>`;
            })
            .join('');
          const svg = `<svg width="800" height="${Math.round(meta.height * sw)}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
          await ctx.debug.add('analyze', key, {
            image: await sharp(srcPath)
              .resize(800)
              .toColourspace('srgb')
              .composite([{ input: Buffer.from(svg) }])
              .png()
              .toBuffer(),
            label: 'holes',
            meta: {
              holes: result.holes.length,
              overText: result.holes.filter((hole) => hole.overText).length,
              residualSkewDeg: result.residualSkewDeg,
              qualityFlags: result.qualityFlags
            }
          });
        }

        if (Math.abs(result.residualSkewDeg) > 0.15) {
          log.warn(`analyze: ${key} reports residual skew ${result.residualSkewDeg}° — consider --force deskew after tuning`);
        }
        io.done(key, { holes: result.holes.length });
        log.stage('analyze', `${key}: ${result.holes.length} hole(s)${result.qualityFlags.length ? `, flags: ${result.qualityFlags.join(',')}` : ''}`);
      })
    )
  );
}
