import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { log } from './log.js';

const HELPER = fileURLToPath(new URL('../../python/pdf_fix.py', import.meta.url));
const PYTHON = process.env.PDFCUT_PYTHON || 'python3';

const checkCache = new Map();

// Verify the OpenCV (and optionally LaMa) toolchain once per process so the
// stages can fall back gracefully when it is not installed.
export async function pythonAvailable({ needLama = false } = {}) {
  const cacheKey = String(needLama);
  if (checkCache.has(cacheKey)) return checkCache.get(cacheKey);
  let ok = false;
  try {
    const args = [HELPER, '--check'];
    if (needLama) args.push('--need-lama');
    await execa(PYTHON, args);
    ok = true;
  } catch (err) {
    log.warn(`python helper unavailable (${needLama ? 'opencv+lama' : 'opencv'}): ${err.stderr || err.shortMessage || err.message}`);
  }
  checkCache.set(cacheKey, ok);
  return ok;
}

// Run one helper operation over a batch of items; returns a Map key → result.
export async function runPythonOp(op, items, flags) {
  const manifest = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pdfcut-py-')), 'manifest.json');
  await fs.writeFile(manifest, JSON.stringify(items));
  const args = [HELPER, '--op', op, '--manifest', manifest];
  for (const [k, v] of Object.entries(flags)) args.push(`--${k}`, String(v));
  try {
    const { stdout, stderr } = await execa(PYTHON, args);
    if (stderr) for (const line of stderr.split('\n')) if (line.trim()) log.stage(op, line.trim());
    const results = new Map();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      results.set(obj.key, obj);
    }
    return results;
  } finally {
    await fs.rm(path.dirname(manifest), { recursive: true, force: true });
  }
}
