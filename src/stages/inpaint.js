import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { run } from '../exec.js';

export const name = 'inpaint';
export const dir = '70-inpaint';
export const configKey = 'inpaint';
export const title = 'LaMa-inpaint punch holes (patch based)';

/**
 * Full-page LaMa on ~35 MP pages is too slow on CPU, so we crop a square
 * patch around every detected hole, run ONE iopaint batch over all patches,
 * and paste the results back into the cleaned pages.
 */
export async function run_(ctx, { stageDir, params }) {
  const cleanDir = ctx.dir('clean');
  const holesDir = ctx.dir('detect-holes');
  const holesFile = path.join(holesDir, 'holes.json');
  const holes = fs.existsSync(holesFile) ? JSON.parse(fs.readFileSync(holesFile, 'utf8')) : {};

  const pageFiles = fs.readdirSync(cleanDir).filter((n) => /^page-\d{4}\.png$/.test(n)).sort();

  const patchDir = path.join(stageDir, 'patches');
  const imgDir = path.join(patchDir, 'img');
  const maskDir = path.join(patchDir, 'mask');
  const outDir = path.join(patchDir, 'out');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(maskDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Crop patches around every hole.
  const patches = [];
  for (const file of pageFiles) {
    const pageId = file.slice(5, 9);
    const pageHoles = holes[pageId] || [];
    if (!pageHoles.length) continue;
    const pagePath = path.join(cleanDir, file);
    const maskPath = path.join(holesDir, `mask-page-${pageId}.png`);
    const { width, height } = await sharp(pagePath).metadata();
    const size = Math.min(params.patchSize, width, height);

    for (let i = 0; i < pageHoles.length; i++) {
      const h = pageHoles[i];
      const left = clamp(Math.round(h.cx - size / 2), 0, width - size);
      const top = clamp(Math.round(h.cy - size / 2), 0, height - size);
      const id = `p-${pageId}-${i}`;
      await sharp(pagePath).extract({ left, top, width: size, height: size }).png().toFile(path.join(imgDir, `${id}.png`));
      await sharp(maskPath).extract({ left, top, width: size, height: size }).png().toFile(path.join(maskDir, `${id}.png`));
      patches.push({ id, pageId, left, top, size });
    }
  }

  if (!patches.length) {
    ctx.log('  inpaint: no holes detected — copying pages through');
    for (const file of pageFiles) fs.copyFileSync(path.join(cleanDir, file), path.join(stageDir, file));
    fs.rmSync(patchDir, { recursive: true, force: true });
    return { patches: [] };
  }

  // 2. One iopaint batch over all patches (torch startup is paid once).
  await run('iopaint', [
    'run',
    `--model=${params.model}`,
    `--device=${params.device}`,
    `--image=${imgDir}`,
    `--mask=${maskDir}`,
    `--output=${outDir}`,
    `--model-dir=${params.modelDir}`,
  ], { label: 'iopaint' });

  // 3. Paste patches back; copy untouched pages through.
  const byPage = new Map();
  for (const p of patches) {
    if (!byPage.has(p.pageId)) byPage.set(p.pageId, []);
    byPage.get(p.pageId).push(p);
  }

  for (const file of pageFiles) {
    const pageId = file.slice(5, 9);
    const src = path.join(cleanDir, file);
    const dst = path.join(stageDir, file);
    const pagePatches = byPage.get(pageId);
    if (!pagePatches) {
      fs.copyFileSync(src, dst);
      continue;
    }
    const { density } = await sharp(src).metadata();
    const composites = [];
    for (const p of pagePatches) {
      const outPatch = path.join(outDir, `${p.id}.png`);
      if (!fs.existsSync(outPatch)) throw new Error(`inpaint: iopaint did not produce ${p.id}.png`);
      composites.push({ input: await sharp(outPatch).grayscale().png().toBuffer(), left: p.left, top: p.top });
      // Debug: before/after pair for each patch.
      const before = path.join(imgDir, `${p.id}.png`);
      await run('montage', [before, outPatch, '-tile', '2x1', '-geometry', '+4+4',
        path.join(stageDir, 'debug', `patch-${p.id}.jpg`)], { quiet: true, allowFailure: true });
    }
    await sharp(src)
      .composite(composites)
      .png({ compressionLevel: 6 })
      .withMetadata({ density: density || ctx.config.extract.dpi })
      .toFile(dst);

    // Debug: full page with patch outlines.
    const { width, height } = await sharp(dst).metadata();
    const boxes = pagePatches
      .map((p) => `<rect x="${p.left}" y="${p.top}" width="${p.size}" height="${p.size}" fill="none" stroke="#00a0ff" stroke-width="6"/>`)
      .join('');
    await sharp(dst)
      .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}">${boxes}</svg>`) }])
      .resize({ width: 1000 })
      .jpeg({ quality: 80 })
      .toFile(path.join(stageDir, 'debug', `patched-page-${pageId}.jpg`));
  }

  return { patches };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export { run_ as run };
