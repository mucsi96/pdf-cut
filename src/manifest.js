import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function paramsHash(obj) {
  return createHash('sha1').update(stableStringify(obj)).digest('hex');
}

export async function fileHash(filePath) {
  const buf = await fs.readFile(filePath);
  return createHash('sha1').update(buf).digest('hex');
}

const MANIFEST = 'manifest.json';

export async function loadManifest(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return { paramsHash: null, items: {} };
  }
}

export async function saveManifest(dir, manifest) {
  await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
}
