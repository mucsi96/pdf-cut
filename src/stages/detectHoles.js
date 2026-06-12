import path from 'node:path';
import { run } from '../exec.js';

export const name = 'detect-holes';
export const dir = '60-detect-holes';
export const configKey = 'detect';
export const title = 'Detect punch holes, emit inpainting masks';

/**
 * Detection runs on the DESKEWED pages (before clean), because the clean
 * stage may whiten the black hole disc and destroy the detection evidence.
 * The masks still apply 1:1 to the cleaned pages — clean never moves pixels.
 */
export async function run_(ctx, { stageDir, params }) {
  await run('python3', [
    path.join(ctx.scriptsDir, 'detect_holes.py'),
    '--input-dir', ctx.dir('deskew'),
    '--output-dir', stageDir,
    '--debug-dir', path.join(stageDir, 'debug'),
    '--dpi', String(ctx.dpi()),
    '--params', JSON.stringify(params),
  ], { label: 'detect_holes.py' });
}

export { run_ as run };
