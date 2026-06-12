import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { generateText, buildTextRequestBody } from '../gemini.js';
import { parsePageRange } from '../pages.js';

export const name = 'markdown';
export const dir = '95-markdown';
export const configKey = 'markdown';
export const title = 'Transcribe body pages to Markdown with Gemini (text + figures)';
// Expensive (one Gemini call per page): never part of a range selection, only
// runs when named explicitly (--stages markdown / `pdfcut markdown`).
export const optIn = true;
// Keep per-page results across runs so a crashed/interrupted book run resumes
// instead of re-paying for every page.
export const preserveDir = true;

/**
 * One Gemini vision call per book page turns the final cleaned scan into
 * GitHub-flavored Markdown: German body text with hyphenation repaired, BASIC
 * listings as ```basic fences, figures as [FIGURE ymin,xmin,ymax,xmax: caption]
 * placeholders that we crop out of the full-resolution page into PNG files.
 * Front matter / TOC / page numbers / running heads are dropped by the model
 * ([SKIP] pages) or excluded up front via markdown.bodyPages. Per-page results
 * are stitched across page boundaries ([CONT] markers) into output/book.md.
 */
export async function run_(ctx, { stageDir, params }) {
  const srcDir = ['inpaint', 'clean'].map((s) => ctx.dir(s)).find((d) => fs.existsSync(d));
  if (!srcDir) {
    throw new Error('markdown: no inpaint/ or clean/ pages in the work dir — run the pipeline first');
  }

  const bodyPages = params.bodyPages && params.bodyPages !== 'all' ? parsePageRange(params.bodyPages) : null;
  const pageIds = fs.readdirSync(srcDir)
    .map((f) => f.match(/^page-(\d{4})\.png$/)?.[1])
    .filter(Boolean)
    .filter((id) => !bodyPages || bodyPages.includes(parseInt(id, 10)))
    .sort();
  if (!pageIds.length) {
    throw new Error(`markdown: no pages match bodyPages=${params.bodyPages}`);
  }
  ctx.log(`  markdown: ${pageIds.length} page(s) from ${path.basename(srcDir)} (${params.model})`);

  const imagesDir = path.join(stageDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  if (params.dryRun) {
    const id = pageIds[0];
    const jpeg = await pageJpeg(path.join(srcDir, `page-${id}.png`), params.maxInputPx);
    const body = buildTextRequestBody({
      prompt: params.prompt,
      imageBase64: `<${jpeg.toString('base64').length} base64 chars>`,
      mimeType: 'image/jpeg',
      temperature: params.temperature,
    });
    fs.writeFileSync(path.join(stageDir, 'debug', 'request.json'), JSON.stringify(body, null, 2));
    fs.writeFileSync(path.join(stageDir, 'debug', 'prompt.txt'), params.prompt);
    ctx.log(`  markdown: dry run — request for page ${id} written to debug/request.json`);
    return { dryRun: true };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  fs.writeFileSync(path.join(stageDir, 'debug', 'prompt.txt'), params.prompt);

  let cached = 0;
  let transcribed = 0;
  const transcribePage = async (id) => {
    const mdFile = path.join(stageDir, `page-${id}.md`);
    if (fs.existsSync(mdFile)) {
      cached++;
      return;
    }
    if (!apiKey) {
      throw new Error('markdown: GEMINI_API_KEY is not set. Use --set markdown.dryRun=true, or provide the key via .env');
    }
    const pagePng = path.join(srcDir, `page-${id}.png`);
    const jpeg = await pageJpeg(pagePng, params.maxInputPx);
    const { text, meta } = await generateText({
      apiKey,
      model: params.model,
      prompt: params.prompt,
      imageBase64: jpeg.toString('base64'),
      mimeType: 'image/jpeg',
      temperature: params.temperature,
      log: ctx.log,
    });
    fs.writeFileSync(path.join(stageDir, 'debug', `page-${id}-raw.md`), text);
    fs.writeFileSync(path.join(stageDir, 'debug', `page-${id}-meta.json`), JSON.stringify(meta, null, 2));
    const md = await extractFigures(text, { id, pagePng, imagesDir, padPx: params.figurePadPx });
    fs.writeFileSync(mdFile, md);
    transcribed++;
    ctx.log(`  markdown: page ${id} done (${transcribed + cached}/${pageIds.length})`);
  };

  await pool(pageIds, Math.max(1, params.concurrency || 1), transcribePage);
  if (cached) ctx.log(`  markdown: ${cached} page(s) reused from previous run`);

  // ── Merge per-page markdown into the final book ───────────────────────
  const pages = pageIds.map((id) => ({ id, md: fs.readFileSync(path.join(stageDir, `page-${id}.md`), 'utf8') }));
  const { text: book, skipped } = mergePages(pages);
  const bookMd = path.join(ctx.outputDir, params.outName);
  fs.writeFileSync(bookMd, book);
  const figures = fs.readdirSync(imagesDir).filter((f) => f.endsWith('.png'));
  if (figures.length) {
    fs.cpSync(imagesDir, path.join(ctx.outputDir, 'images'), { recursive: true });
  }
  ctx.log(`  markdown: ${params.outName} — ${pageIds.length - skipped.length} body pages, ${figures.length} figure(s)` +
    (skipped.length ? `, skipped non-body pages: ${skipped.join(', ')}` : ''));
  return { bookMd, pages: pageIds.length, skippedPages: skipped, figures: figures.length, transcribed, cached };
}

/** Downscale a page scan for upload (long edge ≤ maxPx). */
async function pageJpeg(pagePng, maxPx) {
  return sharp(pagePng).resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}

const FIGURE_RE = /^\[FIGURE\s+(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?::\s*([^\]]*))?\][ \t]*$/gm;

/**
 * Replace [FIGURE ymin,xmin,ymax,xmax: caption] placeholders (coordinates
 * normalized to 0–1000, top-left origin) with markdown image links, cropping
 * each region out of the full-resolution page PNG.
 */
export async function extractFigures(text, { id, pagePng, imagesDir, padPx = 0 }) {
  const matches = [...text.matchAll(FIGURE_RE)];
  if (!matches.length) return normalizeOutput(text);
  const { width: W, height: H } = await sharp(pagePng).metadata();
  let out = text;
  let n = 0;
  for (const m of matches) {
    n++;
    const [ymin, xmin, ymax, xmax] = [m[1], m[2], m[3], m[4]].map(Number);
    const caption = (m[5] || '').trim();
    const left = Math.max(0, Math.round((xmin / 1000) * W) - padPx);
    const top = Math.max(0, Math.round((ymin / 1000) * H) - padPx);
    const right = Math.min(W, Math.round((xmax / 1000) * W) + padPx);
    const bottom = Math.min(H, Math.round((ymax / 1000) * H) + padPx);
    const fileName = `page-${id}-fig-${n}.png`;
    const validBox = ymax > ymin && xmax > xmin && ((xmax - xmin) / 1000) * W >= 8 && ((ymax - ymin) / 1000) * H >= 8;
    if (validBox) {
      await sharp(pagePng)
        .extract({ left, top, width: right - left, height: bottom - top })
        .png({ compressionLevel: 6 })
        .toFile(path.join(imagesDir, fileName));
      // function replacement: captions may contain `$` (BASIC string variables)
      out = out.replace(m[0], () => `![${caption}](images/${fileName})${caption ? `\n\n*${caption}*` : ''}`);
    } else {
      out = out.replace(m[0], () => (caption ? `*${caption}*` : ''));
    }
  }
  return normalizeOutput(out);
}

/** Strip accidental ```markdown wrappers and close unbalanced fences. */
function normalizeOutput(text) {
  let t = text.trim();
  const wrap = t.match(/^```(?:markdown|md)\n([\s\S]*)\n```$/);
  if (wrap) t = wrap[1].trim();
  const fences = (t.match(/^```/gm) || []).length;
  if (fences % 2 === 1) t += '\n```';
  return t.replace(/\n{3,}/g, '\n\n') + '\n';
}

/**
 * Concatenate per-page markdown. [SKIP] pages are dropped. A [CONT] marker on
 * the last line of one page matched by [CONT] on the first line of the next
 * stitches the boundary: code fences of the same block are spliced together,
 * split paragraphs are joined (de-hyphenating "Pro-" + "gramm").
 */
export function mergePages(pages) {
  const skipped = [];
  let book = '';
  let pendingCont = false;
  for (const { id, md } of pages) {
    let t = md.trim();
    if (!t || t === '[SKIP]') {
      skipped.push(id);
      pendingCont = false;
      continue;
    }
    const contStart = /^\[CONT\]\s*\n?/.test(t);
    const contEnd = /\n?\s*\[CONT\]$/.test(t);
    t = t.replace(/^\[CONT\]\s*\n?/, '').replace(/\n?\s*\[CONT\]$/, '').trim();
    if (!t) {
      skipped.push(id);
      continue;
    }
    if (!book) {
      book = t;
    } else if (pendingCont && contStart) {
      const prevFence = book.match(/\n```\s*$/);
      const curFence = t.match(/^```[a-z]*\n/);
      if (prevFence && curFence) {
        // same code block split across the page break: splice the fences
        book = book.slice(0, prevFence.index) + '\n' + t.slice(curFence[0].length);
      } else if (/[A-Za-zÄÖÜäöüß]-$/.test(book)) {
        book = book.slice(0, -1) + t; // de-hyphenate the split word
      } else {
        book = book + ' ' + t;
      }
    } else {
      book = book + '\n\n' + t;
    }
    pendingCont = contEnd;
  }
  return { text: book + '\n', skipped };
}

/** Run fn over items with at most `size` in flight; first failure aborts. */
async function pool(items, size, fn) {
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
}

export { run_ as run };
