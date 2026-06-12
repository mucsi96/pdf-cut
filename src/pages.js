/**
 * Parse a page range expression like "1-3,7,10-12" into a sorted array of
 * unique integers. Returns null for empty/undefined (meaning: all pages).
 */
export function parsePageRange(expr) {
  if (!expr) return null;
  const pages = new Set();
  for (const part of String(expr).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Invalid page range element: "${p}"`);
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    if (to < from) throw new Error(`Invalid page range: "${p}"`);
    for (let i = from; i <= to; i++) pages.add(i);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Zero-padded 4-digit page id used in all file names. */
export function pad(n) {
  return String(n).padStart(4, '0');
}
