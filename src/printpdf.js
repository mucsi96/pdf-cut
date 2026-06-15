import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from './exec.js';

/**
 * Print-shop PDF conversion with Ghostscript, to the druck.at "Druckdaten"
 * rules: fonts fully embedded, transparency flattened (CompatibilityLevel 1.3
 * has no transparency model, so gs composites it away), color converted to
 * CMYK or grayscale (never RGB), and tagged as PDF/X-1a:2001 with a CMYK
 * output intent. Images keep their resolution (no downsampling, JPEG streams
 * passed through). Replaces the file in place. No-op with a clear warning when
 * ghostscript is missing, so the pipeline still produces the plain PDF.
 *
 * colorMode: "cmyk" (color art / typeset book) | "gray" (grayscale scans,
 * stays single-channel K) | "keep" (leave colors, disables PDF/X).
 */
export async function toPrintPdf(ctx, { pdfPath, colorMode = 'cmyk', settings = {}, debugDir, label = 'print' }) {
  // druck.at: "schwarze Schriften immer in reinem Schwarz (100% K)". A generic
  // RGB→CMYK turns pure-black text into rich black; remap it to DeviceGray
  // first (which converts to K-only) before the CMYK pass. CMYK output only.
  if (colorMode === 'cmyk' && settings.pureBlack !== false) {
    await pureBlackRemap(ctx, pdfPath, label);
  }

  const tmp = `${pdfPath}.print.tmp`;
  const args = [
    '-q', '-dBATCH', '-dNOPAUSE', '-dSAFER',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/prepress',
    '-dCompatibilityLevel=1.3', // after /prepress so it wins: forces transparency flattening (PDF/X-1a)
    '-dEmbedAllFonts=true', '-dSubsetFonts=true',
    '-dAutoRotatePages=/None',
    '-dDetectDuplicateImages=true',
    '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
    '-dPassThroughJPEGImages=true',
    ...colorArgs(colorMode),
  ];

  // PDF/X needs a device color space + an output-intent ICC profile.
  let defPath = null;
  let pdfxVersion = null;
  const wantPdfx = settings.pdfx !== false && colorMode !== 'keep';
  if (wantPdfx) {
    const icc = findCmykIcc(settings.iccProfile);
    if (icc) {
      pdfxVersion = settings.pdfx === 'X-3' ? 'PDF/X-3:2002' : 'PDF/X-1a:2001';
      defPath = path.join(os.tmpdir(), `pdfx-${process.pid}-${Date.now()}.ps`);
      fs.writeFileSync(defPath, pdfxDef({ icc, version: pdfxVersion, condition: settings.outputIntent || 'Coated FOGRA51' }));
      args.push('-dPDFX', `--permit-file-read=${path.dirname(icc)}`);
    } else {
      ctx.log(`  ${label}: no CMYK ICC profile found — writing a ${colorMode.toUpperCase()} PDF without a PDF/X output intent (set print.iccProfile to a FOGRA profile for full PDF/X)`);
    }
  }
  args.push(`-sOutputFile=${tmp}`);
  if (defPath) args.push(defPath); // the def must be interpreted before the input PDF
  args.push(pdfPath);

  try {
    const { stderr } = await run('gs', args, { capture: true, quiet: true });
    if (debugDir) fs.writeFileSync(path.join(debugDir, 'ghostscript.log'), stderr);
    fs.renameSync(tmp, pdfPath);
    const tag = pdfxVersion ? pdfxVersion.replace(':', ' ') : `${colorMode.toUpperCase()} (no PDF/X)`;
    ctx.log(`  ${label}: print-ready — fonts embedded, transparency flattened, ${colorMode.toUpperCase()} · ${tag}`);
    return { ok: true, colorMode, pdfx: pdfxVersion };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err.code === 'ENOENT' || /spawn gs\b|gs ENOENT/.test(err.message)) {
      ctx.log(`  ${label}: ghostscript not found — skipping print-ready conversion (install ghostscript for CMYK/PDF-X)`);
      return { ok: false, reason: 'no-gs' };
    }
    throw new Error(`${label}: Ghostscript print pass failed: ${err.message}`);
  } finally {
    if (defPath) fs.rmSync(defPath, { force: true });
  }
}

