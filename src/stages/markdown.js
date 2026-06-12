import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { generateText as geminiGenerateText, generateImage, buildTextRequestBody, closestAspectRatio } from '../gemini.js';
import { generateText as anthropicGenerateText, buildTranscriptionRequest } from '../anthropic.js';
import { hashParams } from '../manifest.js';
import { parsePageRange } from '../pages.js';

export const name = 'markdown';
export const dir = '95-markdown';
export const configKey = 'markdown';
export const title = 'Transcribe body pages to Markdown (Claude Opus text + Gemini figures)';
// Expensive (one vision-model call per page): never part of a range selection,
// only runs when named explicitly (--stages markdown / `pdfcut markdown`).
export const optIn = true;
// Keep per-page results across runs so a crashed/interrupted book run resumes
// instead of re-paying for every page. Staleness is tracked per page (see
// transcriptionHash), so bodyPages/concurrency/merge changes never re-pay.
export const preserveDir = true;
// Re-merge on every invocation: lets "delete one page-NNNN.md and re-run"
// redo a single page, and applies merge fixes to cached transcriptions.
export const alwaysRun = true;

/** Hash of only the parameters that change what Gemini returns for a page. */
export function transcriptionHash(params) {
  const { model, prompt, temperature, maxInputPx } = params;
  return hashParams({ model, prompt, temperature, maxInputPx });
}

/** Hash of only the parameters that change the extracted/recreated figures. */
export function figureHash(params) {
  const { figurePadPx, figureRecreate, figureModel, figureImageSize, figurePrompt, figureDetectModel, figureDetectPrompt } = params;
  return hashParams({ figurePadPx, figureRecreate, figureModel, figureImageSize, figurePrompt, figureDetectModel, figureDetectPrompt });
}

