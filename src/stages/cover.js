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

  // Front/back are needed both for split mode (interior pages) and for the
  // print Umschlag layout (back + spine + front at exact print dimensions).
  const wantFrontBack = params.split || params.print?.enabled;
  let result;
  if (wantFrontBack) {
    const meta = await sharp(scanPath).metadata();
    const spineStart = Math.round(meta.width * params.spineStart);
    const spineEnd = Math.round(meta.width * params.spineEnd);
    if (!(spineStart > 0 && spineEnd > spineStart && spineEnd < meta.width)) {
      throw new Error(`cover: invalid spine band — need 0 < spineStart (${params.spineStart}) < spineEnd (${params.spineEnd}) < 1`);
    }
    // back cover = left of the spine, front cover = right of the spine; the
    // original spine band in between is discarded.
    const backCrop = path.join(stageDir, 'debug', 'back-crop.png');
    const frontCrop = path.join(stageDir, 'debug', 'front-crop.png');
    await sharp(scanPath).extract({ left: 0, top: 0, width: spineStart, height: meta.height }).png().toFile(backCrop);
    await sharp(scanPath).extract({ left: spineEnd, top: 0, width: meta.width - spineEnd, height: meta.height }).png().toFile(frontCrop);
    ctx.log(`  cover: front/back mode — back [0,${spineStart}px) + front [${spineEnd}px,${meta.width}px), original spine dropped`);
    const front = await recreate(ctx, { stageDir, params, sourcePath: frontCrop, prompt: params.splitPrompt, baseName: 'cover-front', label: 'front cover' });
    const back = await recreate(ctx, { stageDir, params, sourcePath: backCrop, prompt: params.splitPrompt, baseName: 'cover-back', label: 'back cover' });
    result = { split: !!params.split, spineStart, spineEnd, front, back };
  } else {
    result = await recreate(ctx, { stageDir, params, sourcePath: scanPath, prompt: params.prompt, baseName: 'cover', label: 'wrap-around cover' });
  }

  // Print-ready wrap-around Umschlag (back + synthesized spine + front) at the
  // exact Druckformat with bleed, per the print shop's cover layout sheet.
  if (params.print?.enabled && !params.dryRun) {
    result.printCover = await composePrintCover(ctx, stageDir, params.print);
  }
  return result;
}

/**
 * Compose a print-ready wrap-around cover (Umschlag) to the print shop's spec:
 * back cover on the left, a synthesized spine of the calculated thickness in
 * the middle, front cover on the right, full-bleed on every outer edge. The
 * page is built in millimeters at `dpi`, so the resulting PDF is exactly the
 * Druckformat (2·pageWidth + spine + 2·bleed) × (pageHeight + 2·bleed). A guide
 * overlay (trim / spine / safety margins) is written to debug/ for checking.
 */
export async function composePrintCover(ctx, stageDir, p) {
  const dpi = p.dpi || 300;
  const mm2px = (mm) => Math.max(0, Math.round((mm / 25.4) * dpi));
  const bleed = mm2px(p.bleedMm);
  const halfW = mm2px(p.pageWidthMm);
  const spineW = mm2px(p.spineMm);
  const trimH = mm2px(p.pageHeightMm);
  const fullH = trimH + 2 * bleed;
  const backW = bleed + halfW; // left bleed + back trim, up to the spine
  const frontW = halfW + bleed; // front trim + right bleed, from the spine
  const fullW = backW + spineW + frontW;

  const frontPng = path.join(stageDir, 'cover-front.png');
  const backPng = path.join(stageDir, 'cover-back.png');
  if (!fs.existsSync(frontPng) || !fs.existsSync(backPng)) {
    throw new Error('cover: print layout needs the front/back recreations (cover-front.png, cover-back.png).');
  }
  if (!p.spineMm) {
    ctx.log('  cover: WARNING print.spineMm is 0 — set the calculated Buchrücken from the product details');
  }

  const backBuf = await sharp(backPng).resize(backW, fullH, { fit: 'cover', position: 'centre' }).toBuffer();
  const frontBuf = await sharp(frontPng).resize(frontW, fullH, { fit: 'cover', position: 'centre' }).toBuffer();
  const spineColor = await resolveSpineColor(p.spineColor, backPng, frontPng);

  const composites = [
    { input: backBuf, left: 0, top: 0 },
    { input: frontBuf, left: backW + spineW, top: 0 },
  ];
  if (spineW > 0) {
    composites.push({ input: { create: { width: spineW, height: fullH, channels: 3, background: spineColor } }, left: backW, top: 0 });
  }
  const outPng = path.join(stageDir, 'cover-print.png');
  await sharp({ create: { width: fullW, height: fullH, channels: 3, background: spineColor } })
    .composite(composites)
    // No alpha channel in print data (druck.at: "Keine Alpha-Kanäle"); flatten
    // any transparency from the recreations onto the spine background and drop
    // the alpha channel entirely (RGB output).
    .flatten({ background: spineColor })
    .removeAlpha()
    .png({ compressionLevel: 6 })
    .withMetadata({ density: dpi })
    .toFile(outPng);

  await drawCoverGuides(stageDir, outPng, { fullW, fullH, bleed, backW, spineW, mm2px, p });

  const widthMm = (fullW / dpi) * 25.4;
  const heightMm = (fullH / dpi) * 25.4;
  const trimWmm = p.pageWidthMm * 2 + p.spineMm;
  ctx.log(
    `  cover: print Umschlag ${widthMm.toFixed(1)}×${heightMm.toFixed(1)} mm Druckformat ` +
      `(Endformat ${trimWmm.toFixed(1)}×${p.pageHeightMm} mm, spine ${p.spineMm} mm, bleed ${p.bleedMm} mm) @ ${dpi} dpi → cover-print.png`,
  );
  return { file: 'cover-print.png', widthMm, heightMm, trimWidthMm: trimWmm, trimHeightMm: p.pageHeightMm, spineMm: p.spineMm, dpi };
}

