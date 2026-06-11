import fs from 'node:fs/promises';
import { defaults, STAGE_NAMES, stageDir } from './config.js';
import { loadManifest, saveManifest, paramsHash, fileHash } from './manifest.js';
import { log } from './util/log.js';
import { DebugReport } from './util/debugReport.js';

import * as rasterize from './stages/rasterize.js';
import * as split from './stages/split.js';
import * as deskew from './stages/deskew.js';
import * as preclean from './stages/preclean.js';
import * as analyze from './stages/analyze.js';
import * as inpaint from './stages/inpaint.js';
import * as cover from './stages/cover.js';
import * as assemble from './stages/assemble.js';

const STAGES = { rasterize, split, deskew, preclean, analyze, inpaint, cover, assemble };

export function resolveStageName(name) {
  if (!STAGE_NAMES.includes(name)) {
    throw new Error(`Unknown stage "${name}". Stages: ${STAGE_NAMES.join(', ')}`);
  }
  return name;
}

export async function runPipeline(opts) {
  const cfg = structuredClone(defaults);
  if (opts.dpi) cfg.dpi = Number(opts.dpi);
  if (opts.pageSize) cfg.assemble.pageSize = opts.pageSize;

  const ctx = {
    opts,
    cfg,
    input: opts.input,
    workdir: opts.workdir,
    inputHash: await fileHash(opts.input),
    debug: opts.debug ? new DebugReport(opts.workdir, cfg) : null
  };

  // The registered page geometry is established by preclean; preload it from
  // a previous run so later stages' params are stable when resuming.
  const precleanManifest = await loadManifest(stageDir(opts.workdir, 'preclean'));
  if (precleanManifest.window) ctx.window = { ...precleanManifest.window };

  const fromIdx = opts.from ? STAGE_NAMES.indexOf(resolveStageName(opts.from)) : 0;
  const toIdx = opts.to
    ? STAGE_NAMES.indexOf(resolveStageName(opts.to))
    : STAGE_NAMES.length - 1;
  const forced = new Set((opts.force || []).map(resolveStageName));

  let invalidateDownstream = false;
  for (let i = 0; i < STAGE_NAMES.length; i++) {
    const name = STAGE_NAMES[i];
    if (i > toIdx) break;
    const stage = STAGES[name];

    if (opts.skipAi && stage.aiStage) {
      log.stage(name, 'skipped (--skip-ai)');
      continue;
    }
    if ((opts.skipStages || []).includes(name)) {
      log.stage(name, 'skipped');
      continue;
    }
    if (i < fromIdx) continue;

    const dir = stageDir(ctx.workdir, name);
    await fs.mkdir(dir, { recursive: true });
    const hash = paramsHash(stage.params(ctx));
    let manifest = await loadManifest(dir);

    if (manifest.paramsHash !== hash || forced.has(name) || invalidateDownstream) {
      if (manifest.paramsHash !== null || forced.has(name)) {
        log.stage(name, 'invalidated (params changed or --force) — rebuilding');
      }
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      manifest = { paramsHash: hash, items: {} };
      invalidateDownstream = true;
    }

    const io = {
      dir,
      manifest,
      isDone: (key) => Boolean(manifest.items[key]),
      done: (key, meta = true) => {
        manifest.items[key] = meta;
      }
    };
    log.stage(name, 'running');
    const before = Object.keys(manifest.items).length;
    await stage.run(ctx, io);
    await saveManifest(dir, manifest);
    const after = Object.keys(manifest.items).length;
    log.stage(name, after === before ? 'done (all items up to date)' : `done (${after - before} new item(s))`);
  }

  if (ctx.debug) {
    const reportPath = await ctx.debug.writeReport();
    log.info(`Debug report: ${reportPath}`);
  }
}
