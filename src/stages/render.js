import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Marked } from 'marked';
import { run } from '../exec.js';

export const name = 'render';
export const dir = '97-render';
export const configKey = 'render';
export const title = 'Typeset output/book.md into a print-style PDF (TOC, chapters, figures)';
// Only runs when named explicitly (`pdfcut render` / --stages render): it
// consumes the opt-in markdown stage's output, which a default run never has.
export const optIn = true;
// Cheap compared to the pipeline and its input (book.md) lives outside the
// params hash — just re-typeset on every invocation.
export const alwaysRun = true;

/**
 * Turn output/book.md (+ output/images/) into a typeset book PDF with
 * WeasyPrint: title page (optional), table of contents with leader dots and
 * live page numbers, every chapter (#) starting on a new page, mirrored book
 * margins with running head + page number, German hyphenation, and each
 * figure printed at its size in the original book (measured from the scan
 * crop in work/95-markdown/debug/ — px ÷ dpi), capped at the text column.
 */
export async function run_(ctx, { stageDir, params }) {
  const mdPath = path.join(ctx.outputDir, ctx.config.markdown.outName);
  if (!fs.existsSync(mdPath)) {
    throw new Error(`render: ${mdPath} not found — run \`pdfcut markdown\` first`);
  }
  const md = fs.readFileSync(mdPath, 'utf8');
  const dpi = ctx.dpi();

  const page = await resolvePageSize(ctx, params, dpi);
  const mg = params.margins;
  const textWidthMm = page.widthMm - mg.inner - mg.outer;
  ctx.log(`  render: page ${page.widthMm.toFixed(1)} × ${page.heightMm.toFixed(1)} mm (${page.source}), text column ${textWidthMm.toFixed(1)} mm`);

  const figures = await measureFigures(md, { ctx, params, dpi, textWidthMm });
  if (figures.size) {
    const exact = [...figures.values()].filter((f) => f.exact).length;
    ctx.log(`  render: ${figures.size} figure(s) — ${exact} at original book size, ${figures.size - exact} sized by aspect ratio`);
  }

  const covers = resolveCovers(ctx, params);
  if (covers.front || covers.back) {
    ctx.log(`  render: embedding split cover(s) — ${[covers.front && 'front', covers.back && 'back'].filter(Boolean).join(' + ')} (fit: ${params.coverFit})`);
  }

  const { html: bodyHtml, toc } = renderMarkdown(md, { figures, outputDir: ctx.outputDir });
  const html = buildDocument({ bodyHtml, toc, page, params, textWidthMm, covers });
  const htmlPath = path.join(stageDir, 'debug', 'book.html');
  fs.writeFileSync(htmlPath, html);

  const pdfPath = path.join(ctx.outputDir, params.outName);
  const { stderr } = await run('weasyprint', [htmlPath, pdfPath], { capture: true, quiet: true });
  fs.writeFileSync(path.join(stageDir, 'debug', 'weasyprint.log'), stderr);
  const problems = stderr.split('\n').filter((l) => /ERROR|CRITICAL/.test(l));
  for (const l of problems.slice(0, 10)) ctx.log(`  render: ${l.trim()}`);

  const { stdout } = await run('pdfinfo', [pdfPath], { capture: true, quiet: true });
  const pdfPages = parseInt(stdout.match(/^Pages:\s+(\d+)/m)?.[1] || '0', 10);
  const chapters = toc.filter((t) => t.level === 1).length;
  ctx.log(`  render: ${params.outName} — ${pdfPages} pages, ${chapters} chapters, ${figures.size} figure(s)`);
  ctx.log(stdout.split('\n').filter((l) => /^Page size/.test(l)).map((l) => `    ${l}`).join('\n'));
  return { bookPdf: pdfPath, pdfPages, chapters, figures: figures.size };
}

/**
 * Physical page size: explicit config numbers win; "auto" measures the final
 * cleaned scans (pixels ÷ dpi), so the rendered book matches the original's
 * trim size; falls back to A5 when no work dir is around.
 */
