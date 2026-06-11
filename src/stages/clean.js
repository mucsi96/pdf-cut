import path from 'node:path';
import { run } from '../exec.js';

export const name = 'clean';
export const dir = '50-clean';
export const configKey = 'clean';
export const title = 'Remove scanner residue, flatten background, smart binarize';

export async function run_(ctx, { stageDir, params }) {
  await run('python3', [
    path.join(ctx.scriptsDir, 'clean.py'),
    '--input-dir', ctx.dir('deskew'),
    '--output-dir', stageDir,
    '--debug-dir', path.join(stageDir, 'debug'),
    '--dpi', String(ctx.config.extract.dpi),
    '--params', JSON.stringify(params),
  ], { label: 'clean.py' });
}

export { run_ as run };
