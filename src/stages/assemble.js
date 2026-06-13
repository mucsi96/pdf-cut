import fs from 'node:fs';
import path from 'node:path';
import { run } from '../exec.js';
import { pad } from '../pages.js';

export const name = 'assemble';
export const dir = '90-assemble';
export const configKey = 'assemble';
export const title = 'Assemble final PDFs (book + separate cover)';
export const alwaysRun = true;

/**
 * book.pdf: interior pages only. cover.pdf: one landscape page with the
 * AI-recreated cover (or the raw cover scan with --skip-cover). Physical page
 * size comes from the 600 DPI pHYs metadata every PNG carries — img2pdf
 * honors it, so pixels/600 = inches, exactly matching the original book.
 *
 * In cover.split mode there is no separate cover.pdf: the recreated front and
 * back covers (spine dropped) become the first and last pages of book.pdf.
 */
export async function run_(ctx, { stageDir, params }) {
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
    result.bookPdf = bookPdf;
    result.pages = bookPages.length;
    if (coversInBook) result.coversInBook = true;
  } else {
    ctx.log('  assemble: no interior pages found — skipping book.pdf');
  }

  // Separate cover.pdf is only produced when the covers are NOT embedded in
  // the book (i.e. the default wrap-around mode, or --skip-cover).
  if (coversInBook) return result;

  let coverPng = path.join(coverDir, 'cover.png');
  const coverScan = ctx.config.cover?.scanPage ?? 1;
  if (ctx.skipCover || !fs.existsSync(coverPng)) {
    const rawCover = coverScan ? path.join(ctx.dir('extract'), `scan-${pad(coverScan)}.png`) : null;
    coverPng = rawCover && fs.existsSync(rawCover) ? rawCover : null;
    if (coverPng) ctx.log('  assemble: using raw cover scan (no AI cover available)');
  }
  if (coverPng) {
    const coverPdf = path.join(ctx.outputDir, params.coverName);
    await run('img2pdf', [coverPng, '-o', coverPdf], { quiet: true });
    const { stdout } = await run('pdfinfo', [coverPdf], { capture: true, quiet: true });
    ctx.log(`  assemble: ${params.coverName} — 1 landscape page`);
    ctx.log(stdout.split('\n').filter((l) => /^Page size/.test(l)).map((l) => `    ${l}`).join('\n'));
    result.coverPdf = coverPdf;
  } else {
    ctx.log('  assemble: no cover image found — skipping cover.pdf');
  }
  return result;
}

export { run_ as run };
