import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { stageDir } from '../config.js';
import { inpaintPatch } from '../ai/openaiInpaint.js';
import { planPatches, extractPatchPng, buildMaskPng, featherAlpha, compositePatch } from '../img/patch.js';
import { log } from '../util/log.js';

export const aiStage = true;

export function params(ctx) {
  return { inpaint: ctx.cfg.inpaint, model: ctx.cfg.models.inpaint, window: ctx.window || null };
}

function holePxBoxes(analysis, width, height) {
  return analysis.holes.map((h) => ({
    x: (h.box.xmin / 1000) * width,
    y: (h.box.ymin / 1000) * height,
    w: ((h.box.xmax - h.box.xmin) / 1000) * width,
    h: ((h.box.ymax - h.box.ymin) / 1000) * height,
    nearbyText: h.nearbyText
  }));
}

export async function run(ctx, io) {
  const cfg = ctx.cfg.inpaint;
  const srcDir = stageDir(ctx.workdir, 'preclean');
  const analyzeDir = stageDir(ctx.workdir, 'analyze');
  const pages = (await fs.readdir(srcDir)).filter((f) => /^page-\d{4}-[LR]\.png$/.test(f)).sort();
  const limit = pLimit(Number(ctx.opts.concurrency) || 4);

  await Promise.all(
    pages.map((file) =>
      limit(async () => {
        const key = file.replace('.png', '');
        if (io.isDone(key)) return;
        const srcPath = path.join(srcDir, file);
        const outPath = path.join(io.dir, file);

        let analysis = null;
        try {
          analysis = JSON.parse(await fs.readFile(path.join(analyzeDir, `${key}.json`), 'utf8'));
        } catch {
          // No analysis (stage skipped or failed for this page) — pass through.
        }

        const meta = await sharp(srcPath).metadata();
        const holes = analysis ? holePxBoxes(analysis, meta.width, meta.height) : [];
        if (holes.length === 0) {
          await fs.copyFile(srcPath, outPath);
          io.done(key, { holes: 0 });
          return;
        }

        const pageRaw = {
          data: await sharp(srcPath).grayscale().raw().toBuffer(),
          width: meta.width,
          height: meta.height
        };
        const patches = planPatches(holes, meta.width, meta.height, cfg);

        for (let i = 0; i < patches.length; i++) {
          const { rect, holes: patchHoles } = patches[i];
          const imagePng = await extractPatchPng(srcPath, rect, meta.width, meta.height);
          const maskPng = await buildMaskPng(rect, patchHoles);
          const context = holes
            .map((h) => h.nearbyText)
            .filter(Boolean)
            .join(' | ');
          const prompt =
            `Photorealistic restoration of a high-resolution grayscale scan of a printed book page. ` +
            `The transparent masked circular areas are punch-hole damage. Fill them so the page looks ` +
            `undamaged: seamlessly continue the printed text, lines and typography, or plain paper ` +
            `background, exactly matching the surrounding print style.` +
            (context ? ` Printed text near the damage reads: "${context}".` : '');

          const aiPng = await inpaintPatch({
            imagePng,
            maskPng,
            prompt,
            model: ctx.cfg.models.inpaint,
            size: `${cfg.patchSize}x${cfg.patchSize}`,
            quality: cfg.quality
          });
          const aiRaw = await sharp(aiPng)
            .resize(rect.w, rect.h, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer();
          const alpha = featherAlpha(rect, patchHoles, cfg.featherPx);
          compositePatch(pageRaw, aiRaw, rect, alpha);

          // Audit artifacts.
          await fs.writeFile(path.join(io.dir, `${key}-patch-${i}.png`), imagePng);
          await fs.writeFile(path.join(io.dir, `${key}-mask-${i}.png`), maskPng);
          await fs.writeFile(path.join(io.dir, `${key}-ai-${i}.png`), aiPng);

          if (ctx.debug) {
            const after = await sharp(pageRaw.data, {
              raw: { width: pageRaw.width, height: pageRaw.height, channels: 1 }
            })
              .extract({ left: rect.x, top: rect.y, width: Math.min(rect.w, pageRaw.width - rect.x), height: Math.min(rect.h, pageRaw.height - rect.y) })
              .png()
              .toBuffer();
            await ctx.debug.addSideBySide('inpaint', key, [
              { input: imagePng, title: 'patch' },
              { input: maskPng, title: 'mask' },
              { input: aiPng, title: 'AI result' },
              { input: after, title: 'composited' }
            ], { meta: { patch: i, rect, holes: patchHoles.length }, label: `patch-${i}` });
          }
        }

        await sharp(pageRaw.data, {
          raw: { width: pageRaw.width, height: pageRaw.height, channels: 1 }
        })
          .png()
          .toFile(outPath);
        io.done(key, { holes: holes.length, patches: patches.length });
        log.stage('inpaint', `${key}: ${holes.length} hole(s) via ${patches.length} patch(es)`);
      })
    )
  );
}
