// Parse "1-3,7,10-12" into a sorted unique array of page numbers (1-based).
export function parsePageRange(spec, max = Infinity) {
  if (!spec) return null;
  const pages = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Invalid page range: "${part}"`);
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (to < from) throw new Error(`Invalid page range: "${part}"`);
    for (let p = from; p <= Math.min(to, max); p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

export function scanId(n) {
  return `scan-${String(n).padStart(4, '0')}`;
}

// Page keys carry the source scan number and side: page-0003-L / page-0003-R.
export function pageKey(scanNum, side) {
  return `page-${String(scanNum).padStart(4, '0')}-${side}`;
}

export function parsePageKey(key) {
  const m = key.match(/^page-(\d{4})-([LR])$/);
  if (!m) throw new Error(`Bad page key: ${key}`);
  return { scan: Number(m[1]), side: m[2] };
}
