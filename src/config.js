import fs from 'node:fs';

export const DEFAULT_CONFIG = {
  extract: {
    // "embedded": pull the raw scan bitmaps out of the PDF with pdfimages (no
    // resampling — true baseline). "render": rasterize with pdftoppm at `dpi`.
    // "auto": embedded when every page holds exactly one image, else render.
    mode: 'auto',
    dpi: 600,
  },
  cover: {
    model: 'gemini-3-pro-image-preview',
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
    // Book page number assigned to the LEFT half of the first spread (scan 2).
    firstBookPage: 2,
    order: 'left-first',
    // Per-scan centerRatio overrides, e.g. { "0012": 0.515 }
    overrides: {},
  },
  deskew: {
    maxAngle: 3.0,
    coarseStep: 0.25,
    fineStep: 0.05,
    downsample: 8,
    // Per-page fixed angle in degrees (skips estimation), e.g. { "0017": -0.4 }
    overrides: {},
  },
  clean: {
    // "smart-binarize": crisp B/W text with anti-aliased edges, illustrations
    // kept as untouched grayscale. "grayscale": flatten + highlight clip only.
    mode: 'smart-binarize',
    flatten: true,
    bgKernelPx: 81,
    bgFloor: 128,
    whitePoint: 210,
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    maxBorderIntrusionPx: 250,
    minSpeckArea: 60,
    despeckleBandPx: 350,
    // smart-binarize parameters
    sauvolaWindowPx: 61,
    sauvolaK: 0.2,
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
    minDiamMm: 4.5,
    maxDiamMm: 8.0,
    circularityMin: 0.65,
    edgeCircularityMin: 0.4,
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
