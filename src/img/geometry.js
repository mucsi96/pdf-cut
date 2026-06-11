export const MM_PER_INCH = 25.4;

export function pxToMm(px, dpi) {
  return (px / dpi) * MM_PER_INCH;
}

export function mmToPx(mm, dpi) {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

export function clampBox(box, width, height) {
  const x0 = Math.max(0, Math.min(Math.round(box.x), width - 1));
  const y0 = Math.max(0, Math.min(Math.round(box.y), height - 1));
  const x1 = Math.max(x0 + 1, Math.min(Math.round(box.x + box.w), width));
  const y1 = Math.max(y0 + 1, Math.min(Math.round(box.y + box.h), height));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function dilateBox(box, px) {
  return { x: box.x - px, y: box.y - px, w: box.w + 2 * px, h: box.h + 2 * px };
}

export function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y
  };
}

export function median(values) {
  if (values.length === 0) throw new Error('median of empty array');
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
