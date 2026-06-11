import { execa } from 'execa';
import { log } from './log.js';

export async function run(cmd, args, opts = {}) {
  try {
    return await execa(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (err) {
    log.error(`${cmd} ${args.join(' ')}\n${err.stderr || err.message}`);
    throw err;
  }
}

export async function pdfPageCount(pdfPath) {
  const { stdout } = await run('pdfinfo', [pdfPath]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error(`pdfinfo gave no page count for ${pdfPath}`);
  return Number(m[1]);
}
