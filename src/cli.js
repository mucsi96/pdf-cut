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
    'Split a scanned book PDF (two book pages per landscape sheet) into a clean\n' +
      'PDF with one scanned page per PDF page, automatically deskewed and aligned.'
  )
  .argument('<input>', 'source PDF file')
  .option('-o, --output <file>', 'output PDF file (default: <input>.cut.pdf)')
  .option('-r, --dpi <n>', 'rasterization resolution in DPI', (v) => toInt(v, '--dpi'), 300)
  .option('--no-split', 'do not split sheets in half (deskew only)')
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
  .option('--no-trim', 'do not trim surrounding scanner margins')
  .option('--fuzz <pct>', 'trim color tolerance in percent', (v) => toFloat(v, '--fuzz'), 15)
  .option('--border <px>', 'uniform border added back after trim', (v) => toInt(v, '--border'), 30)
  .option('--background <color>', 'fill/border/trim color', 'white')
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
    rightToLeft: opts.rightToLeft,
    deskew: opts.deskew,
    deskewThreshold: opts.deskewThreshold,
    rotate: opts.rotate,
    trim: opts.trim,
    fuzz: opts.fuzz,
    border: opts.border,
    background: opts.background,
    jobs,
    keepTemp: opts.keepTemp,
    log,
  });
} catch (err) {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exit(1);
}
