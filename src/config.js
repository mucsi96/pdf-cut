// Central tuning knobs. Stage tuning loop: tweak here, then re-run with
// --force <stage> and inspect work/debug/index.html.
export const defaults = {
  dpi: 600,

  models: {
    // Vision analysis (QA pass), structured JSON output.
    vision: process.env.PDFCUT_VISION_MODEL || 'gemini-2.5-flash',
    // Anthropic fallback for --vision-provider anthropic.
    anthropicVision: process.env.PDFCUT_ANTHROPIC_VISION_MODEL || 'claude-sonnet-4-6',
    // Color cover recreation. Model IDs churn; override via env when needed.
    cover: process.env.PDFCUT_COVER_MODEL || 'gemini-3-pro-image-preview'
  },

  split: {
    // Search for the gutter valley within this central fraction of scan width.
    centerBandFraction: 0.2,
    // A valley must be this much brighter than the band average to be trusted,
    // otherwise we fall back to the exact midpoint (e.g. on the cover spine).
    minValleyContrast: 0.15,
    // Low-ink runs must be at least this wide to qualify as the gutter (so
    // the cut never lands tight against content); the most central
    // qualifying run wins. Binding-shadow bars stranded on either side of
    // the cut are erased later by preclean's bar classifier.
    minGutterRunMm: 6
  },

  deskew: {
    maxAngleDeg: 3,
    coarseStepDeg: 0.1,
    fineStepDeg: 0.02,
    // Skew is measured on a downscale at this DPI (fast, plenty accurate).
    analysisDpi: 100,
    darkThreshold: 128,
    // Components larger than this in BOTH dimensions (illustrations, photos)
    // are excluded from the projection profile: their diagonal strokes would
    // otherwise out-vote the text lines and rotate the page the wrong way.
    excludeLargeMm: 10
  },

  preclean: {
    // Downscale factor for border-connected residue detection (JS fallback).
    analysisMaxDim: 1200,
    darkThreshold: 160,
    // Rows/cols need at least this many dark px (at analysis scale) to count
    // as content when computing the content bounding box.
    minInkPx: 3,
    // --- OpenCV residue detection (python helper; preferred path) ---
    // Masses thicker than this survive the morphological opening; thin text
    // strokes vanish, so residue never drags touching text along.
    // Mid-gray scanner streaks must count as dark, hence the high threshold;
    // only masses thicker than residueThickMm can become residue anyway.
    residueThreshold: 160,
    residueThickMm: 1.5,
    residueMinMm: 4,
    residueBigMm: 12,
    residueAspect: 3,
    residuePadMm: 1,
    glyphMinMm: 0.6,
    marginPadMm: 3,
    // --- JS fallback (no python available) ---
    // Residue removal erases dark regions touching (or lying within) a band
    // from the page edge. Sides get a wide band (binding shadows, slivers of
    // the neighbor page); top/bottom must stay small because running headers
    // and page numbers sit close to the edge on tight scans.
    borderBandSideMm: 3,
    borderBandTopBottomMm: 1.5,
    // Detached vertical residue bars anywhere in the outer fifth of the page
    // (binding shadows that survive the border band): thinner than barMaxWMm
    // and taller than barMinHMm get erased explicitly.
    barMaxWMm: 3,
    barMinHMm: 25,
    barOuterFrac: 0.2,
    // Padding kept around the detected content box before erasing outside it.
    keepPadMm: 2,
    // Final page margins applied around the registered content block.
    marginTopMm: 12,
    marginBottomMm: 12,
    marginSideMm: 10
  },

  inpaint: {
    // OpenCV punch-hole detection: solid round dark blobs in this physical
    // size range, scored by circularity/solidity; filled locally with LaMa.
    holeMinMm: 3,
    holeMaxMm: 10,
    holeCircularity: 0.6,
    holeSolidity: 0.85,
    holeDilate: 0.25,
    darkThreshold: 80,
    // Context handed to LaMa around each hole.
    contextMm: 8
  },

  analyze: {
    // Pages are downscaled to this max dimension before being sent to the
    // vision model.
    maxDim: 1536
  },

  cover: {
    imageSize: '4K',
    jpegQuality: 92
  },

  assemble: {
    // 'auto' derives the physical size from the registered page pixel size.
    pageSize: 'auto'
  },

  debug: {
    thumbMaxDim: 480
  }
};

export const STAGE_NAMES = [
  'rasterize',
  'split',
  'preclean',
  'analyze',
  'inpaint',
  'deskew',
  'cover',
  'assemble'
];

export function stageDir(workdir, name) {
  const idx = STAGE_NAMES.indexOf(name);
  if (idx === -1) throw new Error(`Unknown stage: ${name}`);
  return `${workdir}/${String(idx).padStart(2, '0')}-${name}`;
}
