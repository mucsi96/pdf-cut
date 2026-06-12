import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readManifest } from '../manifest.js';
import { stageByName } from '../pipeline.js';

export const name = 'report';
export const dir = '80-report';
export const configKey = 'report';
export const title = 'Generate HTML debug report';
export const alwaysRun = true;

/**
 * Static HTML report at work/report.html: one row per book page, one column
 * per stage, thumbnails linking to the full-resolution artifacts, plus the
 * per-stage debug images and parameters. Covers whatever exists in work/.
 */
export async function run_(ctx, { stageDir, params }) {
  const thumbsDir = path.join(stageDir, 'thumbs');
  fs.mkdirSync(thumbsDir, { recursive: true });
  const W = ctx.workRoot;

  const rel = (abs) => path.relative(W, abs).split(path.sep).join('/');
  let thumbCount = 0;
  const thumb = async (abs) => {
    if (!abs || !fs.existsSync(abs)) return null;
    const id = rel(abs).replace(/[\/\\]/g, '__').replace(/\.(png|jpg|jpeg)$/i, '') + '.jpg';
    const out = path.join(thumbsDir, id);
    if (!fs.existsSync(out)) {
      try {
        await sharp(abs).resize({ width: params.thumbWidth }).jpeg({ quality: 75 }).toFile(out);
      } catch {
        return null;
      }
    }
    thumbCount++;
    return { thumb: rel(out), full: rel(abs) };
  };

  const cell = async (abs, label = '') => {
    const t = await thumb(abs);
    if (!t) return '<td class="missing">—</td>';
    return `<td><a href="${t.full}" target="_blank"><img src="${t.thumb}" loading="lazy"></a>${label ? `<div class="meta">${label}</div>` : ''}</td>`;
  };

  const d = (n) => path.join(W, stageByName(n).dir);
  const exists = (p) => fs.existsSync(p);

  // Collected data
  const angles = readJson(path.join(d('deskew'), 'debug', 'angles.json')) || {};
  const holes = readJson(path.join(d('detect-holes'), 'holes.json')) || {};
  const rejected = readJson(path.join(d('detect-holes'), 'debug', 'rejected.json')) || {};

  const pageIds = new Set();
  for (const stage of ['split', 'deskew', 'clean', 'inpaint']) {
    if (!exists(d(stage))) continue;
    for (const f of fs.readdirSync(d(stage))) {
      const m = f.match(/^page-(\d{4})\.png$/);
      if (m) pageIds.add(m[1]);
    }
  }
  const scanIds = exists(d('extract'))
    ? fs.readdirSync(d('extract')).map((f) => f.match(/^scan-(\d{4})\.png$/)?.[1]).filter(Boolean).sort()
    : [];

  let html = HEADER;

  // ── Run parameters ────────────────────────────────────────────────────
  html += '<details><summary>Stage parameters (manifests)</summary><div class="params">';
  for (const stage of ['extract', 'cover', 'split', 'deskew', 'clean', 'detect-holes', 'inpaint', 'assemble']) {
    const m = readManifest(d(stage));
    if (m) html += `<h4>${stage} <span class="dim">${m.completedAt || ''} · ${m.durationMs ?? '?'} ms</span></h4><pre>${escapeHtml(JSON.stringify(m.params, null, 2))}</pre>`;
  }
  html += '</div></details>';

  // ── Cover ─────────────────────────────────────────────────────────────
  const coverDir = d('cover');
  if (exists(coverDir)) {
    html += '<h2>Cover</h2><table><tr><th>scan (input)</th><th>variants (raw from Gemini)</th><th>final cover.png</th></tr><tr>';
    html += await cell(path.join(d('extract'), 'scan-0001.png'));
    let variantCells = '';
    if (exists(path.join(coverDir, 'debug'))) {
      for (const f of fs.readdirSync(path.join(coverDir, 'debug')).filter((f) => /^cover-variant-\d+-raw\.png$/.test(f)).sort()) {
        const t = await thumb(path.join(coverDir, 'debug', f));
        if (t) variantCells += `<a href="${t.full}" target="_blank"><img src="${t.thumb}" loading="lazy"></a> `;
      }
    }
    html += `<td>${variantCells || '—'}</td>`;
    html += await cell(path.join(coverDir, 'cover.png'));
    html += '</tr></table>';
  }

  // ── Scans ─────────────────────────────────────────────────────────────
  if (scanIds.length) {
    html += '<h2>Scans</h2><table><tr><th>scan</th><th>extract (raw baseline)</th><th>split cut position</th></tr>';
    for (const id of scanIds) {
      html += `<tr><th>${id}</th>`;
      html += await cell(path.join(d('extract'), `scan-${id}.png`));
      html += await cell(path.join(d('split'), 'debug', `cut-scan-${id}.jpg`));
      html += '</tr>';
    }
    html += '</table>';
  }

  // ── Pages ─────────────────────────────────────────────────────────────
  if (pageIds.size) {
    html +=
      '<h2>Pages</h2><table><tr><th>page</th><th>split</th><th>deskew</th><th>clean</th>' +
      '<th>clean: ink removed (red) / added (blue)</th><th>clean: regions</th><th>holes</th><th>inpaint</th></tr>';
    for (const id of [...pageIds].sort()) {
      const a = angles[id];
      const h = holes[id] || [];
      const rj = rejected[id] || [];
      html += `<tr><th>${id}</th>`;
      html += await cell(path.join(d('split'), `page-${id}.png`));
      html += await cell(path.join(d('deskew'), `page-${id}.png`), a ? `angle ${a.angle.toFixed(2)}°${a.override ? ' (override)' : ''}` : '');
      html += await cell(path.join(d('clean'), `page-${id}.png`));
      html += await cell(path.join(d('clean'), 'debug', `changed-page-${id}.jpg`));
      html += await cell(path.join(d('clean'), 'debug', `regions-page-${id}.jpg`));
      const holeLabel = h.length || rj.length ? `${h.length} hole(s), ${rj.length} rejected` : '';
      const overlay = path.join(d('detect-holes'), 'debug', `overlay-page-${id}.jpg`);
      html += await cell(exists(overlay) ? overlay : null, holeLabel);
      html += await cell(path.join(d('inpaint'), `page-${id}.png`), h.length ? `${h.length} patch(es) inpainted` : '');
      html += '</tr>';
    }
    html += '</table>';
  }

  // ── Inpaint patches ───────────────────────────────────────────────────
  const inpaintDebug = path.join(d('inpaint'), 'debug');
  if (exists(inpaintDebug)) {
    const pairs = fs.readdirSync(inpaintDebug).filter((f) => f.startsWith('patch-')).sort();
    if (pairs.length) {
      html += '<h2>Inpaint patches (before | after)</h2><div class="patches">';
      for (const f of pairs) {
        const t = await thumb(path.join(inpaintDebug, f));
        if (t) html += `<a href="${t.full}" target="_blank"><img src="${t.thumb}" loading="lazy"><div class="meta">${f}</div></a>`;
      }
      html += '</div>';
    }
  }

  html += `<footer>generated ${new Date().toISOString()}</footer></body></html>`;
  fs.writeFileSync(path.join(W, 'report.html'), html);
  ctx.log(`  report: ${rel(path.join(W, 'report.html'))} (${thumbCount} thumbnails)`);
  return { reportFile: path.join(W, 'report.html') };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HEADER = `<!doctype html><html><head><meta charset="utf-8"><title>pdf-cut report</title><style>
  body { font-family: system-ui, sans-serif; background: #15171a; color: #d8dadd; margin: 24px; }
  h1 { font-size: 22px; } h2 { margin-top: 36px; border-bottom: 1px solid #333; padding-bottom: 6px; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #2c2f33; padding: 6px; text-align: center; vertical-align: top; font-size: 12px; }
  thead th, tr > th { background: #1e2126; position: sticky; top: 0; }
  img { display: block; max-width: 360px; background: #fff; }
  td.missing { color: #555; min-width: 80px; }
  .meta { margin-top: 4px; color: #9ab; font-size: 11px; }
  .dim { color: #778; font-weight: normal; font-size: 12px; }
  details { margin: 12px 0; } summary { cursor: pointer; }
  .params pre { background: #1e2126; padding: 8px; font-size: 11px; overflow-x: auto; }
  .patches { display: flex; flex-wrap: wrap; gap: 12px; } .patches a { text-decoration: none; color: inherit; }
  footer { margin-top: 40px; color: #667; font-size: 11px; }
  a { color: #7ab8ff; }
</style></head><body><h1>pdf-cut — pipeline report</h1>`;

export { run_ as run };
