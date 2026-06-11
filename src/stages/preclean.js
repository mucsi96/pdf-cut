import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { toGrayRaw } from '../img/projection.js';
import { analyzeContent } from '../img/content.js';
import { registerToWindow } from '../img/register.js';
import { mmToPx, percentile } from '../img/geometry.js';
import { pythonAvailable, runPythonOp } from '../util/pythonStage.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return {
    dpi: ctx.cfg.dpi,
    preclean: ctx.cfg.preclean,
    pageSize: ctx.cfg.assemble.pageSize,
    coverFullBleed: true
  };
}

const isCover = (key) => key.startsWith('page-0001');

function parsePageSize(spec, dpi) {
  if (spec === 'A5') return { w: mmToPx(148, dpi), h: mmToPx(210, dpi) };
  if (spec === 'A4') return { w: mmToPx(210, dpi), h: mmToPx(297, dpi) };
  const m = spec.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm$/);
  if (!m) throw new Error(`Bad --page-size "${spec}" (use auto, A4, A5 or WxHmm e.g. 148x210mm)`);
  return { w: mmToPx(Number(m[1]), dpi), h: mmToPx(Number(m[2]), dpi) };
}

export async function run(ctx, io) {
  const cfg = ctx.cfg.preclean;
  const dpi = ctx.cfg.dpi;
  const srcDir = stageDir(ctx.workdir, 'split');
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();

  // Pass A: residue removal + content bounding boxes, cached in the manifest.
  // Preferred path: OpenCV (python helper) — a morphological opening isolates
  // residue as solid masses painted white in place, so touching text is never
  // dragged along; the content box comes from glyph-sized components.
  // Fallback: JS border-band flood fill + bar classifier.
  const usePython = await pythonAvailable();
  const boxes = {};
  const residue = {};

  // Content box + hairline-bar detection on a (possibly pre-cleaned) page.
  const jsAnalyze = async (filePath, key, extraMeta = {}) => {
    const meta = await sharp(filePath).metadata();
    const raw = await toGrayRaw(filePath, { maxDim: cfg.analysisMaxDim });
    const scale = meta.width / raw.width;
    const { bbox, residueBoxes } = analyzeContent(raw, {
      ...cfg,
      removeEdgeConnected: !isCover(key),
      borderBandXPx: mmToPx(cfg.borderBandSideMm, dpi) / scale,
      borderBandYPx: mmToPx(cfg.borderBandTopBottomMm, dpi) / scale,
      barMaxWPx: mmToPx(cfg.barMaxWMm, dpi) / scale,
      barMinHPx: mmToPx(cfg.barMinHMm, dpi) / scale,
      barOuterFrac: cfg.barOuterFrac
    });
    const scaleBox = (b) => ({
      x: Math.round(b.x * scale),
      y: Math.round(b.y * scale),
      w: Math.round(b.w * scale),
      h: Math.round(b.h * scale)
    });
    boxes[key] = bbox ? scaleBox(bbox) : null;
    residue[key] = (residueBoxes || []).map(scaleBox);
    io.done(`bbox:${key}`, { bbox: boxes[key], residueBoxes: residue[key], ...extraMeta });
  };

  const pendingClean = [];
  for (const file of pages) {
    const key = file.replace('.png', '');
    const cacheKey = `bbox:${key}`;
    if (io.manifest.items[cacheKey]) {
      boxes[key] = io.manifest.items[cacheKey].bbox;
      residue[key] = io.manifest.items[cacheKey].residueBoxes || [];
      continue;
    }
    // Covers are full-bleed: residue removal must not run on them at all.
    if (usePython && !isCover(key)) {
      pendingClean.push({ key, file });
    } else {
      await jsAnalyze(path.join(srcDir, file), key);
    }
  }

  // OpenCV pass: paint thick residue masses white IN PLACE (the morphological
  // opening cannot drag touching text along). The JS analysis then runs on
  // the cleaned image, where the border flood can no longer leak into text
  // and only hairline bars are left for the stroke-width classifier.
  if (pendingClean.length) {
    log.stage('preclean', `OpenCV residue removal on ${pendingClean.length} page(s)`);
    const results = await runPythonOp(
      'clean',
      pendingClean.map((p) => ({
        key: p.key,
        input: path.join(srcDir, p.file),
        output: path.join(io.dir, `${p.key}.clean.png`)
      })),
      {
        dpi,
        'residue-threshold': cfg.residueThreshold,
        'residue-thick-mm': cfg.residueThickMm,
        'residue-min-mm': cfg.residueMinMm,
        'residue-big-mm': cfg.residueBigMm,
        'residue-aspect': cfg.residueAspect,
        'residue-pad-mm': cfg.residuePadMm,
        'glyph-min-mm': cfg.glyphMinMm,
        'margin-pad-mm': cfg.marginPadMm
      }
    );
    for (const { key } of pendingClean) {
      const r = results.get(key);
      if (!r) throw new Error(`preclean: python helper returned no result for ${key}`);
      await jsAnalyze(path.join(io.dir, `${key}.clean.png`), key, {
        cleaned: true,
        paintedPx: r.paintedPx
      });
    }
  }

  // Window: the fixed output page geometry all content is registered into.
  // The cover scan (0001) is excluded from the statistics — it is full-bleed
  // and would skew the content-size medians; it gets clipped/centered instead.
  const innerKeys = Object.keys(boxes).filter((k) => boxes[k] && !k.startsWith('page-0001'));
  const statKeys = innerKeys.length > 0 ? innerKeys : Object.keys(boxes).filter((k) => boxes[k]);

  let window = io.manifest.window;
  if (statKeys.length === 0) {
    // Nothing measurable (e.g. cover-only run on a full-bleed cover): fall
    // back to the raw split-page geometry.
    if (!window) {
      const meta = await sharp(path.join(srcDir, pages[0])).metadata();
      window = { w: meta.width, h: meta.height, topPx: mmToPx(cfg.marginTopMm, dpi), statPages: 0 };
      io.manifest.window = window;
    }
  } else if (!window || statKeys.length > window.statPages) {
    const topPx = mmToPx(cfg.marginTopMm, dpi);
    let w;
    let h;
    if (ctx.cfg.assemble.pageSize === 'auto') {
      // 90th percentile: the window must fit full body pages, while ignoring
      // a stray outlier (e.g. residue that escaped cleanup on one page).
      w = Math.round(percentile(statKeys.map((k) => boxes[k].w), 0.9)) + 2 * mmToPx(cfg.marginSideMm, dpi);
      h = Math.round(percentile(statKeys.map((k) => boxes[k].h), 0.9)) + topPx + mmToPx(cfg.marginBottomMm, dpi);
    } else {
      ({ w, h } = parsePageSize(ctx.cfg.assemble.pageSize, dpi));
    }
    const fresh = { w, h, topPx, statPages: statKeys.length };
    if (window && (window.w !== fresh.w || window.h !== fresh.h)) {
      log.stage('preclean', 'page window changed with larger page set — rebuilding pages');
      for (const k of Object.keys(io.manifest.items)) {
        if (!k.startsWith('bbox:')) delete io.manifest.items[k];
      }
    }
    window = fresh;
    io.manifest.window = window;
  }
  ctx.window = { ...window };
  log.stage('preclean', `page window ${window.w}x${window.h} px (${(window.w / dpi * 25.4).toFixed(1)}x${(window.h / dpi * 25.4).toFixed(1)} mm)`);

  // Pass B: erase everything outside the content box and register the content
  // into the window (horizontal center, top at the top margin).
  const pad = mmToPx(cfg.keepPadMm, dpi);
  for (const file of pages) {
    const key = file.replace('.png', '');
    if (io.isDone(key)) continue;
    const srcPath = path.join(srcDir, file);
    const outPath = path.join(io.dir, `${key}.png`);
    const bbox = boxes[key];

    // Prefer the OpenCV-cleaned page (residue painted white in place).
    let src = srcPath;
    if (io.manifest.items[`bbox:${key}`]?.cleaned) {
      const cleanPath = path.join(io.dir, `${key}.clean.png`);
      try {
        await fs.access(cleanPath);
        src = cleanPath;
      } catch {
        log.warn(`preclean: ${key}.clean.png missing — using uncleaned source`);
      }
    }
    // Erase classified hairline bars explicitly — they can overlap the
    // content crop region.
    const bars = residue[key] || [];
    if (bars.length && !isCover(key)) {
      const barPad = mmToPx(1, dpi);
      const meta = await sharp(src).metadata();
      src = await sharp(src)
        .composite(
          bars.map((b) => {
            const left = Math.max(0, b.x - barPad);
            const top = Math.max(0, b.y - barPad);
            return {
              input: {
                create: {
                  width: Math.min(b.w + 2 * barPad, meta.width - left),
                  height: Math.min(b.h + 2 * barPad, meta.height - top),
                  channels: 3,
                  background: '#ffffff'
                }
              },
              left,
              top
            };
          })
        )
        .png()
        .toBuffer();
    }

    if (isCover(key) && bbox) {
      // Full-bleed cover: crop to the content and fill the whole page window
      // edge to edge (same fitting the AI-recreated cover gets).
      const meta = await sharp(srcPath).metadata();
      await sharp(srcPath)
        .extract({
          left: Math.max(0, bbox.x),
          top: Math.max(0, bbox.y),
          width: Math.min(bbox.w, meta.width - bbox.x),
          height: Math.min(bbox.h, meta.height - bbox.y)
        })
        .resize(window.w, window.h, { fit: 'cover', position: 'centre' })
        .grayscale()
        .png()
        .toFile(outPath);
    } else {
      await registerToWindow({ src, bbox, window, pad, outPath });
    }

    if (ctx.debug) {
      const meta = await sharp(srcPath).metadata();
      const sw = 800 / meta.width;
      const barRects = bars
        .map(
          (b) =>
            `<rect x="${b.x * sw}" y="${b.y * sw}" width="${b.w * sw}" height="${b.h * sw}"
              fill="orange" fill-opacity="0.5" stroke="orange" stroke-width="2"/>`
        )
        .join('');
      const svg = bbox
        ? `<svg width="${Math.round(meta.width * sw)}" height="${Math.round(meta.height * sw)}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="100%" height="100%" fill="red" fill-opacity="0.25"/>
            <rect x="${bbox.x * sw}" y="${bbox.y * sw}" width="${bbox.w * sw}" height="${bbox.h * sw}"
              fill="white" fill-opacity="0" stroke="red" stroke-width="3"/>
            <rect x="${(bbox.x - pad) * sw}" y="${(bbox.y - pad) * sw}" width="${(bbox.w + 2 * pad) * sw}" height="${(bbox.h + 2 * pad) * sw}"
              fill="#ffffff" fill-opacity="0.0" stroke="#00c000" stroke-width="2" stroke-dasharray="8 6"/>
            ${barRects}
          </svg>`
        : null;
      const annotated = sharp(srcPath).resize(800).toColourspace('srgb');
      await ctx.debug.addSideBySide('preclean', key, [
        {
          input: svg
            ? await annotated.composite([{ input: Buffer.from(svg) }]).png().toBuffer()
            : await annotated.png().toBuffer(),
          title: 'content box (red=erased zone)'
        },
        { input: outPath, title: 'registered page' }
      ], { meta: { bbox, residueBars: bars.length } });
    }

    io.done(key);
    log.stage('preclean', `${key}${bbox ? '' : ' (blank page)'}`);
  }
}
