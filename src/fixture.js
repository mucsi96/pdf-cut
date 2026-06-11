// Synthetic test input: landscape 2-up scans with known skew, punch holes,
// gray edge residue and a full-bleed "cover" first scan — mirrors the real
// scanner output so the offline pipeline can be tested end to end.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { run } from './util/exec.js';
import { mmToPx } from './img/geometry.js';
import { log } from './util/log.js';

// Injected skew per scan number; tests assert deskew recovers these.
export function fixtureAngle(scanNum) {
  const angles = [0.7, -0.5, 0.4, -0.6, 0.3];
  return angles[(scanNum - 1) % angles.length];
}

const SCAN_W_MM = 296; // two A5 pages side by side
const SCAN_H_MM = 210;
const FONT = process.env.PDFCUT_FIXTURE_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const BODY_LINES = [
  'Mister M dreht den Kopf und reibt sich die Augen.',
  'Inzwischen rollt SN7, der Wartungsroboter, quer',
  'durch den Raum. Aufstehen! Es gibt viel zu tun!',
  'Aleate geht zu ihm und blickt auf die Tastatur.',
  'Der Bildschirm am Sichtanzeigegeraet wird lebendig,',
  'und er zeigt die folgenden Worte an: RUN und ein',
  'blinkendes L. Die meisten Tasten haben mehr als',
  'ein Symbol, ruft Mister M und drueckt die Taste R.'
];

export async function generateFixture({ out, pages, dpi }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfcut-fixture-'));
  const px = (mm) => mmToPx(mm, dpi);
  const W = px(SCAN_W_MM);
  const H = px(SCAN_H_MM);
  const files = [];

  for (let n = 1; n <= pages; n++) {
    const file = path.join(tmp, `scan-${n}.png`);
    const args = ['-density', String(dpi), '-units', 'PixelsPerInch', '-size', `${W}x${H}`];
    const draw = (d) => args.push('-draw', d);
    const text = (xMm, yMm, str) => draw(`text ${px(xMm)},${px(yMm)} '${str}'`);

    if (n === 1) {
      // Full-bleed dark cover: back (left), spine, front (right).
      args.push('xc:black', '-font', FONT, '-fill', 'white');
      args.push('-pointsize', '30');
      text(178, 60, 'Spectrum');
      text(20, 60, 'Spectrum');
      args.push('-pointsize', '13');
      text(178, 75, 'BASIC-ABENTEUER Band 1');
      text(20, 75, 'BASIC-ABENTEUER Band 1');
      text(60, 95, 'Der fremde Planet');
      args.push('-pointsize', '10');
      text(143, 120, 'S');
      draw(`rectangle ${px(0)},${px(170)} ${px(SCAN_W_MM)},${px(172)}`);
      args.push('-fill', 'black');
    } else {
      args.push('xc:white', '-font', FONT, '-fill', 'black');
      for (const [half, ox] of [['L', 0], ['R', 148]]) {
        const pageNo = (n - 2) * 2 + (half === 'L' ? 6 : 7);
        // Running header with rule; the left rule extends under the punch hole.
        args.push('-pointsize', '9');
        text(ox + 20, 19, half === 'L' ? 'ZX Spectrum BASIC-Abenteuer' : 'EPISODE 1');
        text(ox + (half === 'L' ? 20 : 122), 12, String(pageNo));
        draw(`rectangle ${px(ox + 18)},${px(20.5)} ${px(ox + (half === 'L' ? 142 : 128))},${px(21)}`);
        // Body text.
        args.push('-pointsize', '11');
        let line = 0;
        for (let y = 34; y <= 180; y += 7) {
          text(ox + 20, y, BODY_LINES[line++ % BODY_LINES.length]);
        }
      }
      // Punch holes near the gutter, the left one over the header rule.
      const holeR = 3.5;
      draw(`circle ${px(139)},${px(20.7)} ${px(139 + holeR)},${px(20.7)}`);
      draw(`circle ${px(157)},${px(17)} ${px(157 + holeR)},${px(17)}`);
      // Gray scanner residue touching the outer edges.
      args.push('-fill', 'gray(55%)');
      draw(`rectangle 0,0 ${px(3)},${H}`);
      draw(`rectangle ${W - px(2)},${px(40)} ${W},${px(170)}`);
      args.push('-fill', 'gray(35%)');
      draw(`circle ${px(1)},${px(185)} ${px(6)},${px(185)}`);
    }

    // Skew the whole scan; the rotation fill simulates the dark scanner lid.
    args.push(
      '-background', 'rgb(60,60,60)',
      '-rotate', String(fixtureAngle(n)),
      '-gravity', 'center',
      '-crop', `${W}x${H}+0+0`,
      '+repage',
      '-colorspace', 'Gray',
      '-depth', '8',
      file
    );
    await run('convert', args);
    files.push(file);
    log.info(`fixture: scan ${n} (skew ${fixtureAngle(n)}°)`);
  }

  await run('img2pdf', ['--pagesize', `${SCAN_W_MM}mmx${SCAN_H_MM}mm`, '-o', out, ...files]);
  await fs.rm(tmp, { recursive: true, force: true });
  log.info(`fixture: ${out} (${pages} scans, ${dpi} dpi)`);
}
