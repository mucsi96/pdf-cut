import sharp from 'sharp';
import { clampBox, dilateBox, boxesOverlap } from './geometry.js';

// Group holes into patches of patchSize x patchSize. A patch is positioned so
// the hole(s) sit centered where possible; holes whose dilated boxes fall
// inside an existing patch (with margin) share it.
export function planPatches(holeBoxes, pageW, pageH, { patchSize, dilatePx }) {
  const patches = [];
  for (const hole of holeBoxes) {
    const dilated = clampBox(dilateBox(hole, dilatePx), pageW, pageH);
    const existing = patches.find((p) =>
      boxesOverlap(p.rect, dilated) &&
      dilated.x >= p.rect.x && dilated.y >= p.rect.y &&
      dilated.x + dilated.w <= p.rect.x + p.rect.w &&
      dilated.y + dilated.h <= p.rect.y + p.rect.h
    );
    if (existing) {
      existing.holes.push(dilated);
      continue;
    }
    const cx = dilated.x + dilated.w / 2;
    const cy = dilated.y + dilated.h / 2;
    // Keep the patch inside the page when the page is large enough; otherwise
    // anchor at 0 and let extraction pad with white.
    const px = pageW >= patchSize
      ? Math.round(Math.min(Math.max(cx - patchSize / 2, 0), pageW - patchSize))
      : 0;
    const py = pageH >= patchSize
      ? Math.round(Math.min(Math.max(cy - patchSize / 2, 0), pageH - patchSize))
      : 0;
    patches.push({ rect: { x: px, y: py, w: patchSize, h: patchSize }, holes: [dilated] });
  }
  return patches;
}

// Extract a patch as an sRGB PNG, padding with white where the patch rect
// extends past the page.
export async function extractPatchPng(pagePath, rect, pageW, pageH) {
  const left = rect.x;
  const top = rect.y;
  const width = Math.min(rect.w, pageW - left);
  const height = Math.min(rect.h, pageH - top);
  let img = sharp(pagePath).extract({ left, top, width, height });
  if (width < rect.w || height < rect.h) {
    img = img.extend({
      right: rect.w - width,
      bottom: rect.h - height,
      background: '#ffffff'
    });
  }
  return img.toColourspace('srgb').png().toBuffer();
}

function holeEllipses(holes, rect) {
  return holes.map((h) => ({
    cx: h.x + h.w / 2 - rect.x,
    cy: h.y + h.h / 2 - rect.y,
    rx: h.w / 2,
    ry: h.h / 2
  }));
}

// RGBA PNG mask for images.edit: opaque everywhere, alpha=0 inside the
// (dilated) hole ellipses.
export async function buildMaskPng(rect, holes) {
  const { w, h } = rect;
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (const e of holeEllipses(holes, rect)) {
    const x0 = Math.max(0, Math.floor(e.cx - e.rx));
    const x1 = Math.min(w - 1, Math.ceil(e.cx + e.rx));
    const y0 = Math.max(0, Math.floor(e.cy - e.ry));
    const y1 = Math.min(h - 1, Math.ceil(e.cy + e.ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - e.cx) / e.rx;
        const dy = (y - e.cy) / e.ry;
        if (dx * dx + dy * dy <= 1) rgba[(y * w + x) * 4 + 3] = 0;
      }
    }
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

function boxBlur(src, w, h, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src[y * w + Math.min(Math.max(x, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / (2 * radius + 1);
      const add = Math.min(x + radius + 1, w - 1);
      const sub = Math.max(x - radius, 0);
      sum += src[y * w + add] - src[y * w + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * radius + 1);
      const add = Math.min(y + radius + 1, h - 1);
      const sub = Math.max(y - radius, 0);
      sum += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

// Feathered blend weight (1 = take AI pixels) over the patch area.
export function featherAlpha(rect, holes, featherPx) {
  const { w, h } = rect;
  const a = new Float32Array(w * h);
  for (const e of holeEllipses(holes, rect)) {
    const x0 = Math.max(0, Math.floor(e.cx - e.rx));
    const x1 = Math.min(w - 1, Math.ceil(e.cx + e.rx));
    const y0 = Math.max(0, Math.floor(e.cy - e.ry));
    const y1 = Math.min(h - 1, Math.ceil(e.cy + e.ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - e.cx) / e.rx;
        const dy = (y - e.cy) / e.ry;
        if (dx * dx + dy * dy <= 1) a[y * w + x] = 1;
      }
    }
  }
  return featherPx > 0 ? boxBlur(a, w, h, featherPx) : a;
}

// Blend the AI patch into the full-page grayscale raw buffer, in place.
export function compositePatch(pageRaw, aiRaw, rect, alpha) {
  const { data, width, height } = pageRaw;
  for (let py = 0; py < rect.h; py++) {
    const y = rect.y + py;
    if (y < 0 || y >= height) continue;
    for (let px = 0; px < rect.w; px++) {
      const x = rect.x + px;
      if (x < 0 || x >= width) continue;
      const a = alpha[py * rect.w + px];
      if (a <= 0) continue;
      const i = y * width + x;
      data[i] = Math.round(aiRaw[py * rect.w + px] * a + data[i] * (1 - a));
    }
  }
}
