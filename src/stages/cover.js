import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { generateCoverImage } from '../ai/gemini.js';
import { pageKey } from '../util/pages.js';
import { log } from '../util/log.js';

export const aiStage = true;

export function params(ctx) {
  return {
    cover: ctx.cfg.cover,
    model: ctx.cfg.models.cover,
    backCover: Boolean(ctx.opts.backCover),
    prompt: ctx.opts.coverPrompt || null,
    window: ctx.window || null
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
  'Recreate this scanned black-and-white book cover as a vibrant, full-color, print-quality book ' +
  'cover. Faithfully preserve ALL text exactly as printed (titles, subtitles, publisher logos), the ' +
  'typography, and the layout and composition of the illustration. Use a period-appropriate ' +
  'illustration style matching the era of the book. Output only the cover artwork, edge to edge: no ' +
  'scanning artifacts, no punch holes, no page border, no library stickers.';

export async function run(ctx, io) {
  // Use the raw split scan halves as reference for the AI: the cover is
  // full-bleed, so preclean/deskew would have blanked or clipped it.
  const refDir = stageDir(ctx.workdir, 'split');
  const targets = [['front', 'R'], ...(ctx.opts.backCover ? [['back', 'L']] : [])];

  // Output size = the registered page window so assemble can mix it with pages.
  const win = ctx.window;
  if (!win) throw new Error('cover: preclean stage must run first (page window unknown)');

  for (const [name, side] of targets) {
    if (io.isDone(name)) continue;
    const refPath = path.join(refDir, `${pageKey(1, side)}.png`);
    try {
      await fs.access(refPath);
    } catch {
      log.warn(`cover: ${refPath} missing (scan 1 not processed) — skipping ${name} cover`);
      continue;
    }

    const refPng = await sharp(refPath)
      .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const aspectRatio = nearestAspectRatio(win.w, win.h);
    log.stage('cover', `generating ${name} cover (${ctx.cfg.models.cover}, ${aspectRatio}, ${ctx.cfg.cover.imageSize})`);
    const aiImage = await generateCoverImage(refPng, {
      model: ctx.cfg.models.cover,
      prompt: ctx.opts.coverPrompt || DEFAULT_PROMPT,
      aspectRatio,
      imageSize: ctx.cfg.cover.imageSize
    });

    const outPath = path.join(io.dir, `${name}.jpg`);
    await sharp(aiImage)
      .resize(win.w, win.h, { fit: 'cover', position: 'centre' })
      .sharpen({ sigma: 1 })
      .jpeg({ quality: ctx.cfg.cover.jpegQuality, chromaSubsampling: '4:4:4' })
      .toFile(outPath);

    if (ctx.debug) {
      await ctx.debug.addSideBySide('cover', `cover-${name}`, [
        { input: refPath, title: 'scan reference' },
        { input: outPath, title: 'AI recreation' }
      ], { meta: { aspectRatio, imageSize: ctx.cfg.cover.imageSize } });
    }
    io.done(name);
    log.stage('cover', `${name}.jpg (${win.w}x${win.h})`);
  }
}
