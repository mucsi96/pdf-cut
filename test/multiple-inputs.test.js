import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { run } from '../src/exec.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { run as markdown, transcriptionHash, figureHash } from '../src/stages/markdown.js';

// Integration tests require the system tools shipped in the project's image.
test('ordered PDFs share scan numbering, extraction, and final assembly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfcut-inputs-'));
  try {
    const cli = path.resolve('src/cli.js');
    const work = path.join(root, 'work');
    const output = path.join(root, 'output');
    const a = path.join(root, 'first part.pdf');
    const b = path.join(root, 'second.pdf');
    const makePdf = async (file, value, density = 72, width = 120, height = 180) => {
      const png = `${file}.png`;
      await sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } })
        .png().withMetadata({ density }).toFile(png);
      await run('img2pdf', [png, '-o', file], { quiet: true });
    };
    await makePdf(a, 40);
    await makePdf(b, 210);
    const invoke = (...args) => run(process.execPath, [cli, 'run', '--config', path.join(root, 'none.json'),
      '--work', work, '--output', output, '--skip-cover', '--set', 'cover.scanPage=0',
      '--set', 'split.firstBookPage=1', '--set', 'print.enabled=false', ...args], { quiet: true });
    const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(work, dir, 'manifest.json')));
    const brightness = async (scan) => (await sharp(path.join(work, '10-extract', scan)).stats()).channels[0].mean;

    await invoke('--input', a, '--input', b, '--stages', 'extract,split');
    assert.equal(manifest('10-extract').totalPages, 2);
    assert.deepEqual(manifest('10-extract').sources.map((s) => [s.file, s.firstScan, s.lastScan]), [[a, 1, 1], [b, 2, 2]]);
    assert.equal(await brightness('scan-0001.png'), 40);
    assert.equal(await brightness('scan-0002.png'), 210);
    assert.deepEqual(manifest('30-split').pageMap, { '0001': { single: 1 }, '0002': { single: 2 } });
    assert.equal(fs.existsSync(path.join(work, '10-extract', 'combined-input.pdf')), false);
    const unchanged = await invoke('--input', a, b, '--stages', 'extract,split');
    assert.match(unchanged.stdout, /extract: up to date/);
    assert.match(unchanged.stdout, /split: up to date/);

    // Feed the split fixtures into assembly without invoking AI cleanup.
    fs.cpSync(path.join(work, '30-split'), path.join(work, '70-inpaint'), { recursive: true });
    await invoke('--input', a, b, '--stages', 'assemble');
    const { stdout } = await run('pdfinfo', [path.join(output, 'book.pdf')], { quiet: true });
    assert.match(stdout, /^Pages:\s+2$/m);

    await invoke('--input', b, a, '--stages', 'extract,split');
    assert.equal(await brightness('scan-0001.png'), 210);
    assert.equal(await brightness('scan-0002.png'), 40);
    await makePdf(b, 180);
    await invoke('--input', b, a, '--stages', 'extract');
    assert.equal(await brightness('scan-0001.png'), 180);

    await invoke('--input', a, b, '--pages', '2', '--stages', 'extract');
    assert.deepEqual(manifest('10-extract').scans, ['scan-0002.png']);
    await assert.rejects(invoke('--input', a, b, '--pages', '3', '--stages', 'extract'), /between 1 and 2/);
    await assert.rejects(invoke('--input', a, path.join(root, 'missing.pdf'), '--stages', 'extract'), /Input PDF not found/);

    await invoke('--input', a, '--stages', 'extract');
    assert.equal(manifest('10-extract').mode, 'embedded');
    assert.equal(manifest('10-extract').totalPages, 1);
    assert.equal(await brightness('scan-0001.png'), 40);

    await makePdf(b, 210, 144, 240, 360);
    await invoke('--input', a, b, '--stages', 'extract');
    assert.equal(manifest('10-extract').mode, 'render');
    const first = await sharp(path.join(work, '10-extract', 'scan-0001.png')).metadata();
    const second = await sharp(path.join(work, '10-extract', 'scan-0002.png')).metadata();
    assert.equal(first.width, second.width);
    assert.equal(first.height, second.height);

    // Only the combined cover is excluded; a later PDF's first spread is body.
    await makePdf(b, 210, 72, 360, 180);
    await invoke('--input', a, b, '--set', 'cover.scanPage=1', '--stages', 'extract,split');
    const pageMap = manifest('30-split').pageMap;
    assert.deepEqual(Object.keys(pageMap), ['0002']);
    assert.equal(pageMap['0002'].left, 1);
    assert.equal(pageMap['0002'].right, 2);

    await invoke('--input', a, a, '--stages', 'extract');
    assert.equal(manifest('10-extract').totalPages, 2);
    assert.equal(await brightness('scan-0002.png'), 40);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Markdown cache follows page content when the sequence changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfcut-markdown-'));
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const srcDir = path.join(root, 'inpaint');
    const stageDir = path.join(root, 'markdown');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(path.join(stageDir, 'debug'), { recursive: true });
    const page = path.join(srcDir, 'page-0001.png');
    await sharp({ create: { width: 20, height: 30, channels: 3, background: 'white' } }).png().toFile(page);
    const params = { ...DEFAULT_CONFIG.markdown, figureRecreate: false };
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(page)).digest('hex');
    fs.writeFileSync(path.join(stageDir, 'page-0001.md'), 'Cached body text.');
    fs.writeFileSync(path.join(stageDir, 'debug', 'page-0001-raw.md'), 'Cached body text.');
    fs.writeFileSync(path.join(stageDir, 'debug', 'page-0001-meta.json'), JSON.stringify({
      sourceHash, txHash: transcriptionHash(params), figHash: figureHash(params), figures: [],
    }));
    const ctx = { dir: (s) => path.join(root, s), outputDir: root, log: () => {} };
    const result = await markdown(ctx, { stageDir, params });
    assert.equal(result.cached, 1);
    await sharp({ create: { width: 20, height: 30, channels: 3, background: 'black' } }).png().toFile(page);
    await assert.rejects(markdown(ctx, { stageDir, params }), /GEMINI_API_KEY is not set/);
  } finally {
    if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
