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

// Find the gutter (split x) of a 2-up landscape scan: among the low-ink runs
// within the central band, pick the one whose center is CLOSEST to the scan
// center — that is the physical binding, even when wider white margins exist
// next to dark binding-shadow bars. Falls back to the exact midpoint when
// there is no convincing valley (e.g. a dark cover spine).
export function detectGutter(raw, { centerBandFraction, minValleyContrast, minRunPx = 2 }) {
  const { width } = raw;
  // Light smoothing only: a heavier kernel erodes the narrow white gap
  // between binding-shadow bars below the minimum run width.
  const col = smooth(columnDarkness(raw), Math.max(1, Math.round(width / 600)));
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

  // Low-ink runs of at least minRunPx; choose the most central one.
  const limit = valley + 0.1 * (bandMean - valley);
  let best = null;
  let runStart = -1;
  for (let x = from; x <= to; x++) {
    const low = x < to && col[x] <= limit;
    if (low && runStart === -1) runStart = x;
    if (!low && runStart !== -1) {
      const len = x - runStart;
      if (len >= minRunPx) {
        const center = runStart + len / 2;
        const dist = Math.abs(center - width / 2);
        if (!best || dist < best.dist) best = { center, dist };
      }
      runStart = -1;
    }
  }
  if (!best) return { x: Math.round(width / 2), fallback: true, contrast, profile: col };
  return { x: Math.round(best.center), fallback: false, contrast, profile: col };
}

// Otsu's threshold over an 8-bit grayscale buffer.
export function otsuThreshold(data) {
  const hist = new Float64Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const total = data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 127;
  let maxVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      best = t;
    }
  }
  return best;
}

// Drop ink belonging to components that are large in BOTH dimensions
// (illustrations, photos): their diagonal strokes would out-vote the text
// lines in the projection profile and rotate the page the wrong way.
function dropLargeComponents(dark, width, height, maxPx) {
  const visited = new Uint8Array(dark.length);
  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || visited[start]) continue;
    const component = [start];
    visited[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = (start / width) | 0;
    let maxY = minY;
    for (let head = 0; head < component.length; head++) {
      const i = component[head];
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const m of [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1
      ]) {
        if (m >= 0 && dark[m] && !visited[m]) {
          visited[m] = 1;
          component.push(m);
        }
      }
    }
    if (maxX - minX + 1 > maxPx && maxY - minY + 1 > maxPx) {
      for (const i of component) dark[i] = 0;
    }
  }
}

// Detect text skew via projection-profile maximization (scored on the squared
// differences of adjacent row sums — sharp text lines give a spiky profile).
// Returns the angle in degrees to pass to a corrective rotation of -angle
// (positive = image content is rotated counter-clockwise relative to level).
export function detectSkew(raw, { maxAngleDeg, coarseStepDeg, fineStepDeg, darkThreshold, excludeLargePx = 0 }) {
  const { data, width, height } = raw;
  const thr = Math.min(otsuThreshold(data), darkThreshold + 64);
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < dark.length; i++) dark[i] = data[i] < thr ? 1 : 0;
  if (excludeLargePx > 0) dropLargeComponents(dark, width, height, excludeLargePx);

  const xs = [];
  const ys = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (dark[row + x]) {
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
    for (let b = 1; b < maxBins; b++) {
      const d = hist[b] - hist[b - 1];
      s += d * d;
    }
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
