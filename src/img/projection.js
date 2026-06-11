import sharp from 'sharp';

// Load an image (path or buffer) as a grayscale raw buffer, optionally
// downscaled so its longest side is maxDim.
export async function toGrayRaw(input, { maxDim } = {}) {
  let img = sharp(input).grayscale();
  if (maxDim) img = img.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Mean darkness (0..1) per column.
export function columnDarkness({ data, width, height }) {
  const sums = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) sums[x] += 255 - data[row + x];
  }
  const out = new Float64Array(width);
  for (let x = 0; x < width; x++) out[x] = sums[x] / (height * 255);
  return out;
}

function smooth(values, radius) {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

// Find the gutter (split x) of a 2-up landscape scan: the center of the
// widest low-ink valley within the central band. Falls back to the exact
// midpoint when there is no convincing valley (e.g. a dark cover spine).
export function detectGutter(raw, { centerBandFraction, minValleyContrast }) {
  const { width } = raw;
  const col = smooth(columnDarkness(raw), Math.max(2, Math.round(width / 300)));
  const from = Math.round(width * (0.5 - centerBandFraction / 2));
  const to = Math.round(width * (0.5 + centerBandFraction / 2));

  let bandSum = 0;
  let valley = Infinity;
  for (let x = from; x < to; x++) {
    bandSum += col[x];
    if (col[x] < valley) valley = col[x];
  }
  const bandMean = bandSum / (to - from);
  const contrast = bandMean > 1e-6 ? (bandMean - valley) / bandMean : 0;
  if (contrast < minValleyContrast) {
    return { x: Math.round(width / 2), fallback: true, contrast, profile: col };
  }

  // Center of the widest run of near-valley columns.
  const limit = valley + 0.1 * (bandMean - valley);
  let best = { start: -1, len: 0 };
  let runStart = -1;
  for (let x = from; x <= to; x++) {
    const low = x < to && col[x] <= limit;
    if (low && runStart === -1) runStart = x;
    if (!low && runStart !== -1) {
      if (x - runStart > best.len) best = { start: runStart, len: x - runStart };
      runStart = -1;
    }
  }
  return {
    x: Math.round(best.start + best.len / 2),
    fallback: false,
    contrast,
    profile: col
  };
}

// Detect text skew via projection-profile variance maximization.
// Returns the angle in degrees to pass to a corrective rotation of -angle
// (positive = image content is rotated counter-clockwise relative to level).
export function detectSkew(raw, { maxAngleDeg, coarseStepDeg, fineStepDeg, darkThreshold }) {
  const { data, width, height } = raw;
  const xs = [];
  const ys = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] < darkThreshold) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 100) return { angle: 0, score: 0, inkPx: xs.length };

  const maxBins = height + Math.ceil(width * Math.tan((maxAngleDeg * Math.PI) / 180)) * 2 + 4;
  const hist = new Float64Array(maxBins);
  const offset = Math.ceil(width * Math.tan((maxAngleDeg * Math.PI) / 180)) + 1;

  const score = (angleDeg) => {
    hist.fill(0);
    const t = Math.tan((angleDeg * Math.PI) / 180);
    for (let i = 0; i < xs.length; i++) {
      const bin = Math.round(ys[i] + xs[i] * t) + offset;
      hist[bin] += 1;
    }
    let s = 0;
    for (let b = 0; b < maxBins; b++) s += hist[b] * hist[b];
    return s;
  };

  const sweep = (from, to, step) => {
    let bestA = from;
    let bestS = -1;
    for (let a = from; a <= to + 1e-9; a += step) {
      const s = score(a);
      if (s > bestS) {
        bestS = s;
        bestA = a;
      }
    }
    return { angle: bestA, score: bestS };
  };

  const coarse = sweep(-maxAngleDeg, maxAngleDeg, coarseStepDeg);
  const fine = sweep(
    Math.max(-maxAngleDeg, coarse.angle - coarseStepDeg),
    Math.min(maxAngleDeg, coarse.angle + coarseStepDeg),
    fineStepDeg
  );
  // Sheared rows align with bin y + x*tan(a) when content lines follow
  // y = c - x*tan(a), i.e. the image needs rotation by +a to straighten.
  // We report the corrective angle directly.
  return { angle: -fine.angle, score: fine.score, inkPx: xs.length };
}
