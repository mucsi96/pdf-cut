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

  // Output structure: front cover + 2 inner scans x 2 pages = 5 pages.
  const { stdout: info } = await execa('pdfinfo', [out]);
  assert.match(info, /^Pages:\s+5$/m, info);

  // Inner pages must be 1-bit CCITT G4.
  const { stdout: images } = await execa('pdfimages', ['-list', out]);
  assert.match(images, /ccitt/, images);
  assert.match(images, /\s1\s+1\s/, 'expected a 1-bit 1-component image');

  // Deskew must recover the injected angles.
  const angles = JSON.parse(await fs.readFile(path.join(workdir, '02-deskew/angles.json'), 'utf8'));
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

  // Debug report exists.
  await fs.access(path.join(workdir, 'debug/index.html'));

  // Re-run: everything resumes from manifests, nothing is rebuilt.
  const second = await execa('node', processArgs, { cwd: ROOT });
  for (const stage of ['rasterize', 'split', 'deskew', 'preclean', 'binarize']) {
    assert.match(second.stdout, new RegExp(`\\[${stage}\\] done \\(all items up to date\\)`));
  }

  await fs.rm(tmp, { recursive: true, force: true });
});
