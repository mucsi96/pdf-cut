import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import sharp from 'sharp';
import { detectSkew } from '../src/img/projection.js';
import { fixtureAngle } from '../src/fixture.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src/index.js');
const DPI = '150';

async function hasBinaries() {
  for (const bin of ['pdftoppm', 'convert', 'img2pdf', 'pdfinfo', 'pdfimages']) {
    try {
      await execa('which', [bin]);
    } catch {
      return false;
    }
  }
  return true;
}

test('detectSkew recovers a known rotation with the right sign', async () => {
  // White canvas with horizontal black bars, rotated clockwise by 1.2°.
  const bars = [];
  for (let y = 60; y < 560; y += 40) {
    bars.push({
      input: { create: { width: 600, height: 6, channels: 3, background: '#000000' } },
      left: 100,
      top: y
    });
  }
  const png = await sharp({ create: { width: 800, height: 620, channels: 3, background: '#ffffff' } })
    .composite(bars)
    .png()
    .toBuffer();
    const rotated = await sharp(png).rotate(1.2, { background: '#ffffff' }).grayscale().raw()
    .toBuffer({ resolveWithObject: true });
  const { angle } = detectSkew(
    { data: rotated.data, width: rotated.info.width, height: rotated.info.height },
    { maxAngleDeg: 3, coarseStepDeg: 0.1, fineStepDeg: 0.02, darkThreshold: 128 }
  );
  assert.ok(Math.abs(angle - 1.2) < 0.1, `expected ~1.2°, got ${angle}°`);
});

test('top border band removes edge residue but keeps a header near the top edge', async () => {
  const { analyzeContent } = await import('../src/img/content.js');
  const width = 600;
  const height = 800;
  const data = new Uint8Array(width * height).fill(255);
  // Scan-edge line touching the top border.
  for (let y = 0; y < 2; y++) for (let x = 0; x < width; x++) data[y * width + x] = 0;
  // Header text band ~3mm (18px @150dpi) from the top — real content.
  for (let y = 18; y < 30; y++) for (let x = 60; x < 540; x++) data[y * width + x] = 0;

  const base = { darkThreshold: 128, minInkPx: 3, borderBandXPx: 18 };
  // 1.5mm top band (9px): edge line removed, header survives.
  const kept = analyzeContent({ data, width, height }, { ...base, borderBandYPx: 9 });
  assert.ok(kept.bbox && kept.bbox.y === 18, `header eaten: ${JSON.stringify(kept.bbox)}`);
  // A 4mm band (24px) would reach the header and eat it — the old bug.
  const eaten = analyzeContent({ data, width, height }, { ...base, borderBandYPx: 24 });
  assert.equal(eaten.bbox, null);
});

