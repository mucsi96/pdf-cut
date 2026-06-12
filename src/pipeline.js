import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashParams, isUpToDate, readManifest, writeManifest } from './manifest.js';

import * as extract from './stages/extract.js';
import * as cover from './stages/cover.js';
import * as split from './stages/split.js';
import * as deskew from './stages/deskew.js';
import * as clean from './stages/clean.js';
import * as detectHoles from './stages/detectHoles.js';
import * as inpaint from './stages/inpaint.js';
import * as report from './stages/report.js';
import * as assemble from './stages/assemble.js';
import * as markdown from './stages/markdown.js';

// Canonical order. `cover` is a side branch consuming only scan-0001.
// `markdown` is opt-in (one Gemini call per page) and never runs as part of a
// range selection — only when named explicitly.
export const STAGES = [extract, cover, split, deskew, clean, detectHoles, inpaint, report, assemble, markdown];

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function stageByName(name) {
  const s = STAGES.find((st) => st.name === name);
  if (!s) throw new Error(`Unknown stage "${name}". Stages: ${STAGES.map((x) => x.name).join(', ')}`);
  return s;
}

export function selectStages({ stages, from, to }) {
  if (stages) {
    return stages.split(',').map((s) => stageByName(s.trim()));
  }
  const fromIdx = from ? STAGES.indexOf(stageByName(from)) : 0;
  const toIdx = to ? STAGES.indexOf(stageByName(to)) : STAGES.length - 1;
  if (fromIdx > toIdx) throw new Error(`--from ${from} comes after --to ${to}`);
  return STAGES.slice(fromIdx, toIdx + 1).filter((s) => !s.optIn || s.name === from || s.name === to);
}

export function makeContext({ config, inputPdf, workRoot, outputDir, pages, force, skipCover }) {
  const ctx = {
    config,
    inputPdf: path.resolve(inputPdf),
    workRoot: path.resolve(workRoot),
    outputDir: path.resolve(outputDir),
    appRoot: APP_ROOT,
    scriptsDir: path.join(APP_ROOT, 'scripts'),
    pages, // array of PDF scan numbers, or null = all
    force: !!force,
    skipCover: !!skipCover,
    log: (msg) => console.log(msg),
    dir: (stageName) => path.join(path.resolve(workRoot), stageByName(stageName).dir),
    // Effective scan DPI, resolved by the extract stage ("auto" reads it from
    // the PDF itself); falls back to a numeric config value.
    dpi: () => {
      const m = readManifest(ctx.dir('extract'));
      if (m?.dpi) return m.dpi;
      return typeof config.extract.dpi === 'number' ? config.extract.dpi : 600;
    },
  };
  return ctx;
}

export async function runPipeline(ctx, stages) {
  fs.mkdirSync(ctx.workRoot, { recursive: true });
  fs.mkdirSync(ctx.outputDir, { recursive: true });
  const t0 = Date.now();
  for (const stage of stages) {
    const stageDir = path.join(ctx.workRoot, stage.dir);
    const params = ctx.config[stage.configKey] ?? {};
    const paramsHash = hashParams({ params, pages: ctx.pages, input: ctx.inputPdf });

    if (!stage.alwaysRun && !ctx.force && isUpToDate(stageDir, paramsHash)) {
      ctx.log(`■ ${stage.name}: up to date (use --force to re-run)`);
      continue;
    }
    if (stage.name === 'cover' && ctx.skipCover) {
      ctx.log(`■ ${stage.name}: skipped (--skip-cover)`);
      continue;
    }

    ctx.log(`■ ${stage.name}: running …`);
    // preserveDir stages keep their per-page artifacts when re-run with the
    // same parameters (resume after an interrupted run); anything else — and
    // --force — starts from a clean directory.
    const keepDir = stage.preserveDir && !ctx.force && readManifest(stageDir)?.paramsHash === paramsHash;
    if (!keepDir) fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(stageDir, 'debug'), { recursive: true });
    if (stage.preserveDir) {
      // record the params before running, so a crashed run can be resumed
      writeManifest(stageDir, { stage: stage.name, params, paramsHash, pages: ctx.pages });
    }
    const start = Date.now();
    const extra = (await stage.run(ctx, { stageDir, params })) || {};
    writeManifest(stageDir, {
      stage: stage.name,
      params,
      paramsHash,
      pages: ctx.pages,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      ...extra,
    });
    ctx.log(`■ ${stage.name}: done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
  ctx.log(`Pipeline finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
