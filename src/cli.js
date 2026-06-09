#!/usr/bin/env node
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { Command } from 'commander';
import { processPdf } from './process.js';

function toInt(value, name) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Option ${name} must be an integer, got "${value}".`);
  }
  return n;
}

function toFloat(value, name) {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) {
    throw new Error(`Option ${name} must be a number, got "${value}".`);
  }
  return n;
}

const program = new Command();

program
  .name('pdf-cut')
  .description(
    'Split a scanned book PDF (two book pages per sheet, side by side or stacked)\n' +
      'into a clean PDF with one scanned page per PDF page, automatically deskewed\n' +
      'and aligned.'
  )
  .argument('<input>', 'source PDF file')
  .option('-o, --output <file>', 'output PDF file (default: <input>.cut.pdf)')
  .option('-r, --dpi <n>', 'rasterization resolution in DPI', (v) => toInt(v, '--dpi'), 300)
  .option('--no-split', 'do not split sheets in half (deskew only)')
  .option(
    '--split-axis <axis>',
    'how to cut each sheet: auto (along the longer side), lr (left/right), tb (top/bottom)',
    'auto'
  )
  .option('--right-to-left', 'order the two halves right-to-left (e.g. manga/Hebrew)', false)
  .option('--no-deskew', 'disable automatic deskew/straightening')
  .option(
    '--deskew-threshold <pct>',
    'deskew sensitivity in percent',
    (v) => toFloat(v, '--deskew-threshold'),
    40
  )
  .option(
    '--rotate <deg>',
    'fixed rotation applied to every page before deskew',
    (v) => toFloat(v, '--rotate'),
    0
  )
  .option('--no-clean-edges', 'do not remove scanner-bed residue / edge bars')
  .option(
    '--edge-fuzz <pct>',
    'tolerance for the ImageMagick edge flood-fill fallback, in percent',
    (v) => toFloat(v, '--edge-fuzz'),
    30
  )
  .option(
    '--trim',
    'crop surrounding scanner margins (off by default — cropping makes pages ' +
      'different sizes; pages are otherwise kept at their original size)',
    false
  )
  .option('--fuzz <pct>', 'trim color tolerance in percent', (v) => toFloat(v, '--fuzz'), 15)
  .option(
    '--border <px>',
    'uniform white border added to every page (0 = keep original size)',
    (v) => toInt(v, '--border'),
    0
  )
  .option('--background <color>', 'fill/border color', 'white')
  .option('--no-smart', 'disable the Python stage (residue removal, text deskew, hole-fill)')
  .option('--no-fill-holes', 'do not detect and inpaint punch holes')
  .option(
    '--residue-threshold <n>',
    'darkness cutoff (0-255) for scanner-residue detection',
    (v) => toInt(v, '--residue-threshold'),
    110
  )
  .option(
    '--deskew-limit <deg>',
    'max skew angle searched by the text-based deskew',
    (v) => toFloat(v, '--deskew-limit'),
    8
  )
  .option('--hole-min-mm <mm>', 'smallest punch-hole diameter', (v) => toFloat(v, '--hole-min-mm'), 3)
  .option('--hole-max-mm <mm>', 'largest punch-hole diameter', (v) => toFloat(v, '--hole-max-mm'), 10)
  .option(
    '--dark-threshold <n>',
    'darkness cutoff (0-255) for hole detection',
    (v) => toInt(v, '--dark-threshold'),
    80
  )
  .option('--python <bin>', 'python interpreter for the AI stage', 'python3')
  .option('--device <dev>', 'torch device for LaMa inpainting (cpu/cuda)', 'cpu')
  .option('-j, --jobs <n>', 'number of pages to process in parallel', (v) => toInt(v, '--jobs'), 0)
  .option('--keep-temp', 'keep the temporary working directory', false)
  .option('-q, --quiet', 'suppress progress output', false)
  .version('1.0.0')
  .showHelpAfterError();

program.parse();

const opts = program.opts();
const input = program.args[0];

const output =
  opts.output ||
  path.join(
    path.dirname(input),
    `${path.basename(input, path.extname(input))}.cut.pdf`
  );

const jobs = opts.jobs && opts.jobs > 0 ? opts.jobs : Math.max(1, availableParallelism());

const log = opts.quiet ? () => {} : (msg) => process.stderr.write(`${msg}\n`);

try {
  await processPdf({
    input,
    output,
    dpi: opts.dpi,
    split: opts.split,
    splitAxis: opts.splitAxis,
    rightToLeft: opts.rightToLeft,
    deskew: opts.deskew,
    deskewThreshold: opts.deskewThreshold,
    rotate: opts.rotate,
    trim: opts.trim,
    fuzz: opts.fuzz,
    border: opts.border,
    background: opts.background,
    cleanEdges: opts.cleanEdges,
    edgeFuzz: opts.edgeFuzz,
    smart: opts.smart,
    fillHoles: opts.fillHoles,
    deskewLimit: opts.deskewLimit,
    holeMinMm: opts.holeMinMm,
    holeMaxMm: opts.holeMaxMm,
    darkThreshold: opts.darkThreshold,
    residueThreshold: opts.residueThreshold,
    pythonBin: opts.python,
    device: opts.device,
    jobs,
    keepTemp: opts.keepTemp,
    log,
  });
} catch (err) {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exit(1);
}
