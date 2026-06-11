import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { STAGE_NAMES } from '../config.js';

// Collects annotated debug images per (stage, page, label) under
// work/debug/NN-<stage>/ and renders a static contact-sheet at
// work/debug/index.html. Entries persist across runs in entries.json so
// resumed runs keep earlier images in the report.
export class DebugReport {
  constructor(workdir, cfg) {
    this.dir = path.join(workdir, 'debug');
    this.cfg = cfg;
    this.entries = null;
  }

  async #init() {
    if (this.entries) return;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      this.entries = JSON.parse(await fs.readFile(path.join(this.dir, 'entries.json'), 'utf8'));
    } catch {
      this.entries = [];
    }
  }

  async add(stage, key, { image, label = '', meta = {} }) {
    await this.#init();
    const stageIdx = String(STAGE_NAMES.indexOf(stage)).padStart(2, '0');
    const subdir = `${stageIdx}-${stage}`;
    await fs.mkdir(path.join(this.dir, subdir), { recursive: true });
    const file = `${subdir}/${key}${label ? `-${label}` : ''}.jpg`;
    await sharp(image)
      .flatten({ background: '#ffffff' })
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(path.join(this.dir, file));
    const id = `${stage}:${key}:${label}`;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.entries.push({ id, stage, key, label, file, meta, ts: new Date().toISOString() });
  }

  // Compose labeled images horizontally on a white canvas.
  async addSideBySide(stage, key, items, { meta = {}, label = '' } = {}) {
    const H = 700;
    const TITLE_H = 28;
    const GAP = 12;
    const rendered = [];
    for (const item of items) {
      // Flatten on magenta so transparent mask regions stay visible.
      const buf = await sharp(item.input)
        .flatten({ background: '#ff00ff' })
        .resize(null, H, { withoutEnlargement: false })
        .png()
        .toBuffer({ resolveWithObject: true });
      rendered.push({ ...item, buf: buf.data, width: buf.info.width });
    }
    const totalW = rendered.reduce((s, r) => s + r.width, 0) + GAP * (rendered.length + 1);
    const composites = [];
    const titles = [];
    let x = GAP;
    for (const r of rendered) {
      composites.push({ input: r.buf, left: x, top: TITLE_H });
      titles.push(
        `<text x="${x}" y="${TITLE_H - 8}" font-family="sans-serif" font-size="18" fill="#333">${r.title}</text>`
      );
      x += r.width + GAP;
    }
    const svg = `<svg width="${totalW}" height="${TITLE_H}" xmlns="http://www.w3.org/2000/svg">${titles.join('')}</svg>`;
    const image = await sharp({
      create: { width: totalW, height: H + TITLE_H + GAP, channels: 3, background: '#ffffff' }
    })
      .composite([...composites, { input: Buffer.from(svg), left: 0, top: 0 }])
      .png()
      .toBuffer();
    await this.add(stage, key, { image, label, meta });
  }

  async writeReport() {
    await this.#init();
    await fs.writeFile(path.join(this.dir, 'entries.json'), JSON.stringify(this.entries, null, 2));

    const byStage = new Map();
    for (const name of STAGE_NAMES) byStage.set(name, []);
    for (const e of this.entries) byStage.get(e.stage)?.push(e);

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let body = '';
    for (const [stage, entries] of byStage) {
      if (entries.length === 0) continue;
      entries.sort((a, b) => a.id.localeCompare(b.id));
      body += `<h2 id="${stage}">${stage}</h2><div class="grid">`;
      for (const e of entries) {
        body += `<figure>
          <a href="${e.file}" target="_blank"><img src="${e.file}" loading="lazy"></a>
          <figcaption><b>${esc(e.key)}${e.label ? ` · ${esc(e.label)}` : ''}</b>
          <pre>${esc(JSON.stringify(e.meta, null, 1))}</pre></figcaption>
        </figure>`;
      }
      body += '</div>';
    }
    const nav = STAGE_NAMES.filter((s) => byStage.get(s).length > 0)
      .map((s) => `<a href="#${s}">${s}</a>`)
      .join(' · ');
    const html = `<!doctype html><meta charset="utf-8"><title>pdf-cut debug report</title>
<style>
  body { font-family: sans-serif; margin: 16px; background: #fafafa; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
  figure { margin: 0; background: #fff; border: 1px solid #ddd; padding: 6px; max-width: 540px; }
  img { max-width: 520px; height: auto; display: block; }
  pre { font-size: 11px; white-space: pre-wrap; color: #555; margin: 4px 0 0; }
  h2 { border-bottom: 2px solid #333; padding-bottom: 4px; }
  nav { position: sticky; top: 0; background: #fafafa; padding: 8px 0; }
</style>
<nav>${nav}</nav>
${body}`;
    const out = path.join(this.dir, 'index.html');
    await fs.writeFile(out, html);
    return out;
  }
}
