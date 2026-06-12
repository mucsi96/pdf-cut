import path from 'node:path';
import { run } from '../exec.js';
import { readManifest } from '../manifest.js';
import { pad } from '../pages.js';

export const name = 'detect-holes';
export const dir = '60-detect-holes';
export const configKey = 'detect';
export const title = 'Detect punch holes, emit inpainting masks';

/**
 * Detection runs on the DESKEWED pages (before clean), because the clean
 * stage may whiten the black hole disc and destroy the detection evidence.
 * The masks still apply 1:1 to the cleaned pages — clean never moves pixels.
 *
 * The binding side of each page (left/right half of its spread) comes from
 * the split manifest: punch positions mirror between left and right pages,
 * and page-number parity is not a reliable proxy for the side.
 */
export async function run_(ctx, { stageDir, params }) {
  const splitManifest = readManifest(ctx.dir('split'));
  const sides = {};
  for (const [scanId, m] of Object.entries(splitManifest?.pageMap || {})) {
    if (m.single !== undefined) {
      // Single-page scans: sides alternate with the scan order.
      sides[pad(m.single)] = parseInt(scanId, 10) % 2 === 0 ? 'left' : 'right';
    } else {
      sides[pad(m.left)] = 'left';
      sides[pad(m.right)] = 'right';
    }
  }

  await run('python3', [
    path.join(ctx.scriptsDir, 'detect_holes.py'),
    '--input-dir', ctx.dir('deskew'),
    '--output-dir', stageDir,
    '--debug-dir', path.join(stageDir, 'debug'),
    '--dpi', String(ctx.dpi()),
    '--sides', JSON.stringify(sides),
    '--params', JSON.stringify(params),
  ], { label: 'detect_holes.py' });
}

export { run_ as run };