/**
 * Remap pure-black RGB fills/strokes (`0 0 0 rg` / `0 0 0 RG`) to DeviceGray
 * black (`0 g` / `0 G`) so the CMYK pass renders them as 100% K, not rich
 * black. qpdf uncompresses the streams (keeping the xref valid); the swap is
 * length-preserving (padded with spaces) so offsets stay correct. Color
 * content is untouched. No-op (warning) when qpdf is missing.
 */
async function pureBlackRemap(ctx, pdfPath, label) {
  const tmp = `${pdfPath}.uncomp`;
  try {
    await run('qpdf', ['--stream-data=uncompress', '--object-streams=disable', '--', pdfPath, tmp], { capture: true, quiet: true, allowFailure: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      ctx.log(`  ${label}: qpdf not found — skipping pure-black remap (black text may stay rich black)`);
      return 0;
    }
    throw err;
  }
  if (!fs.existsSync(tmp)) return 0; // qpdf failed; keep the original
  const buf = fs.readFileSync(tmp);
  let n = 0;
  for (const [from, to] of [['0 0 0 rg', '0 g     '], ['0 0 0 RG', '0 G     ']]) {
    const needle = Buffer.from(from, 'latin1');
    const repl = Buffer.from(to, 'latin1'); // same byte length → offsets unchanged
    let i = 0;
    while ((i = buf.indexOf(needle, i)) !== -1) {
      repl.copy(buf, i);
      n++;
      i += repl.length;
    }
  }
  fs.writeFileSync(pdfPath, buf);
  fs.rmSync(tmp, { force: true });
  if (n) ctx.log(`  ${label}: pure-black — ${n} black fill(s)/stroke(s) set to K-only`);
  return n;
}

function colorArgs(mode) {
  if (mode === 'gray') return ['-sColorConversionStrategy=Gray', '-sProcessColorModel=DeviceGray'];
  if (mode === 'keep') return ['-sColorConversionStrategy=LeaveColorUnchanged'];
  return ['-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK'];
}

/** PostScript that tags the output PDF/X and embeds the CMYK output intent. */
function pdfxDef({ icc, version, condition }) {
  const ps = (s) => String(s).replace(/([()\\])/g, '\\$1');
  return `%!
[ /GTS_PDFXVersion (${ps(version)}) /GTS_PDFXConformance (${ps(version)}) /DOCINFO pdfmark
[ /_objdef {icc_PDFX} /type /stream /OBJ pdfmark
[ {icc_PDFX} << /N 4 >> /PUT pdfmark
[ {icc_PDFX} (${ps(icc)}) (r) file /PUT pdfmark
[ /_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark
[ {OutputIntent_PDFX} << /Type /OutputIntent /S /GTS_PDFX /DestOutputProfile {icc_PDFX} /OutputConditionIdentifier (${ps(condition)}) /Info (${ps(condition)}) /RegistryName (http://www.color.org) >> /PUT pdfmark
[ {Catalog} << /OutputIntents [ {OutputIntent_PDFX} ] >> /PUT pdfmark
`;
}

/** Locate a CMYK ICC profile for the output intent (Ghostscript ships one). */
function findCmykIcc(custom) {
  if (custom) return fs.existsSync(custom) ? custom : null;
  const roots = ['/usr/share/ghostscript', '/usr/share/color/icc', '/opt/ghostscript'];
  for (const root of roots) {
    const hit = searchFile(root, 'default_cmyk.icc', 4);
    if (hit) return hit;
  }
  return null;
}

/** Shallow breadth-limited search for a file name under a directory. Follows
 *  symlinks (Ghostscript's share dir may be linked), so classify by statSync. */
function searchFile(root, name, maxDepth) {
  if (!fs.existsSync(root)) return null;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry);
      let st;
      try {
        st = fs.statSync(p); // follows symlinks
      } catch {
        continue;
      }
      if (st.isFile() && entry === name) return p;
      if (st.isDirectory() && depth < maxDepth) stack.push([p, depth + 1]);
    }
  }
  return null;
}
