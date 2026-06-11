import path from 'node:path';
import { run } from '../exec.js';

export const name = 'deskew';
export const dir = '40-deskew';
export const configKey = 'deskew';
export const title = 'Estimate and correct page rotation';

export async function run_(ctx, { stageDir, params }) {
  await run('python3', [
    path.join(ctx.scriptsDir, 'deskew.py'),
    '--input-dir', ctx.dir('split'),
    '--output-dir', stageDir,
    '--debug-dir', path.join(stageDir, 'debug'),
    '--dpi', String(ctx.config.extract.dpi),
    '--params', JSON.stringify(params),
  ], { label: 'deskew.py' });
}

export { run_ as run };