async function resolvePageSize(ctx, params, dpi) {
  if (typeof params.pageWidthMm === 'number' && typeof params.pageHeightMm === 'number') {
    return { widthMm: params.pageWidthMm, heightMm: params.pageHeightMm, source: 'config' };
  }
  for (const stage of ['inpaint', 'clean']) {
    const d = ctx.dir(stage);
    if (!fs.existsSync(d)) continue;
    const png = fs.readdirSync(d).find((f) => /^page-\d{4}\.png$/.test(f));
    if (!png) continue;
    const meta = await sharp(path.join(d, png)).metadata();
    return {
      widthMm: (meta.width / dpi) * 25.4,
      heightMm: (meta.height / dpi) * 25.4,
      source: `measured from ${stage}/${png} at ${dpi} dpi`,
    };
  }
  return { widthMm: 148, heightMm: 210, source: 'default A5 — no work pages found' };
}

/**
 * The recreated front/back covers from a `cover.split=true` pipeline run
 * (work/20-cover/cover-{front,back}.png). Returned as absolute paths so they
 * can be embedded as full-page covers; `render.covers=false` opts out.
 */
function resolveCovers(ctx, params) {
  if (params.covers === false) return { front: null, back: null };
  const coverDir = ctx.dir('cover');
  const pick = (name) => {
    const p = path.join(coverDir, name);
    return fs.existsSync(p) ? p : null;
  };
  return { front: pick('cover-front.png'), back: pick('cover-back.png') };
}

const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * Width (mm) for every image referenced in the markdown. The recreated color
 * figures have arbitrary pixel sizes, but the raw scan crop kept in
 * work/95-markdown/debug/…-scan.png still carries the original geometry:
 * crop px ÷ scan dpi = the figure's printed size in the original book. When
 * the crop is gone, fall back to an aspect-ratio share of the text column.
 */
async function measureFigures(md, { ctx, params, dpi, textWidthMm }) {
  const sizes = new Map();
  const maxMm = textWidthMm * params.figureMaxFrac;
  for (const m of md.matchAll(IMAGE_RE)) {
    const href = m[1];
    if (sizes.has(href) || /^[a-z]+:/.test(href)) continue;
    const img = path.join(ctx.outputDir, href);
    const scanCrop = path.join(ctx.dir('markdown'), 'debug', path.basename(href, '.png') + '-scan.png');
    let mm = null;
    let exact = false;
    if (fs.existsSync(scanCrop)) {
      const meta = await sharp(scanCrop).metadata();
      mm = (meta.width / dpi) * 25.4;
      exact = true;
    } else if (fs.existsSync(img)) {
      const meta = await sharp(img).metadata();
      const aspect = meta.width / meta.height;
      mm = textWidthMm * (aspect >= 1.3 ? 1 : aspect >= 0.8 ? 0.75 : 0.55);
    } else {
      continue; // missing file: leave the <img> unsized, WeasyPrint will warn
    }
    sizes.set(href, { widthMm: Math.min(mm * params.figureScale, maxMm), exact });
  }
  return sizes;
}

/**
 * Markdown → HTML with a renderer that (a) gives every heading a stable id
 * and collects the TOC, (b) sizes images in mm and resolves them to absolute
 * paths. Afterwards, image + trailing *caption* paragraphs (the shape the
 * markdown stage emits) are folded into <figure>/<figcaption>, and the empty
 * header rows of term/definition tables are dropped.
 */
