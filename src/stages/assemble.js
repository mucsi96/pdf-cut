import fs from 'node:fs';
import path from 'node:path';
import { run } from '../exec.js';
import { pad } from '../pages.js';
import { toPrintPdf } from '../printpdf.js';

export const name = 'assemble';
export const dir = '90-assemble';
export const configKey = 'assemble';
export const title = 'Assemble final PDFs (book + separate cover)';
export const alwaysRun = true;

/**
 * book.pdf: interior pages only. cover.pdf: the cover — either the print-ready
 * wrap-around Umschlag (cover.print), or one landscape page with the
 * AI-recreated cover (or the raw cover scan with --skip-cover). Physical page
 * size comes from the PNG pHYs metadata img2pdf honors.
 *
 * In cover.split mode the recreated front and back covers become the first and
 * last pages of book.pdf (spine dropped). Every final PDF is then run through
 * the Ghostscript print pass (print.enabled): fonts embedded, transparency
 * flattened, CMYK/grayscale, PDF/X-1a.
 */
export async function run_(ctx, { stageDir, params }) {
  const debugDir = path.join(stageDir, 'debug');
  const print = ctx.config.print || {};
  const colorFor = (mode) => (print.colorMode && print.colorMode !== 'auto' ? print.colorMode : mode);
  const printPdf = (pdfPath, mode, label) =>
    print.enabled !== false ? toPrintPdf(ctx, { pdfPath, colorMode: colorFor(mode), settings: print, debugDir, label }) : null;

  const inpaintDir = ctx.dir('inpaint');
  const pageFiles = fs.existsSync(inpaintDir)
    ? fs.readdirSync(inpaintDir).filter((n) => /^page-\d{4}\.png$/.test(n)).sort().map((n) => path.join(inpaintDir, n))
    : [];

  const coverDir = ctx.dir('cover');
  const frontCover = path.join(coverDir, 'cover-front.png');
  const backCover = path.join(coverDir, 'cover-back.png');
  const coversInBook = !!ctx.config.cover?.split && !ctx.skipCover && fs.existsSync(frontCover) && fs.existsSync(backCover);

  const result = {};
  const bookPages = coversInBook ? [frontCover, ...pageFiles, backCover] : pageFiles;
  if (bookPages.length) {
    const bookPdf = path.join(ctx.outputDir, params.bookName);
    await run('img2pdf', [...bookPages, '-o', bookPdf], { quiet: true });
    const { stdout } = await run('pdfinfo', [bookPdf], { capture: true, quiet: true });
    ctx.log(`  assemble: ${params.bookName} — ${bookPages.length} pages${coversInBook ? ' (front + back covers embedded, spine dropped)' : ''}`);
    ctx.log(stdout.split('\n').filter((l) => /^(Pages|Page size)/.test(l)).map((l) => `    ${l}`).join('\n'));
    // The scanned block is grayscale; the embedded color covers force CMYK.
    await printPdf(bookPdf, coversInBook ? 'cmyk' : 'gray', 'assemble book');
    result.bookPdf = bookPdf;
    result.pages = bookPages.length;
    if (coversInBook) result.coversInBook = true;
  } else {
    ctx.log('  assemble: no interior pages found — skipping book.pdf');
  }

  // cover.pdf: the print-ready Umschlag wins; otherwise the plain recreated/raw
  // cover (skipped when the covers are already embedded in the book).
  const printCover = path.join(coverDir, 'cover-print.png');
  let coverPng = null;
  let coverIsUmschlag = false;
  if (!ctx.skipCover && fs.existsSync(printCover)) {
    coverPng = printCover;
    coverIsUmschlag = true;
  } else if (!coversInBook) {
    coverPng = path.join(coverDir, 'cover.png');
    const coverScan = ctx.config.cover?.scanPage ?? 1;
    if (ctx.skipCover || !fs.existsSync(coverPng)) {
      const rawCover = coverScan ? path.join(ctx.dir('extract'), `scan-${pad(coverScan)}.png`) : null;
      coverPng = rawCover && fs.existsSync(rawCover) ? rawCover : null;
      if (coverPng) ctx.log('  assemble: using raw cover scan (no AI cover available)');
    }
  }
  if (coverPng) {
    const coverPdf = path.join(ctx.outputDir, params.coverName);
    await run('img2pdf', [coverPng, '-o', coverPdf], { quiet: true });
    const { stdout } = await run('pdfinfo', [coverPdf], { capture: true, quiet: true });
    ctx.log(`  assemble: ${params.coverName} — ${coverIsUmschlag ? 'print-ready wrap-around Umschlag (back + spine + front)' : '1 landscape page'}`);
    ctx.log(stdout.split('\n').filter((l) => /^Page size/.test(l)).map((l) => `    ${l}`).join('\n'));
    await printPdf(coverPdf, 'cmyk', 'assemble cover');
    result.coverPdf = coverPdf;
  } else if (!coversInBook) {
    ctx.log('  assemble: no cover image found — skipping cover.pdf');
  }
  return result;
}

export { run_ as run };
