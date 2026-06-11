import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { run as exec } from '../util/exec.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return {
    dpi: ctx.cfg.dpi,
    binarize: ctx.cfg.binarize,
    source: ctx.opts.skipAi ? 'preclean' : 'inpaint',
    window: ctx.window || null
  };
}

// Always-ink floor: pixels darker than this are ink regardless of the local
// mean (keeps the inside of large solid black areas from hollowing out).
const ABSOLUTE_DARK = 96;

function despeckle(ink, width, height, maxArea) {
  const visited = new Uint8Array(ink.length);
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || visited[start]) continue;
    const component = [start];
    visited[start] = 1;
    for (let head = 0; head < component.length; head++) {
      const i = component[head];
      const x = i % width;
      const y = (i / width) | 0;
      for (const n of [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1
      ]) {
        if (n >= 0 && ink[n] && !visited[n]) {
          visited[n] = 1;
          component.push(n);
        }
      }
    }
    if (component.length <= maxArea) {
      for (const i of component) ink[i] = 0;
    }
  }
}

export async function run(ctx, io) {
  const cfg = ctx.cfg.binarize;
  const sourceStage = ctx.opts.skipAi ? 'preclean' : 'inpaint';
  const srcDir = stageDir(ctx.workdir, sourceStage);
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();
  const dpiScale = (ctx.cfg.dpi / 600) ** 2;
  const maxArea = Math.max(1, Math.round(cfg.despeckleMaxAreaAt600dpi * dpiScale));

  for (const file of pages) {
    const key = file.replace('.png', '');
    if (io.isDone(key)) continue;
    const srcPath = path.join(srcDir, file);
    const { data, info } = await sharp(srcPath).grayscale().raw().toBuffer({ resolveWithObject: true });
    const blurred = await sharp(srcPath).grayscale().blur(cfg.blurSigma).raw().toBuffer();

    const n = info.width * info.height;
    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      ink[i] = data[i] < ABSOLUTE_DARK || data[i] < blurred[i] - cfg.offset ? 1 : 0;
    }
    despeckle(ink, info.width, info.height, maxArea);

    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = ink[i] ? 0 : 255;
    const outPath = path.join(io.dir, `${key}.tif`);
    // sharp's prebuilt libvips cannot write 1-bit TIFFs; the pixels are
    // already strictly 0/255, so ImageMagick converts losslessly to G4.
    const tmpPng = path.join(io.dir, `${key}.tmp.png`);
    await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } })
      .png()
      .toFile(tmpPng);
    await exec('convert', [
      '-density', String(ctx.cfg.dpi),
      '-units', 'PixelsPerInch',
      tmpPng,
      '-type', 'Bilevel',
      '-compress', 'Group4',
      outPath
    ]);
    await fs.rm(tmpPng);

    if (ctx.debug) {
      await ctx.debug.addSideBySide('binarize', key, [
        { input: srcPath, title: 'grayscale' },
        { input: outPath, title: '1-bit G4' }
      ], { meta: { maxSpeckleArea: maxArea } });
    }
    io.done(key);
    log.stage('binarize', `${key}.tif`);
  }
}