/**
 * One vision-model call per book page (claude-* → Anthropic, otherwise
 * Gemini) turns the final cleaned scan into
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

  // Transcription provider follows the model name: claude-* → Anthropic,
  // anything else → Gemini. Figure recreation is always Gemini (image model).
  const provider = /^claude/.test(params.model) ? 'anthropic' : 'gemini';

  if (params.dryRun) {
    const id = pageIds[0];
    const jpeg = await pageJpeg(path.join(srcDir, `page-${id}.png`), params.maxInputPx);
    const placeholder = `<${jpeg.toString('base64').length} base64 chars>`;
    const body = provider === 'anthropic'
      ? buildTranscriptionRequest({ model: params.model, prompt: params.prompt, imageBase64: placeholder, mimeType: 'image/jpeg' })
      : buildTextRequestBody({ prompt: params.prompt, imageBase64: placeholder, mimeType: 'image/jpeg', temperature: params.temperature });
    fs.writeFileSync(path.join(stageDir, 'debug', 'request.json'), JSON.stringify(body, null, 2));
    fs.writeFileSync(path.join(stageDir, 'debug', 'prompt.txt'), params.prompt);
    ctx.log(`  markdown: dry run — ${provider} request for page ${id} written to debug/request.json`);
    return { dryRun: true, provider };
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const txKey = provider === 'anthropic' ? anthropicKey : geminiKey;
  const txKeyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  fs.writeFileSync(path.join(stageDir, 'debug', 'prompt.txt'), params.prompt);
  const txHash = transcriptionHash(params);
  const figHash = figureHash(params);
  const figureOpts = params.figureRecreate
    ? { apiKey: geminiKey, model: params.figureModel, imageSize: params.figureImageSize, prompt: params.figurePrompt }
    : null;
  // Opus marks the figures but localizes them poorly — let Gemini find the
  // boxes on pages where the transcription contains figure placeholders.
  const detectOpts = provider === 'anthropic'
    ? { apiKey: geminiKey, model: params.figureDetectModel, prompt: params.figureDetectPrompt, maxInputPx: params.maxInputPx }
    : null;

  let cached = 0;
  let transcribed = 0;
  let refigured = 0;
  const transcribePage = async (id) => {
    const mdFile = path.join(stageDir, `page-${id}.md`);
    const rawFile = path.join(stageDir, 'debug', `page-${id}-raw.md`);
    const metaFile = path.join(stageDir, 'debug', `page-${id}-meta.json`);
    const meta = readJson(metaFile);
    const txOk = fs.existsSync(mdFile) && fs.existsSync(rawFile) && meta?.txHash === txHash;
    const figsOk = meta?.figHash === figHash
      && (meta?.figures || []).every((f) => fs.existsSync(path.join(imagesDir, f)));
    if (txOk && figsOk) {
      cached++;
      return;
    }
    const pagePng = path.join(srcDir, `page-${id}.png`);
    let text;
    let usage;
    if (txOk) {
      // text transcription is current — only the figures need a refresh
      text = fs.readFileSync(rawFile, 'utf8');
      usage = meta;
      refigured++;
    } else {
      if (!txKey) {
        throw new Error(`markdown: ${txKeyName} is not set (needed for ${params.model}). Use --set markdown.dryRun=true, or provide the key via .env`);
      }
      const jpeg = await pageJpeg(pagePng, params.maxInputPx);
      const imageBase64 = jpeg.toString('base64');
      ({ text, meta: usage } = provider === 'anthropic'
        ? await anthropicGenerateText({
            apiKey: txKey,
            model: params.model,
            prompt: params.prompt,
            imageBase64,
            mimeType: 'image/jpeg',
          })
        : await geminiGenerateText({
            apiKey: txKey,
            model: params.model,
            prompt: params.prompt,
            imageBase64,
            mimeType: 'image/jpeg',
            temperature: params.temperature,
            log: ctx.log,
          }));
      fs.writeFileSync(rawFile, text);
      transcribed++;
    }
    const { md, files } = await extractFigures(text, {
      id,
      pagePng,
      imagesDir,
      debugDir: path.join(stageDir, 'debug'),
      padPx: params.figurePadPx,
      recreate: figureOpts,
      detect: detectOpts,
      log: ctx.log,
    });
    fs.writeFileSync(mdFile, md);
    fs.writeFileSync(metaFile, JSON.stringify({ ...usage, txHash, figHash, figures: files }, null, 2));
    ctx.log(`  markdown: page ${id} done (${transcribed + refigured + cached}/${pageIds.length})`);
  };

  await pool(pageIds, Math.max(1, params.concurrency || 1), transcribePage);
  if (cached) ctx.log(`  markdown: ${cached} page(s) reused from previous run`);
  if (refigured) ctx.log(`  markdown: ${refigured} page(s) refreshed figures only (text reused)`);

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
 * each region out of the full-resolution page PNG. With `detect` set, the
 * boxes come from a Gemini detection call instead of the placeholder
 * coordinates (paired in reading order; placeholder coordinates are the
 * fallback). With `recreate` set, the crop is recreated in color
 * (straightened) by the Gemini image model; the raw scan crop is kept in
 * debug/ for comparison. Returns the rewritten markdown and the list of
 * figure file names it references.
 */
export async function extractFigures(text, { id, pagePng, imagesDir, debugDir, padPx = 0, recreate = null, detect = null, log = () => {} }) {
  const matches = [...text.matchAll(FIGURE_RE)];
  const files = [];
  if (!matches.length) return { md: normalizeOutput(text), files };
  let boxes = null;
  if (detect) {
    if (!detect.apiKey) {
      throw new Error('markdown: GEMINI_API_KEY is not set (needed for figure detection). Provide the key via .env');
    }
    boxes = await detectFigureBoxes({ ...detect, pagePng, log });
    if (boxes.length !== matches.length) {
      log(`  markdown: page ${id}: Gemini found ${boxes.length} figure(s) but the transcription has ${matches.length} placeholder(s) — using Gemini's boxes`);
    }
  }
  const { width: W, height: H } = await sharp(pagePng).metadata();
  let out = text;
  let n = 0;
  for (const m of matches) {
    n++;
    // with detection on, Gemini's boxes are authoritative — a placeholder
    // without a detected box degrades to caption-only text below
    const [ymin, xmin, ymax, xmax] = boxes
      ? (boxes[n - 1] ?? [0, 0, 0, 0])
      : [m[1], m[2], m[3], m[4]].map(Number);
    const caption = (m[5] || '').trim();
    const left = Math.max(0, Math.round((xmin / 1000) * W) - padPx);
    const top = Math.max(0, Math.round((ymin / 1000) * H) - padPx);
    const right = Math.min(W, Math.round((xmax / 1000) * W) + padPx);
    const bottom = Math.min(H, Math.round((ymax / 1000) * H) + padPx);
    const fileName = `page-${id}-fig-${n}.png`;
    const validBox = ymax > ymin && xmax > xmin && ((xmax - xmin) / 1000) * W >= 8 && ((ymax - ymin) / 1000) * H >= 8;
    if (validBox) {
      const crop = sharp(pagePng).extract({ left, top, width: right - left, height: bottom - top });
      const finalPng = path.join(imagesDir, fileName);
      if (recreate) {
        // keep the scan crop in debug/ and put the color recreation in images/
        const scanCrop = path.join(debugDir, `page-${id}-fig-${n}-scan.png`);
        await crop.png({ compressionLevel: 6 }).toFile(scanCrop);
        await recreateFigure({ scanCrop, finalPng, width: right - left, height: bottom - top, recreate, log });
      } else {
        await crop.png({ compressionLevel: 6 }).toFile(finalPng);
      }
      files.push(fileName);
      // function replacement: captions may contain `$` (BASIC string variables)
      out = out.replace(m[0], () => `![${caption}](images/${fileName})${caption ? `\n\n*${caption}*` : ''}`);
    } else {
      out = out.replace(m[0], () => (caption ? `*${caption}*` : ''));
    }
  }
  return { md: normalizeOutput(out), files };
}

