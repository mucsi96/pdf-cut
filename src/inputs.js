import path from 'node:path';
import { run } from './exec.js';

/** Join page objects without rasterizing or recompressing the source scans. */
export async function prepareInputs(inputs, stageDir) {
  const sources = [];
  let totalPages = 0;
  for (const [index, file] of inputs.entries()) {
    const { stdout } = await run('pdfinfo', [file], { capture: true, quiet: true });
    const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(pages) || pages < 1) throw new Error(`Cannot read page count: ${file}`);
    sources.push({ index: index + 1, file, pages, firstScan: totalPages + 1, lastScan: totalPages + pages });
    totalPages += pages;
  }
  if (inputs.length === 1) return { inputPdf: inputs[0], sources, totalPages };
  const inputPdf = path.join(stageDir, 'combined-input.pdf');
  await run('qpdf', ['--empty', '--pages', ...inputs.flatMap((file) => [file, '1-z']), '--', inputPdf], { quiet: true });
  return { inputPdf, sources, totalPages };
}
