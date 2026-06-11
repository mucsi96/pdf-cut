import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { run } from '../exec.js';
import { pad } from '../pages.js';

export const name = 'extract';
export const dir = '10-extract';
export const configKey = 'extract';
export const title = 'Extract scan images from PDF';

/**
 * Baseline extraction. Preferred mode pulls the raw embedded scan bitmaps out
 * of the PDF with `pdfimages -png` (decodes, never resamples), so the baseline
 * is exactly what the scanner produced. Falls back to rendering with pdftoppm
 * when pages don't map 1:1 to embedded images.
 */
export async function run_(ctx, { stageDir, params }) {
  const pages = ctx.pages; // null = all
  const dpi = params.dpi;

  // Inventory the embedded images.
  const { stdout: listOut } = await run('pdfimages', ['-list', ctx.inputPdf], { capture: true, quiet: true });
  fs.writeFileSync(path.join(stageDir, 'debug', 'pdfimages-list.txt'), listOut);
  const inventory = parseImageList(listOut);

  const { stdout: infoOut } = await run('pdfinfo', [ctx.inputPdf], { capture: true, quiet: true });
  const totalPages = parseInt(infoOut.match(/^Pages:\s+(\d+)/m)?.[1] || '0', 10);
  const wantedPages = pages ?? Array.from({ length: totalPages }, (_, i) => i + 1);

  const perPage = new Map();
  for (const img of inventory) {
    perPage.set(img.page, (perPage.get(img.page) || 0) + 1);
  }
  const oneImagePerPage = wantedPages.every((p) => perPage.get(p) === 1);

  let mode = params.mode;
  if (mode === 'auto') mode = oneImagePerPage ? 'embedded' : 'render';
  if (mode === 'embedded' && !oneImagePerPage) {
    ctx.log('  extract: pages do not map 1:1 to embedded images — falling back to render mode');
    mode = 'render';
  }

  const scanDpi = {};
  if (mode === 'embedded') {
    const tmp = path.join(stageDir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const f = Math.min(...wantedPages);
    const l = Math.max(...wantedPages);
    await run('pdfimages', ['-p', '-png', '-f', String(f), '-l', String(l), ctx.inputPdf, path.join(tmp, 'img')], { quiet: true });
    for (const p of wantedPages) {
      const candidates = fs.readdirSync(tmp).filter((n) => n.startsWith(`img-${String(p).padStart(3, '0')}-`));
      if (candidates.length !== 1) throw new Error(`extract: expected 1 image for page ${p}, got ${candidates.length}`);
      const src = path.join(tmp, candidates[0]);
      const inv = inventory.find((i) => i.page === p);
      const density = inv?.xppi || dpi;
      if (inv?.xppi && Math.abs(inv.xppi - dpi) > 5) {
        ctx.log(`  extract: warning — page ${p} embedded image is ${inv.xppi} ppi, config says ${dpi}`);
      }
      scanDpi[pad(p)] = density;
      await sharp(src)
        .grayscale()
        .png({ compressionLevel: 6 })
        .withMetadata({ density })
        .toFile(path.join(stageDir, `scan-${pad(p)}.png`));
      fs.rmSync(src);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    const f = Math.min(...wantedPages);
    const l = Math.max(...wantedPages);
    const prefix = path.join(stageDir, 'render');
    await run('pdftoppm', ['-r', String(dpi), '-gray', '-png', '-f', String(f), '-l', String(l), ctx.inputPdf, prefix], { quiet: true });
    const rendered = fs.readdirSync(stageDir).filter((n) => n.startsWith('render-') && n.endsWith('.png'));
    for (const n of rendered) {
      const num = parseInt(n.match(/render-0*(\d+)\.png$/)[1], 10);
      if (!wantedPages.includes(num)) {
        fs.rmSync(path.join(stageDir, n));
        continue;
      }
      scanDpi[pad(num)] = dpi;
      await sharp(path.join(stageDir, n))
        .grayscale()
        .png({ compressionLevel: 6 })
        .withMetadata({ density: dpi })
        .toFile(path.join(stageDir, `scan-${pad(num)}.png`));
      fs.rmSync(path.join(stageDir, n));
    }
  }

  // Contact sheet for a quick overview.
  const scans = fs.readdirSync(stageDir).filter((n) => n.startsWith('scan-')).sort();
  if (scans.length) {
    await run(
      'montage',
      [...scans.map((n) => path.join(stageDir, n)), '-tile', '4x', '-geometry', '400x+5+5', path.join(stageDir, 'debug', 'contact-sheet.jpg')],
      { quiet: true, allowFailure: true },
    );
  }

  return { mode, scanDpi, totalPages, scans };
}

function parseImageList(text) {
  // pdfimages -list: header (2 lines) then rows:
  // page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
  const rows = [];
  for (const line of text.split('\n').slice(2)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 14 || !/^\d+$/.test(cols[0])) continue;
    rows.push({
      page: parseInt(cols[0], 10),
      type: cols[2],
      width: parseInt(cols[3], 10),
      height: parseInt(cols[4], 10),
      enc: cols[8],
      xppi: parseInt(cols[11], 10) || null,
    });
  }
  return rows;
}

export { run_ as run };
