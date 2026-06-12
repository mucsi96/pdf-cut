import fs from 'node:fs';

export const DEFAULT_CONFIG = {
  extract: {
    // "embedded": pull the raw scan bitmaps out of the PDF with pdfimages (no
    // resampling — true baseline). "render": rasterize with pdftoppm at `dpi`.
    // "auto": embedded when every page holds exactly one image, else render.
    mode: 'auto',
    // "auto" reads the true scan DPI from the PDF's own page layout;
    // set a number only when the PDF carries bogus page boxes.
    dpi: 'auto',
  },
  cover: {
    // Which PDF scan page holds the wrap-around cover; 0 = input has no
    // cover scan (e.g. already-split single-page scans).
    scanPage: 1,
    // Nano Banana Pro, stable GA id (the -preview id shuts down 2026-06-25).
    model: 'gemini-3-pro-image',
    imageSize: '4K',
    // "auto" picks the closest supported Gemini aspect ratio from the scan.
    aspectRatio: 'auto',
    maxInputPx: 2048,
    variants: 1,
    selectedVariant: 1,
    // Fail the stage if the returned image's long edge is below this (catches
    // silent 1K fallbacks that would look terrible at 600 DPI print).
    minLongEdge: 3000,
    // Write the request to debug/ and skip the API call (no key required).
    dryRun: false,
    prompt:
      'Recreate this scanned black-and-white wrap-around book cover as a clean, ' +
      'full-color print cover. The image shows, left to right: back cover, spine, front cover. ' +
      'Keep this exact left-to-right layout and all proportions. Reproduce ALL German text, ' +
      'titles, logos and layout exactly as in the scan — do not invent, translate or omit any text. ' +
      'Style: early-1980s home computer book cover (Sinclair ZX Spectrum era), vivid but tasteful ' +
      'colors, crisp vector-like typography, subtle retro-futuristic space scene on the front cover. ' +
      'Output a flat printable cover image with no mockup, no perspective, no added borders.',
  },
  split: {
    centerRatio: 0.5,
    overlapPx: 0,
    // Scans wider than height*splitAspectMin are 2-up spreads and get cut;
    // anything else passes through as an already-single page.
    splitAspectMin: 1.1,
    // Book page number assigned to the first emitted page.
    firstBookPage: 2,
    order: 'left-first',
    // Per-scan centerRatio overrides, e.g. { "0012": 0.515 }
    overrides: {},
  },
  deskew: {
    maxAngle: 3.0,
    coarseStep: 0.25,
    fineStep: 0.05,
    // Angle estimation runs at this resolution regardless of scan DPI.
    estimateDpi: 150,
    contentDelta: 25,
    lineMaxHeightPx: 30, // at estimateDpi; drops illustrations/holes
    minInkPx: 800,       // below this: blank page, keep angle 0
    minScoreRatio: 1.15, // peak/median sharpness; below: keep angle 0
    // Dewarp: trace text baselines after rotation and remove smooth paper
    // curvature in the same single resampling pass.
    dewarp: true,
    dewarpMinLines: 4,
    dewarpMinMm: 0.25,   // smaller residual waviness: leave the page alone
    dewarpMaxMm: 2.0,    // displacement cap (bad fits cannot wreck a page)
    lineMinWidthFrac: 0.5,
    // Per-page fixed angle in degrees (skips estimation), e.g. { "0017": -0.4 }
    overrides: {},
  },
  clean: {
    // "preserve" (default): detect content blocks and keep every content
    //   pixel exactly as scanned; whiten only border residue, isolated
    //   specks, shadows between blocks and the paper tint. Safest for print.
    // "smart-binarize": crisp B/W text with anti-aliased edges, illustrations
    //   kept as grayscale. "grayscale": flatten + highlight clip only.
    mode: 'preserve',
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    maxBorderIntrusionPx: 250,
    minSpeckArea: 60,
    // preserve parameters
    contentDelta: 25,      // "content" = darker than paper by this much
    contentDilatePx: 60,   // safety halo merged around all content
    contentFeatherPx: 8,
    paperMargin: 15,       // highlight clip starts this far below paper level
    edgeBandMm: 6.0,           // components fully inside this edge band = residue
    edgeStripBandMm: 10.0,     // tall narrow blobs within this of a vertical edge = residue
    despeckleBandMm: 10.0,     // margin band where small specks are removed
    despeckleMaxAreaMm2: 1.0,  // "small" = below this area (page numbers are ~6 mm²)
    // grayscale / smart-binarize parameters
    flatten: true,
    bgKernelPx: 81,
    bgFloor: 128,
    whitePoint: 210,
    despeckleBandPx: 350,
    autoLevels: true,
    inkPercentile: 5,
    sauvolaWindowPx: 61,
    sauvolaK: 0.12,
    sauvolaDarkFloor: 100,
    edgeSoftness: 10,
    picMidLow: 50,
    picMidHigh: 200,
    picWindowPx: 51,
    picDensity: 0.35,
    picMinAreaPx: 40000,
    picFeatherPx: 8,
  },
  detect: {
    darkThreshold: 70,
    minDiamMm: 2.5,
    maxDiamMm: 9.0,
    circularityMin: 0.65,
    edgeCircularityMin: 0.4,
    // Cross-page punch-position clustering: candidates this round (voters)
    // define hole positions; positions seen on >= clusterMinFrac of pages are
    // applied to EVERY page, even where the hole hides inside artwork.
    voterCircularityMin: 0.7,
    clusterTolMm: 8.0,
    clusterMinFrac: 0.3,
    minPagesForCluster: 4,
    // Where hole centers may sit (union; set a fraction to 0 to disable):
    // a band across the top of the page (top-margin punching, hanging files)
    // and a strip along the gutter (ring binders).
    searchTopFrac: 0.18,
    searchInnerWidthFrac: 0.18,
    maskDilatePx: 24,
  },
  inpaint: {
    patchSize: 768,
    model: 'lama',
    device: 'cpu',
    modelDir: '/opt/models',
    // Levels stretch applied to LaMa output patches; set to null to disable
    // (e.g. when inpainting inside grayscale illustrations).
    contrastStretch: { black: 80, white: 210 },
  },
  assemble: {
    bookName: 'book.pdf',
    coverName: 'cover.pdf',
  },
  markdown: {
    // Text+vision model for the transcription. claude-* models go through
    // the Anthropic API (ANTHROPIC_API_KEY), anything else through Gemini
    // (GEMINI_API_KEY) — e.g. gemini-3.1-pro-preview or gemini-3.5-flash.
    model: 'claude-opus-4-8',
    // Book pages (the 4-digit page ids) to transcribe, e.g. "12-181".
    // "all" sends every page and lets the model [SKIP] non-body pages
    // (title, imprint, TOC, preface).
    bodyPages: 'all',
    // Long edge of the JPEG uploaded per page; the figure crops always come
    // from the full-resolution PNG.
    maxInputPx: 2304,
    // Parallel transcription calls (429s are retried with backoff anyway).
    concurrency: 3,
    // Gemini only — Anthropic Opus models don't accept sampling parameters.
    temperature: 0.1,
    // Padding around figure crops, in pixels at scan resolution.
    figurePadPx: 12,
    // Recreate every figure in color with the image model (straightened,
    // German labels preserved); false keeps the raw grayscale scan crops.
    figureRecreate: true,
    // Nano Banana Pro; gemini-3.1-flash-image is the faster/cheaper option.
    figureModel: 'gemini-3-pro-image',
    figureImageSize: '2K',
    figurePrompt:
      'Recreate this scanned black-and-white figure from a 1980s German book about Sinclair ' +
      'ZX Spectrum BASIC programming as a clean, full-color illustration. The scan may be ' +
      'slightly rotated or warped: output a perfectly straight, level version. Reproduce ALL ' +
      'German text and labels exactly as in the scan — do not invent, translate or omit any ' +
      'text. Keep the layout and proportions of the original drawing. Vivid but tasteful ' +
      'colors in early-1980s home computer style. Output a flat image on a plain white ' +
      'background with no mockup, no perspective, no added borders or decorations.',
    outName: 'book.md',
    // Write the request to debug/ and skip the API call (no key required).
    dryRun: false,
    prompt: [
      'You are transcribing one scanned page of a German book that teaches Sinclair ZX Spectrum',
      'BASIC programming. Convert the page into GitHub-flavored Markdown.',
      '',
      'Rules:',
      '- Transcribe ONLY the body content: headings, paragraphs, lists, tables, BASIC program',
      '  listings, screen output and figures.',
      '- OMIT the page number and the running head/page title. If the page contains nothing but',
      '  front matter (title page, imprint, table of contents, preface) or is blank, output',
      '  exactly [SKIP] and nothing else.',
      '- Keep the original German wording, spelling and punctuation exactly as printed.',
      '  Never translate, never paraphrase, never modernize.',
      '- Headings: # for chapter titles, ## for sections, ### for subsections. Do not invent',
      '  headings that are not printed on the page.',
      '- BASIC program listings go into fenced code blocks with language `basic`. Preserve line',
      '  numbers, spacing and special characters exactly as printed. Screen output, keyboard',
      '  dialogs or error messages that are not program listings go into fenced code blocks with',
      '  language `text`.',
      '- BASIC keywords, variables or expressions mentioned inside a sentence are wrapped in',
      '  `backticks`.',
      '- Join words that are hyphenated across a line break (German Silbentrennung), and join the',
      '  lines of a paragraph into flowing text. Keep hyphens that belong to the word itself.',
      '- Tables become GitHub Markdown tables. Two-column term/definition layouts (a keyword in',
      '  the left column, its explanation on the right) are tables too. If the table has no',
      '  printed header row, use an empty header: a `| | |` row followed by `|---|---|`.',
      '- For every figure, diagram, screenshot or photo emit a placeholder on its own line:',
      '  [FIGURE ymin,xmin,ymax,xmax: caption] where the coordinates are the bounding box of the',
      '  figure on the page, normalized to 0-1000 with the origin at the top-left. Put the printed',
      '  caption (if any) into the placeholder and nowhere else; leave it empty if there is none.',
      '  Do not describe the figure in the text.',
      '- If the LAST paragraph, code block or table of this page visibly continues on the next',
      '  page, end your output with [CONT] on its own line. If the FIRST paragraph, code block or',
      '  table continues from the previous page, start your output with [CONT] on its own line.',
      '  Rows that continue a term/definition table from the previous page must be transcribed as',
      '  table rows with the same columns (repeat the empty header), not as paragraphs.',
      '- Output raw Markdown only: no commentary, no surrounding code fence.',
    ].join('\n'),
  },
  report: {
    thumbWidth: 360,
  },
};

export function loadConfig(configPath, setOverrides = []) {
  let fileConfig = {};
  if (configPath && fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), fileConfig);
  for (const kv of setOverrides) {
    const eq = kv.indexOf('=');
    if (eq < 0) throw new Error(`--set expects stage.key=value, got "${kv}"`);
    const dotPath = kv.slice(0, eq);
    const raw = kv.slice(eq + 1);
    setDeep(config, dotPath.split('.'), parseValue(raw));
  }
  return config;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // plain string
  }
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function setDeep(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
