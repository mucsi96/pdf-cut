import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { pad } from '../pages.js';

export const name = 'split';
export const dir = '30-split';
export const configKey = 'split';
export const title = 'Split 2-up scans into single pages';

/**
 * Cuts every scan (except scan 1 = cover) into a left and a right book page.
 * Page numbers are derived from the scan number so a partial run (--pages)
 * still yields stable numbering: left(scan N) = firstBookPage + (N-2)*2.
 */
export async function run_(ctx, { stageDir, params }) {
  const extractDir = ctx.dir('extract');
  const scans = fs
    .readdirSync(extractDir)
    .filter((n) => /^scan-\d{4}\.png$/.test(n))
    .sort()
    .map((n) => ({ file: path.join(extractDir, n), num: parseInt(n.slice(5, 9), 10) }))
    .filter((s) => s.num >= 2); // scan 1 is the cover

  if (!scans.length) {
    ctx.log('  split: no interior scans found (only the cover was extracted?)');
    return { pageMap: {} };
  }

  const pageMap = {};
  for (const scan of scans) {
    const img = sharp(scan.file);
    const { width, height, density } = await img.metadata();
    const ratio = params.overrides?.[pad(scan.num)] ?? params.centerRatio;
    const cut = Math.round(width * ratio);
    const overlap = params.overlapPx | 0;

    const leftPage = params.firstBookPage + (scan.num - 2) * 2;
    const rightPage = leftPage + 1;
    const [firstNum, secondNum] = params.order === 'right-first' ? [rightPage, leftPage] : [leftPage, rightPage];

    const leftW = Math.min(width, cut + overlap);
    const rightX = Math.max(0, cut - overlap);

    await sharp(scan.file)
      .extract({ left: 0, top: 0, width: leftW, height })
      .png({ compressionLevel: 6 })
      .withMetadata({ density: density || ctx.config.extract.dpi })
      .toFile(path.join(stageDir, `page-${pad(firstNum)}.png`));
    await sharp(scan.file)
      .extract({ left: rightX, top: 0, width: width - rightX, height })
      .png({ compressionLevel: 6 })
      .withMetadata({ density: density || ctx.config.extract.dpi })
      .toFile(path.join(stageDir, `page-${pad(secondNum)}.png`));

    pageMap[pad(scan.num)] = { left: firstNum, right: secondNum, cut, ratio };

    // Debug: scan with the cut position marked in red.
    const svg = Buffer.from(
      `<svg width="${width}" height="${height}">` +
        `<line x1="${cut}" y1="0" x2="${cut}" y2="${height}" stroke="red" stroke-width="8"/>` +
        `<text x="${cut + 20}" y="120" font-size="100" fill="red">cut @ ${ratio}</text></svg>`,
    );
    // Composite at full size first; sharp would otherwise resize before compositing.
    const marked = await sharp(scan.file).composite([{ input: svg }]).png().toBuffer();
    await sharp(marked)
      .resize({ width: 1400 })
      .jpeg({ quality: 80 })
      .toFile(path.join(stageDir, 'debug', `cut-scan-${pad(scan.num)}.jpg`));
  }

  return { pageMap };
}

export { run_ as run };
