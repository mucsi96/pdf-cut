#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { parsePageRange } from './pages.js';
import { STAGES, selectStages, makeContext, runPipeline, stageByName } from './pipeline.js';

const program = new Command();
program.name('pdfcut').description('Restore a 2-up scanned book PDF into a print-quality single-page PDF');

const collect = (v, acc) => (acc.push(v), acc);

program
  .command('run', { isDefault: true })
  .allowExcessArguments(false) // unknown subcommands must error, not start the pipeline
  .description('Run the pipeline (or a subset of stages)')
  .option('--input <pdf>', 'input scanned PDF', 'input/book.pdf')
  .option('--work <dir>', 'work directory (per-stage outputs + debug images)', 'work')
  .option('--output <dir>', 'output directory for final PDFs', 'output')
  .option('--pages <range>', 'PDF scan pages to process, e.g. "1-3,7" (page 1 = cover)')
  .option('--stages <list>', 'comma-separated stage list, e.g. "deskew,clean"')
  .option('--from <stage>', 'start stage (inclusive)')
  .option('--to <stage>', 'end stage (inclusive)')
  .option('--config <file>', 'config file', 'pdfcut.config.json')
  .option('--set <stage.key=value>', 'override a config value (repeatable)', collect, [])
  .option('--force', 're-run stages even if up to date', false)
  .option('--skip-cover', 'skip Gemini cover recreation', false)
  .option('--cover-variants <n>', 'number of cover variants to generate')
  .action(async (opts) => {
    const config = loadConfig(opts.config, opts.set);
    if (opts.coverVariants) config.cover.variants = parseInt(opts.coverVariants, 10);
    const ctx = makeContext({
      config,
      inputPdf: opts.input,
      workRoot: opts.work,
      outputDir: opts.output,
      pages: parsePageRange(opts.pages),
      force: opts.force,
      skipCover: opts.skipCover,
    });
    if (!fs.existsSync(ctx.inputPdf)) {
      const needsInput = !opts.stages && !opts.from ? true : selectStages(opts).some((s) => s.name === 'extract');
      if (needsInput) {
        console.error(`Input PDF not found: ${ctx.inputPdf}`);
        process.exit(1);
      }
    }
    const stages = selectStages(opts);
    console.log(`Stages: ${stages.map((s) => s.name).join(' → ')}`);
    await runPipeline(ctx, stages);
  });

program
  .command('report')
  .description('(Re)generate work/report.html from whatever exists in the work dir')
  .option('--work <dir>', 'work directory', 'work')
  .option('--config <file>', 'config file', 'pdfcut.config.json')
  .action(async (opts) => {
    const config = loadConfig(opts.config, []);
    const ctx = makeContext({ config, inputPdf: '-', workRoot: opts.work, outputDir: 'output', pages: null });
    await runPipeline(ctx, [stageByName('report')]);
  });

program
  .command('markdown')
  .description('Transcribe the cleaned book pages to output/book.md with Gemini (body text + figures)')
  .option('--work <dir>', 'work directory', 'work')
  .option('--output <dir>', 'output directory', 'output')
  .option('--config <file>', 'config file', 'pdfcut.config.json')
  .option('--body-pages <range>', 'book pages to transcribe, e.g. "12-181" (default: all, model skips front matter)')
  .option('--set <stage.key=value>', 'override a config value (repeatable)', collect, [])
  .option('--force', 'discard cached page transcriptions and re-run', false)
  .action(async (opts) => {
    const config = loadConfig(opts.config, opts.set);
    if (opts.bodyPages) config.markdown.bodyPages = opts.bodyPages;
    const ctx = makeContext({ config, inputPdf: '-', workRoot: opts.work, outputDir: opts.output, pages: null, force: opts.force });
    await runPipeline(ctx, [stageByName('markdown')]);
  });

program
  .command('slice')
  .description('Cut a page range out of a PDF into a new (small) PDF, e.g. to share a test sample')
  .requiredOption('--pages <range>', 'pages to keep, e.g. "1-10,15"')
  .option('--input <pdf>', 'input PDF', 'input/book.pdf')
  .option('--output <pdf>', 'output PDF (default: <input>-pages-<range>.pdf)')
  .action(async (opts) => {
    const { run } = await import('./exec.js');
    parsePageRange(opts.pages); // validate syntax
    const output = opts.output
      || opts.input.replace(/\.pdf$/i, '') + `-pages-${opts.pages.replace(/[^\d,-]/g, '')}.pdf`;
    // qpdf copies the page objects (and their compressed image streams)
    // byte-for-byte; pdfseparate/pdfunite would re-encode JPEG scans as Flate
    // and blow the file up ~10x.
    await run('qpdf', [opts.input, '--pages', '.', opts.pages, '--', output], { quiet: true });
    const { stdout } = await run('pdfinfo', [output], { capture: true, quiet: true });
    const n = stdout.match(/^Pages:\s+(\d+)/m)?.[1];
    console.log(`wrote ${output} (${n} pages, ${(fs.statSync(output).size / 1e6).toFixed(1)} MB)`);
  });

program
  .command('stages')
  .description('List the canonical stage order')
  .action(() => {
    for (const s of STAGES) {
      console.log(`${s.name.padEnd(14)} work/${s.dir.padEnd(16)} ${s.title}`);
    }
  });

program
  .command('clean-work')
  .description('Delete work dirs (optionally only from a stage onward)')
  .option('--work <dir>', 'work directory', 'work')
  .option('--from <stage>', 'first stage to delete (inclusive)')
  .action((opts) => {
    const fromIdx = opts.from ? STAGES.indexOf(stageByName(opts.from)) : 0;
    for (const s of STAGES.slice(fromIdx)) {
      const dir = path.join(opts.work, s.dir);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        console.log(`removed ${dir}`);
      }
    }
    const report = path.join(opts.work, 'report.html');
    if (fromIdx === 0 && fs.existsSync(report)) fs.rmSync(report);
  });

program.parseAsync().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