/**
 * Send a scan crop to the Gemini image model and write the color recreation
 * to finalPng. Failures abort the run (cached pages are kept; re-running
 * resumes, and deleting a figure file in images/ retries just that figure).
 */
async function recreateFigure({ scanCrop, finalPng, width, height, recreate, log }) {
  if (!recreate.apiKey) {
    throw new Error('markdown: GEMINI_API_KEY is not set (needed for figureRecreate). Use --set markdown.figureRecreate=false, or provide the key via .env');
  }
  const inputJpeg = await sharp(scanCrop).jpeg({ quality: 90 }).toBuffer();
  const { buffer } = await generateImage({
    apiKey: recreate.apiKey,
    model: recreate.model,
    prompt: recreate.prompt,
    imageBase64: inputJpeg.toString('base64'),
    mimeType: 'image/jpeg',
    aspectRatio: closestAspectRatio(width / height),
    imageSize: recreate.imageSize,
    log,
  });
  await sharp(buffer).png({ compressionLevel: 6 }).toFile(finalPng);
}

/** Ask the Gemini detection model for figure bounding boxes on a page. */
async function detectFigureBoxes({ apiKey, model, prompt, maxInputPx, pagePng, log }) {
  const jpeg = await pageJpeg(pagePng, maxInputPx);
  const { text } = await geminiGenerateText({
    apiKey,
    model,
    prompt,
    imageBase64: jpeg.toString('base64'),
    mimeType: 'image/jpeg',
    temperature: 0,
    log,
  });
  return parseBoxes(text);
}

/**
 * Parse the detection model's JSON answer into [ymin,xmin,ymax,xmax] arrays.
 * Tolerates a ```json fence, bare [[…], …] arrays, and the box key being
 * "box", "box_2d" (Gemini's native convention) or "bbox".
 */
export function parseBoxes(text) {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  const data = JSON.parse(t);
  if (!Array.isArray(data)) throw new Error('detection result is not a JSON array');
  return data.map((entry) => {
    const box = Array.isArray(entry) ? entry : entry?.box ?? entry?.box_2d ?? entry?.bbox;
    if (!Array.isArray(box) || box.length !== 4 || box.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`bad box entry: ${JSON.stringify(entry).slice(0, 100)}`);
    }
    return box.map(Math.round);
  });
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
      const prevTableRow = /(^|\n)\|[^\n]*\|\s*$/.test(book);
      if (prevFence && curFence) {
        // same code block split across the page break: splice the fences
        book = book.slice(0, prevFence.index) + '\n' + t.slice(curFence[0].length);
      } else if (prevTableRow && t.startsWith('|')) {
        // same table split across the page break: drop a repeated
        // header + separator row, then append the continuation rows
        const lines = t.split('\n');
        if (lines.length >= 2 && /^\|[\s\-:|]*\|$/.test(lines[1])) lines.splice(0, 2);
        book = book + '\n' + lines.join('\n');
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

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
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
