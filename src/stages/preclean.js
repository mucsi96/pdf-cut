import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { stageDir } from '../config.js';
import { toGrayRaw } from '../img/projection.js';
import { analyzeContent } from '../img/content.js';
import { mmToPx, median } from '../img/geometry.js';
import { log } from '../util/log.js';

export const aiStage = false;

export function params(ctx) {
  return { dpi: ctx.cfg.dpi, preclean: ctx.cfg.preclean, pageSize: ctx.cfg.assemble.pageSize };
}

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
  const srcDir = stageDir(ctx.workdir, 'deskew');
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();

  // Pass A: content bounding boxes (residue-free), cached in the manifest.
  const boxes = {};
  for (const file of pages) {
    const key = file.replace('.png', '');
    const cacheKey = `bbox:${key}`;
    if (io.manifest.items[cacheKey]) {
      boxes[key] = io.manifest.items[cacheKey].bbox;
      continue;
    }
    const srcPath = path.join(srcDir, file);
    const meta = await sharp(srcPath).metadata();
    const raw = await toGrayRaw(srcPath, { maxDim: cfg.analysisMaxDim });
    const scale = meta.width / raw.width;
    const { bbox } = analyzeContent(raw, cfg);
    const fullBbox = bbox
      ? {
          x: Math.round(bbox.x * scale),
          y: Math.round(bbox.y * scale),
          w: Math.round(bbox.w * scale),
          h: Math.round(bbox.h * scale)
        }
      : null;
    boxes[key] = fullBbox;
    io.done(cacheKey, { bbox: fullBbox });
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
      w = Math.round(median(statKeys.map((k) => boxes[k].w))) + 2 * mmToPx(cfg.marginSideMm, dpi);
      h = Math.round(median(statKeys.map((k) => boxes[k].h))) + topPx + mmToPx(cfg.marginBottomMm, dpi);
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

    const canvas = sharp({
      create: { width: window.w, height: window.h, channels: 3, background: '#ffffff' }
    });

    if (bbox) {
      const meta = await sharp(srcPath).metadata();
      const crop = {
        left: Math.max(0, bbox.x - pad),
        top: Math.max(0, bbox.y - pad),
        right: Math.min(meta.width, bbox.x + bbox.w + pad),
        bottom: Math.min(meta.height, bbox.y + bbox.h + pad)
      };
      // Destination of the crop's top-left, derived from the registration of
      // the bbox itself (centered horizontally, top at margin).
      let dstX = Math.round((window.w - bbox.w) / 2) - (bbox.x - crop.left);
      let dstY = window.topPx - (bbox.y - crop.top);
      // Clip to the window.
      if (dstX < 0) {
        crop.left -= dstX;
        dstX = 0;
      }
      if (dstY < 0) {
        crop.top -= dstY;
        dstY = 0;
      }
      crop.right = Math.min(crop.right, crop.left + (window.w - dstX));
      crop.bottom = Math.min(crop.bottom, crop.top + (window.h - dstY));

      if (crop.right > crop.left && crop.bottom > crop.top) {
        const content = await sharp(srcPath)
          .extract({
            left: crop.left,
            top: crop.top,
            width: crop.right - crop.left,
            height: crop.bottom - crop.top
          })
          .toBuffer();
        await canvas
          .composite([{ input: content, left: dstX, top: dstY }])
          .grayscale()
          .png()
          .toFile(outPath);
      } else {
        await canvas.grayscale().png().toFile(outPath);
      }
    } else {
      await canvas.grayscale().png().toFile(outPath);
    }

    if (ctx.debug) {
      const meta = await sharp(srcPath).metadata();
      const sw = 800 / meta.width;
      const svg = bbox
        ? `<svg width="${Math.round(meta.width * sw)}" height="${Math.round(meta.height * sw)}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="100%" height="100%" fill="red" fill-opacity="0.25"/>
            <rect x="${bbox.x * sw}" y="${bbox.y * sw}" width="${bbox.w * sw}" height="${bbox.h * sw}"
              fill="white" fill-opacity="0" stroke="red" stroke-width="3"/>
            <rect x="${(bbox.x - pad) * sw}" y="${(bbox.y - pad) * sw}" width="${(bbox.w + 2 * pad) * sw}" height="${(bbox.h + 2 * pad) * sw}"
              fill="#ffffff" fill-opacity="0.0" stroke="#00c000" stroke-width="2" stroke-dasharray="8 6"/>
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
      ], { meta: { bbox } });
    }

    io.done(key);
    log.stage('preclean', `${key}${bbox ? '' : ' (blank page)'}`);
  }
}
