import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { generateCoverImage } from '../ai/gemini.js';
import { run as exec } from '../util/exec.js';
import { pxToMm } from '../img/geometry.js';
import { log } from '../util/log.js';

// The cover scan (scan 1) bypasses the book pipeline entirely: it is one
// continuous piece of artwork (back cover + spine + front cover) that gets
// recreated by AI as a single full-color image and written to its OWN PDF.
export const aiStage = false;

export function params(ctx) {
  return {
    cover: ctx.cfg.cover,
    model: ctx.cfg.models.cover,
    prompt: ctx.opts.coverPrompt || null,
    dpi: ctx.cfg.dpi,
    skipAi: Boolean(ctx.opts.skipAi),
    out: ctx.opts.coverOut || null,
    noCover: Boolean(ctx.opts.noCover)
  };
}

const SUPPORTED_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function nearestAspectRatio(w, h) {
  const target = w / h;
  let best = SUPPORTED_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of SUPPORTED_RATIOS) {
    const [a, b] = r.split(':').map(Number);
    const diff = Math.abs(a / b - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

const DEFAULT_PROMPT =
  'Recreate this complete scanned book cover — back cover, spine and front cover as one continuous ' +
  'piece of artwork — as a vibrant, full-color, print-quality image. Faithfully preserve ALL text ' +
  'exactly as printed (titles, subtitles, blurbs, publisher logos), the typography, and the layout ' +
  'and composition of the illustration. Use a period-appropriate illustration style matching the ' +
  'era of the book. Output only the cover artwork, edge to edge: no scanning artifacts, no punch ' +
  'holes, no page border, no library stickers.';

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function run(ctx, io) {
  if (ctx.opts.noCover) {
    log.stage('cover', 'skipped (--no-cover)');
    return;
  }
  const srcPath = path.join(stageDir(ctx.workdir, 'rasterize'), 'scan-0001.png');
  if (!(await exists(srcPath))) {
    log.warn('cover: scan 1 not rasterized (page range excludes it?) — no cover PDF produced');
    return;
  }
  const outPdf = path.resolve(ctx.opts.coverOut);
  if (io.isDone('cover') && (await exists(outPdf))) return;

  const meta = await sharp(srcPath).metadata();
  const jpgPath = path.join(io.dir, 'cover.jpg');

  if (ctx.opts.skipAi) {
    log.stage('cover', 'offline mode — using the original scan as cover image');
    await sharp(srcPath)
      .jpeg({ quality: ctx.cfg.cover.jpegQuality, chromaSubsampling: '4:4:4' })
      .toFile(jpgPath);
  } else {
    const refPng = await sharp(srcPath)
      .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const aspectRatio = nearestAspectRatio(meta.width, meta.height);
    log.stage('cover', `generating cover (${ctx.cfg.models.cover}, ${aspectRatio}, ${ctx.cfg.cover.imageSize})`);
    const aiImage = await generateCoverImage(refPng, {
      model: ctx.cfg.models.cover,
      prompt: ctx.opts.coverPrompt || DEFAULT_PROMPT,
      aspectRatio,
      imageSize: ctx.cfg.cover.imageSize
    });
    await sharp(aiImage)
      .resize(meta.width, meta.height, { fit: 'cover', position: 'centre' })
      .sharpen({ sigma: 1 })
      .jpeg({ quality: ctx.cfg.cover.jpegQuality, chromaSubsampling: '4:4:4' })
      .toFile(jpgPath);
  }

  const wMm = pxToMm(meta.width, ctx.cfg.dpi).toFixed(2);
  const hMm = pxToMm(meta.height, ctx.cfg.dpi).toFixed(2);
  await fs.mkdir(path.dirname(outPdf), { recursive: true });
  await exec('img2pdf', ['--pagesize', `${wMm}mmx${hMm}mm`, '-o', outPdf, jpgPath]);

  if (ctx.debug) {
    await ctx.debug.addSideBySide('cover', 'cover', [
      { input: srcPath, title: 'scan' },
      { input: jpgPath, title: ctx.opts.skipAi ? 'fallback (scan)' : 'AI recreation' }
    ], { meta: { out: outPdf, sizeMm: `${wMm}x${hMm}` } });
  }
  io.done('cover', { out: outPdf, ai: !ctx.opts.skipAi });
  log.stage('cover', `${outPdf} (${wMm}x${hMm} mm)`);
}