/** Spine fill: an explicit #rrggbb, or the mean of the cover edges next to it. */
async function resolveSpineColor(spec, backPng, frontPng) {
  const hex = typeof spec === 'string' && spec.match(/^#?([0-9a-fA-F]{6})$/);
  if (hex) {
    const h = hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const edgeMean = async (file, side) => {
    const m = await sharp(file).metadata();
    const w = Math.max(1, Math.round(m.width * 0.04));
    const left = side === 'right' ? m.width - w : 0;
    const { channels } = await sharp(file).extract({ left, top: 0, width: w, height: m.height }).stats();
    return channels.slice(0, 3).map((c) => c.mean);
  };
  const [br, bg, bb] = await edgeMean(backPng, 'right'); // back's inner (spine-side) edge
  const [fr, fg, fb] = await edgeMean(frontPng, 'left'); // front's inner (spine-side) edge
  return { r: Math.round((br + fr) / 2), g: Math.round((bg + fg) / 2), b: Math.round((bb + fb) / 2) };
}

/** Overlay Druckformat / Endformat / spine / Sicherheitsabstand for checking. */
async function drawCoverGuides(stageDir, outPng, { fullW, fullH, bleed, backW, spineW, mm2px, p }) {
  const safe = mm2px(p.safetyMm);
  const spineSafe = mm2px(p.spineSafetyMm);
  const trimW = fullW - 2 * bleed;
  const trimH = fullH - 2 * bleed;
  const spineX2 = backW + spineW;
  const backSafe = { x: bleed + safe, y: bleed + safe, w: backW - spineSafe - (bleed + safe), h: trimH - 2 * safe };
  const frontSafe = { x: spineX2 + spineSafe, y: bleed + safe, w: fullW - bleed - safe - (spineX2 + spineSafe), h: trimH - 2 * safe };
  const rects = [
    `<rect x="1" y="1" width="${fullW - 2}" height="${fullH - 2}" fill="none" stroke="#888888" stroke-width="2"/>`,
    `<rect x="${bleed}" y="${bleed}" width="${trimW}" height="${trimH}" fill="none" stroke="#e2001a" stroke-width="3"/>`,
    spineW > 0 ? `<rect x="${backW}" y="${bleed}" width="${spineW}" height="${trimH}" fill="#00000022" stroke="#888888" stroke-width="2" stroke-dasharray="12 9"/>` : '',
    `<rect x="${backSafe.x}" y="${backSafe.y}" width="${Math.max(0, backSafe.w)}" height="${Math.max(0, backSafe.h)}" fill="none" stroke="#1f6feb" stroke-width="2" stroke-dasharray="16 12"/>`,
    `<rect x="${frontSafe.x}" y="${frontSafe.y}" width="${Math.max(0, frontSafe.w)}" height="${Math.max(0, frontSafe.h)}" fill="none" stroke="#1f6feb" stroke-width="2" stroke-dasharray="16 12"/>`,
  ].join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fullW}" height="${fullH}">${rects}</svg>`;
  await sharp(outPng)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 82 })
    .toFile(path.join(stageDir, 'debug', 'cover-print-guides.jpg'));
}

export { run_ as run };