export function renderMarkdown(md, { figures = new Map(), outputDir = '.' } = {}) {
  const toc = [];
  const marked = new Marked({
    renderer: {
      heading(text, level) {
        const id = `sec-${toc.length + 1}`;
        toc.push({ level, text: text.replace(/<[^>]*>/g, ''), id });
        return `<h${level} id="${id}">${text}</h${level}>\n`;
      },
      image(href, _title, text) {
        const size = figures.get(href);
        const src = /^[a-z]+:/.test(href) ? href : encodeURI(path.resolve(outputDir, href));
        const style = size ? ` style="width: ${size.widthMm.toFixed(1)}mm"` : '';
        return `<img src="${src}" alt="${text}"${style}>`;
      },
    },
  });
  let html = marked.parse(md);
  html = html
    .replace(/<p>(<img[^>]*>)<\/p>\s*<p><em>([\s\S]*?)<\/em><\/p>/g,
      '<figure>$1<figcaption>$2</figcaption></figure>')
    .replace(/<p>(<img[^>]*>)<\/p>/g, '<figure>$1</figure>')
    .replace(/<thead>\s*<tr>(?:\s*<th[^>]*>\s*<\/th>)+\s*<\/tr>\s*<\/thead>\s*/g, '');
  return { html, toc };
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Full HTML document: optional cover + title page + TOC (front matter) + body. */
export function buildDocument({ bodyHtml, toc, page, params, textWidthMm, covers = {} }) {
  const tocItems = toc
    .filter((t) => t.level <= params.tocDepth)
    .map((t) => `      <li class="toc-${t.level}"><a href="#${t.id}">${t.text}</a></li>`)
    .join('\n');
  const titlePage = params.title
    ? `  <div class="title-page">
    <h1 class="book-title">${escapeHtml(params.title)}</h1>
    ${params.author ? `<p class="book-author">${escapeHtml(params.author)}</p>` : ''}
  </div>\n`
    : '';
  // the empty div takes one whole page: a calm blank verso between the TOC
  // and the first chapter, like a real book
  const tocNav = tocItems
    ? `  <nav class="toc">
    <h1>${escapeHtml(params.tocTitle)}</h1>
    <ul>
${tocItems}
    </ul>
  </nav>
  <div class="page-blank"></div>\n`
    : '';
  const front = titlePage || tocNav ? `<section class="front">\n${titlePage}${tocNav}</section>\n` : '';
  // Each cover is an empty block on its own full-bleed named page; the cover
  // image is painted by the @page background (see buildCss).
  const frontCover = covers.front ? '  <div class="cover cover-front"></div>\n' : '';
  const backCover = covers.back ? '  <div class="cover cover-back"></div>\n' : '';
  return `<!DOCTYPE html>
<html lang="${params.lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(params.title || params.outName.replace(/\.pdf$/, ''))}</title>
${params.author ? `<meta name="author" content="${escapeHtml(params.author)}">` : ''}
<style>
${buildCss({ page, params, textWidthMm, covers })}
</style>
</head>
<body>
${frontCover}${front}<section class="book-body">
${bodyHtml}
</section>
${backCover}</body>
</html>
`;
}

function buildCss({ page, params, covers = {} }) {
  const mg = params.margins;
  const fit = params.coverFit === 'contain' ? 'contain' : 'cover';
  const coverUrl = (p) => encodeURI('file://' + p);
  const coverPage = (name, file) => `@page ${name} {
  margin: 0;
  background: #fff url("${coverUrl(file)}") no-repeat center center;
  background-size: ${fit};
  @top-center { content: none; }
  @bottom-center { content: none; }
}`;
  const coverCss = covers.front || covers.back
    ? [
        covers.front && coverPage('cover-front', covers.front),
        covers.back && coverPage('cover-back', covers.back),
        // each cover is an empty block that fills one named, full-bleed page
        covers.front && '.cover-front { page: cover-front; break-after: page; }',
        covers.back && '.cover-back { page: cover-back; break-before: page; }',
      ].filter(Boolean).join('\n') + '\n'
    : '';
  return `${coverCss}
@page {
  size: ${page.widthMm.toFixed(1)}mm ${page.heightMm.toFixed(1)}mm;
  margin: ${mg.top}mm ${mg.outer}mm ${mg.bottom}mm ${mg.inner}mm;
  @top-center {
    content: string(chapter);
    font-family: "${params.fontBody}", serif;
    font-style: italic;
    font-size: 9.5pt;
    letter-spacing: 0.06em;
  }
  @bottom-center {
    content: counter(page);
    font-family: "${params.fontBody}", serif;
    font-size: 10pt;
  }
}
@page :left { margin: ${mg.top}mm ${mg.inner}mm ${mg.bottom}mm ${mg.outer}mm; }
@page front {
  @top-center { content: none; }
  @bottom-center { content: none; }
}

html { font-family: "${params.fontBody}", serif; font-size: ${params.fontSizePt}pt; line-height: ${params.lineHeight}; }
body { margin: 0; text-align: justify; hyphens: auto; orphans: 2; widows: 2; }

/* Page numbers are absolute (front matter counts silently, like a real
   book's roman-numbered pages): WeasyPrint cannot reset the page counter
   from content, and a content-level reset would desync the TOC's
   target-counter() from the printed footer numbers. */
section.front { page: front; }
.page-blank { break-before: page; }

/* classic book paragraphs: no gap, first-line indent except after a block */
p { margin: 0; text-indent: 4.5mm; }
p:first-child, h1 + p, h2 + p, h3 + p, h4 + p,
figure + p, pre + p, table + p, ul + p, ol + p, blockquote + p { text-indent: 0; }

/* the ZX Spectrum pixel face fills its whole em square, so heading sizes
   run a step smaller than a normal text face would */
h1, h2, h3, h4 { font-family: "${params.fontHeading}", "URW Gothic", sans-serif; line-height: 1.35; text-align: left; hyphens: none; }
section.book-body h1 {
  break-before: ${params.chapterBreak};
  string-set: chapter content();
  font-size: 17pt;
  margin: 14mm 0 9mm;
}
h2 { font-size: 13pt; margin: 5.5mm 0 2.8mm; break-after: avoid; }
h3 { font-size: 11pt; margin: 4mm 0 2mm; break-after: avoid; }
h4 { font-size: 10pt; margin: 3mm 0 1.5mm; break-after: avoid; }

code, pre, kbd { font-family: "${params.fontCode}", monospace; hyphens: none; }
code { font-size: 0.8em; }
pre {
  font-size: ${params.codeFontSizePt}pt;
  line-height: 1.3;
  margin: 3mm 0;
  padding-left: 4mm;
  white-space: pre-wrap;
  text-align: left;
}
pre code { font-size: inherit; }

table { border-collapse: collapse; margin: 3mm auto; font-size: 0.92em; max-width: 100%; }
th, td { border: 0.3pt solid #555; padding: 1mm 2.5mm; vertical-align: top; text-align: left; }
th { font-weight: bold; }

figure { margin: 4mm auto; text-align: center; break-inside: avoid; }
figure img { max-width: 100%; }
figcaption { font-size: 9pt; font-style: italic; margin-top: 1.5mm; }

ul, ol { margin: 1.5mm 0; padding-left: 7mm; }
li { margin: 0.5mm 0; }
blockquote { margin: 2mm 0 2mm 5mm; font-style: italic; }
hr { border: none; border-top: 0.3pt solid #555; margin: 4mm 20%; }

.title-page { break-after: page; padding-top: 55mm; }
.title-page .book-title { font-size: 22pt; margin: 0 0 9mm; text-align: center; }
.title-page .book-author { font-family: "${params.fontHeading}", "URW Gothic", sans-serif; font-size: 12pt; text-indent: 0; text-align: center; }

nav.toc h1 { font-size: 17pt; margin: 14mm 0 9mm; }
nav.toc ul { list-style: none; margin: 0; padding: 0; }
nav.toc li { margin: 0.8mm 0; text-align: left; }
nav.toc li.toc-1 { margin-top: 3.5mm; font-weight: bold; }
nav.toc li.toc-2 { margin-left: 7mm; }
nav.toc a { text-decoration: none; color: inherit; }
nav.toc a::after { content: leader('.') ' ' target-counter(attr(href), page); font-weight: normal; }
`;
}

export { run_ as run };