test('offline end-to-end pipeline on the synthetic fixture', { timeout: 600_000 }, async (t) => {
  if (!(await hasBinaries())) {
    t.skip('system binaries (poppler/imagemagick/img2pdf) not available');
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfcut-test-'));
  const input = path.join(tmp, 'in.pdf');
  const workdir = path.join(tmp, 'work');
  const out = path.join(tmp, 'out.pdf');

  await execa('node', [CLI, 'fixture', '--out', input, '--pages', '3', '--dpi', DPI]);

  const processArgs = [
    CLI, 'process', input,
    '--workdir', workdir, '--out', out,
    '--dpi', DPI, '--skip-ai', '--debug'
  ];
  await execa('node', processArgs, { cwd: ROOT });

  // Output structure: 2 inner scans x 2 pages = 4 pages; the cover lives in
  // its own PDF (offline mode falls back to the original scan image).
  const { stdout: info } = await execa('pdfinfo', [out]);
  assert.match(info, /^Pages:\s+4$/m, info);
  const coverPdf = out.replace(/\.pdf$/, '-cover.pdf');
  const { stdout: coverInfo } = await execa('pdfinfo', [coverPdf]);
  assert.match(coverInfo, /^Pages:\s+1$/m, coverInfo);

  // Inner pages are grayscale, embedded losslessly.
  const { stdout: images } = await execa('pdfimages', ['-list', out]);
  assert.match(images, /gray/, images);

  // Deskew must recover the injected angles.
  const angles = JSON.parse(await fs.readFile(path.join(workdir, '05-deskew/angles.json'), 'utf8'));
  for (const scan of [2, 3]) {
    for (const side of ['L', 'R']) {
      const key = `page-000${scan}-${side}`;
      const detected = angles[key];
      const injected = fixtureAngle(scan);
      assert.ok(
        Math.abs(detected - injected) < 0.15,
        `${key}: detected ${detected}°, injected ${injected}°`
      );
    }
  }

  // Residue must be fully erased: the fixture places detached binding-shadow
  // bars next to the gutter; the inner-edge strips of the output pages must
  // be pure white.
  for (const [file, fromRight] of [['page-0002-L.png', true], ['page-0002-R.png', false]]) {
    const { data, info } = await sharp(path.join(workdir, '05-deskew', file))
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const stripW = Math.floor(info.width * 0.03);
    let darkPx = 0;
    for (let y = 0; y < info.height; y++) {
      for (let dx = 0; dx < stripW; dx++) {
        const x = fromRight ? info.width - 1 - dx : dx;
        if (data[(y * info.width + x) * info.channels] < 128) darkPx++;
      }
    }
    assert.equal(darkPx, 0, `${file}: ${darkPx} dark px left in the inner-edge strip`);
  }

  // The running header sits close to the top edge; the residue cleanup must
  // not eat it. Find the header rule (densest row in the top third) and
  // require ink above it in the left 40% of the page (page number + header
  // text; punch holes live far right and are excluded).
  {
    const { data, info } = await sharp(path.join(workdir, '05-deskew/page-0002-L.png'))
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rowInk = new Array(info.height).fill(0);
    for (let y = 0; y < Math.floor(info.height / 3); y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * info.channels] < 128) rowInk[y]++;
      }
    }
    const ruleY = rowInk.indexOf(Math.max(...rowInk));
    // The page number sits ~4.5mm above the rule, nearest to the page edge —
    // the first victim of an over-aggressive top band.
    const zoneTop = ruleY - Math.round((4.5 / 25.4) * Number(DPI));
    let inkAboveRule = 0;
    for (let y = 0; y < zoneTop; y++) {
      for (let x = 0; x < Math.floor(info.width * 0.4); x++) {
        if (data[(y * info.width + x) * info.channels] < 128) inkAboveRule++;
      }
    }
    assert.ok(inkAboveRule > 30, `page number above the header was erased (ink=${inkAboveRule}, ruleY=${ruleY})`);
  }

  // Punch-hole inpainting (only when the OpenCV/LaMa toolchain is present):
  // the in-text hole on page-0002-L must be detected and actually filled.
  const { pythonAvailable } = await import('../src/util/pythonStage.js');
  if (await pythonAvailable({ needLama: true })) {
    const manifest = JSON.parse(
      await fs.readFile(path.join(workdir, '04-inpaint/manifest.json'), 'utf8')
    );
    const item = manifest.items['page-0002-L'];
    assert.ok(item && item.holes >= 1, `expected >=1 filled hole, got ${JSON.stringify(item)}`);
    const box = item.boxes[0];
    const { data, info } = await sharp(path.join(workdir, '04-inpaint/page-0002-L.png'))
      .extract({
        left: Math.max(0, box.x),
        top: Math.max(0, box.y),
        width: box.w,
        height: box.h
      })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let dark = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      if (data[i * info.channels] < 100) dark++;
    }
    const frac = dark / (info.width * info.height);
    assert.ok(frac < 0.3, `hole region still ${(frac * 100).toFixed(0)}% dark after LaMa`);
  }

  // Debug report exists.
  await fs.access(path.join(workdir, 'debug/index.html'));

  // Re-run: everything resumes from manifests, nothing is rebuilt.
  const second = await execa('node', processArgs, { cwd: ROOT });
  for (const stage of ['rasterize', 'split', 'preclean', 'inpaint', 'deskew']) {
    assert.match(second.stdout, new RegExp(`\\[${stage}\\] done \\(all items up to date\\)`));
  }

  await fs.rm(tmp, { recursive: true, force: true });
});
