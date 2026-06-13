import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { generateImage, buildRequestBody, closestAspectRatio } from '../gemini.js';
import { pad } from '../pages.js';

export const name = 'cover';
export const dir = '20-cover';
export const configKey = 'cover';
export const title = 'Recreate the cover in color with Gemini';

/**
 * Recreate one cover image (the whole wrap-around in default mode, or a single
 * front/back crop in split mode). Writes `<baseName>.png` (the selected
 * variant) into stageDir, plus per-variant + debug artifacts.
 */
async function recreate(ctx, { stageDir, params, sourcePath, prompt, baseName, label }) {
  const meta = await sharp(sourcePath).metadata();
  const aspectRatio = params.aspectRatio === 'auto' ? closestAspectRatio(meta.width / meta.height) : params.aspectRatio;

  // Downscale the source for upload.
  const inputJpeg = path.join(stageDir, 'debug', `${baseName}-input.jpg`);
  await sharp(sourcePath).resize({ width: params.maxInputPx, height: params.maxInputPx, fit: 'inside' }).jpeg({ quality: 90 }).toFile(inputJpeg);
  const imageBase64 = fs.readFileSync(inputJpeg).toString('base64');

  fs.writeFileSync(path.join(stageDir, 'debug', `${baseName}-prompt.txt`), prompt);

  if (params.dryRun) {
    const body = buildRequestBody({ prompt, imageBase64: `<${imageBase64.length} base64 chars>`, mimeType: 'image/jpeg', aspectRatio, imageSize: params.imageSize });
    fs.writeFileSync(path.join(stageDir, 'debug', `${baseName}-request.json`), JSON.stringify(body, null, 2));
    ctx.log(`  cover: dry run — ${label} request written to debug/${baseName}-request.json (aspectRatio=${aspectRatio})`);
    return { dryRun: true, aspectRatio };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('cover: GEMINI_API_KEY is not set. Use --skip-cover, or --set cover.dryRun=true, or provide the key via .env');
  }

  const variants = [];
  for (let v = 1; v <= (params.variants || 1); v++) {
    ctx.log(`  cover: generating ${label} variant ${v}/${params.variants} (${params.model}, ${params.imageSize}, ${aspectRatio}) …`);
    const { buffer, meta: genMeta } = await generateImage({
      apiKey,
      model: params.model,
      prompt,
      imageBase64,
      mimeType: 'image/jpeg',
      aspectRatio,
      imageSize: params.imageSize,
      log: ctx.log,
    });
    const rawPath = path.join(stageDir, 'debug', `${baseName}-variant-${v}-raw.png`);
    await sharp(buffer).png().toFile(rawPath);
    const rawMeta = await sharp(rawPath).metadata();
    ctx.log(`  cover: ${label} variant ${v} returned ${rawMeta.width}x${rawMeta.height}`);
    if (Math.max(rawMeta.width, rawMeta.height) < params.minLongEdge) {
      throw new Error(
        `cover: Gemini returned ${rawMeta.width}x${rawMeta.height}, below minLongEdge=${params.minLongEdge}. ` +
          'The imageSize hint was probably ignored — check model/quota, or lower cover.minLongEdge.',
      );
    }
    // Lanczos upscale to the source's own print size (cover + center crop keeps
    // the aspect exact even if Gemini's ratio is slightly off).
    await sharp(rawPath)
      .resize(meta.width, meta.height, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
      .png({ compressionLevel: 6 })
      .withMetadata({ density: meta.density || ctx.dpi() })
      .toFile(path.join(stageDir, `${baseName}-variant-${v}.png`));
    fs.writeFileSync(path.join(stageDir, 'debug', `${baseName}-variant-${v}-meta.json`), JSON.stringify(genMeta, null, 2));
    variants.push(`${baseName}-variant-${v}.png`);
  }

  const selected = Math.min(params.selectedVariant || 1, variants.length);
  fs.copyFileSync(path.join(stageDir, variants[selected - 1]), path.join(stageDir, `${baseName}.png`));
  ctx.log(`  cover: selected ${label} variant ${selected} → ${baseName}.png`);
  return { variants, selected, aspectRatio };
}

export async function run_(ctx, { stageDir, params }) {
  const scanPage = params.scanPage ?? 1;
  if (!scanPage) {
    ctx.log('  cover: disabled (cover.scanPage=0 — input has no cover scan)');
    return { skipped: 'disabled' };
  }
  const scanPath = path.join(ctx.dir('extract'), `scan-${pad(scanPage)}.png`);
  if (!fs.existsSync(scanPath)) {
    ctx.log(`  cover: scan-${pad(scanPage)}.png not found (page ${scanPage} not extracted) — skipping`);
    return { skipped: 'no-scan' };
  }

  if (params.split) {
    const meta = await sharp(scanPath).metadata();
    const spineStart = Math.round(meta.width * params.spineStart);
    const spineEnd = Math.round(meta.width * params.spineEnd);
    if (!(spineStart > 0 && spineEnd > spineStart && spineEnd < meta.width)) {
      throw new Error(`cover: invalid spine band — need 0 < spineStart (${params.spineStart}) < spineEnd (${params.spineEnd}) < 1`);
    }
    // back cover = left of the spine, front cover = right of the spine; the
    // spine band in between is discarded ("without the edge").
    const backCrop = path.join(stageDir, 'debug', 'back-crop.png');
    const frontCrop = path.join(stageDir, 'debug', 'front-crop.png');
    await sharp(scanPath).extract({ left: 0, top: 0, width: spineStart, height: meta.height }).png().toFile(backCrop);
    await sharp(scanPath).extract({ left: spineEnd, top: 0, width: meta.width - spineEnd, height: meta.height }).png().toFile(frontCrop);
    ctx.log(`  cover: split mode — back [0,${spineStart}px) + front [${spineEnd}px,${meta.width}px), spine dropped`);
    const front = await recreate(ctx, { stageDir, params, sourcePath: frontCrop, prompt: params.splitPrompt, baseName: 'cover-front', label: 'front cover' });
    const back = await recreate(ctx, { stageDir, params, sourcePath: backCrop, prompt: params.splitPrompt, baseName: 'cover-back', label: 'back cover' });
    return { split: true, spineStart, spineEnd, front, back };
  }

  return recreate(ctx, { stageDir, params, sourcePath: scanPath, prompt: params.prompt, baseName: 'cover', label: 'wrap-around cover' });
}

export { run_ as run };
