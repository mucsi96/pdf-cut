import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { generateImage, buildRequestBody } from '../gemini.js';
import { pad } from '../pages.js';

export const name = 'cover';
export const dir = '20-cover';
export const configKey = 'cover';
export const title = 'Recreate the wrap-around cover in color with Gemini';

const SUPPORTED_RATIOS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];

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

  const meta = await sharp(scanPath).metadata();
  const aspectRatio = params.aspectRatio === 'auto' ? closestRatio(meta.width / meta.height) : params.aspectRatio;

  // Downscale the scan for upload.
  const inputJpeg = path.join(stageDir, 'debug', 'cover-input.jpg');
  await sharp(scanPath).resize({ width: params.maxInputPx, height: params.maxInputPx, fit: 'inside' }).jpeg({ quality: 90 }).toFile(inputJpeg);
  const imageBase64 = fs.readFileSync(inputJpeg).toString('base64');

  fs.writeFileSync(path.join(stageDir, 'debug', 'prompt.txt'), params.prompt);

  if (params.dryRun) {
    const body = buildRequestBody({ prompt: params.prompt, imageBase64: `<${imageBase64.length} base64 chars>`, mimeType: 'image/jpeg', aspectRatio, imageSize: params.imageSize });
    fs.writeFileSync(path.join(stageDir, 'debug', 'request.json'), JSON.stringify(body, null, 2));
    ctx.log(`  cover: dry run — request written to debug/request.json (aspectRatio=${aspectRatio})`);
    return { dryRun: true, aspectRatio };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('cover: GEMINI_API_KEY is not set. Use --skip-cover, or --set cover.dryRun=true, or provide the key via .env');
  }

  const variants = [];
  for (let v = 1; v <= (params.variants || 1); v++) {
    ctx.log(`  cover: generating variant ${v}/${params.variants} (${params.model}, ${params.imageSize}, ${aspectRatio}) …`);
    const { buffer, meta: genMeta } = await generateImage({
      apiKey,
      model: params.model,
      prompt: params.prompt,
      imageBase64,
      mimeType: 'image/jpeg',
      aspectRatio,
      imageSize: params.imageSize,
      log: ctx.log,
    });
    const rawPath = path.join(stageDir, 'debug', `cover-variant-${v}-raw.png`);
    await sharp(buffer).png().toFile(rawPath);
    const rawMeta = await sharp(rawPath).metadata();
    ctx.log(`  cover: variant ${v} returned ${rawMeta.width}x${rawMeta.height}`);
    if (Math.max(rawMeta.width, rawMeta.height) < params.minLongEdge) {
      throw new Error(
        `cover: Gemini returned ${rawMeta.width}x${rawMeta.height}, below minLongEdge=${params.minLongEdge}. ` +
          'The imageSize hint was probably ignored — check model/quota, or lower cover.minLongEdge.',
      );
    }
    // Lanczos upscale to the scan's own print size (cover + center crop keeps
    // the aspect exact even if Gemini's ratio is slightly off).
    await sharp(rawPath)
      .resize(meta.width, meta.height, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
      .png({ compressionLevel: 6 })
      .withMetadata({ density: meta.density || ctx.dpi() })
      .toFile(path.join(stageDir, `cover-variant-${v}.png`));
    fs.writeFileSync(path.join(stageDir, 'debug', `cover-variant-${v}-meta.json`), JSON.stringify(genMeta, null, 2));
    variants.push(`cover-variant-${v}.png`);
  }

  const selected = Math.min(params.selectedVariant || 1, variants.length);
  fs.copyFileSync(path.join(stageDir, variants[selected - 1]), path.join(stageDir, 'cover.png'));
  ctx.log(`  cover: selected variant ${selected} → cover.png`);
  return { variants, selected, aspectRatio };
}

function closestRatio(actual) {
  let best = SUPPORTED_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of SUPPORTED_RATIOS) {
    const [w, h] = r.split(':').map(Number);
    const diff = Math.abs(w / h - actual);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

export { run_ as run };
