#!/usr/bin/env node
import path from 'node:path';
import { program, Option } from 'commander';
import { runPipeline } from './pipeline.js';
import { STAGE_NAMES } from './config.js';
import { log } from './util/log.js';

function addCommonOptions(cmd) {
  return cmd
    .option('--pages <range>', 'scan page range, e.g. 1-3 or 1,4-6 (default: all)')
    .option('--workdir <dir>', 'work directory for intermediate stages', './work')
    .option('--out <file>', 'output PDF path', './output.pdf')
    .option('--dpi <n>', 'rasterization DPI', '600')
    .option('--no-extract', 'always render pages with pdftoppm instead of extracting the embedded scan image')
    .option('--debug', 'write annotated debug images + HTML report to <workdir>/debug', false)
    .option('--skip-ai', 'skip all AI stages (analyze/inpaint/cover) — offline mode', false)
    .option('--force <stages>', 'comma-separated stages to rebuild (with downstream)', (v) => v.split(','))
    .option('--page-size <size>', 'physical page size: auto, A4, A5 or WxHmm', 'auto')
    .option('--back-cover', 'also AI-recreate the back cover as the last page', false)
    .option('--swap-order', 'emit right page before left page per scan', false)
    .addOption(new Option('--vision-provider <p>', 'vision model provider').choices(['gemini', 'anthropic']).default('gemini'))
    .option('--concurrency <n>', 'parallel AI requests', '4')
    .option('--cover-prompt <text>', 'custom prompt for the cover recreation');
}

function requiredKeys(opts, { from, to } = {}) {
  if (opts.skipAi) return [];
  const fromIdx = from ? STAGE_NAMES.indexOf(from) : 0;
  const toIdx = to ? STAGE_NAMES.indexOf(to) : STAGE_NAMES.length - 1;
  const inRange = (s) => {
    const i = STAGE_NAMES.indexOf(s);
    return i >= fromIdx && i <= toIdx && !(opts.skipStages || []).includes(s);
  };
  const keys = new Set();
  if (inRange('analyze')) {
    keys.add(opts.visionProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY');
  }
  if (inRange('cover')) keys.add('GEMINI_API_KEY');
  return [...keys];
}

function checkKeys(opts, range) {
  const missing = requiredKeys(opts, range).filter((k) => !process.env[k]);
  if (missing.length) {
    log.error(
      `Missing API key(s): ${missing.join(', ')}.\n` +
        'Provide them via "podman run --env-file .env ..." (see .env.example) or use --skip-ai.'
    );
    process.exit(2);
  }
}

async function execute(fn) {
  try {
    await fn();
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
  }
}

program
  .name('pdf-cut')
  .description('Turn a 2-up scanned book PDF into a print-quality, AI-cleaned, one-page-per-page PDF');

addCommonOptions(
  program
    .command('process')
    .description('run the full pipeline')
    .argument('<input>', 'input scanned PDF')
    .option('--from <stage>', `first stage to run (${STAGE_NAMES.join(', ')})`)
    .option('--to <stage>', 'last stage to run')
).action((input, opts) =>
  execute(async () => {
    checkKeys(opts, { from: opts.from, to: opts.to });
    await runPipeline({ ...opts, input: path.resolve(input) });
  })
);

addCommonOptions(
  program
    .command('stage')
    .description('run exactly one stage (upstream stages must have run before)')
    .argument('<name>', `stage name: ${STAGE_NAMES.join(', ')}`)
    .argument('<input>', 'input scanned PDF')
).action((name, input, opts) =>
  execute(async () => {
    checkKeys(opts, { from: name, to: name });
    await runPipeline({ ...opts, input: path.resolve(input), from: name, to: name });
  })
);

addCommonOptions(
  program
    .command('cover')
    .description('process only the cover scan and AI-recreate the cover')
    .argument('<input>', 'input scanned PDF')
).action((input, opts) =>
  execute(async () => {
    const pipelineOpts = {
      ...opts,
      input: path.resolve(input),
      pages: opts.pages || '1',
      to: 'cover',
      skipStages: ['analyze', 'inpaint', 'deskew', 'binarize']
    };
    checkKeys(pipelineOpts, { to: 'cover' });
    await runPipeline(pipelineOpts);
  })
);

program
  .command('fixture')
  .description('generate a synthetic 2-up skewed test PDF (requires ImageMagick + img2pdf)')
  .option('--out <file>', 'output PDF path', './test-input.pdf')
  .option('--pages <n>', 'number of scan pages (first one is a cover)', '4')
  .option('--dpi <n>', 'fixture DPI (keep low for fast tests)', '150')
  .action((opts) =>
    execute(async () => {
      const { generateFixture } = await import('./fixture.js');
      await generateFixture({ out: path.resolve(opts.out), pages: Number(opts.pages), dpi: Number(opts.dpi) });
    })
  );

program.parseAsync();
