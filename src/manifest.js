import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MANIFEST = 'manifest.json';

export function hashParams(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

export function readManifest(stageDir) {
  const file = path.join(stageDir, MANIFEST);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeManifest(stageDir, data) {
  fs.writeFileSync(path.join(stageDir, MANIFEST), JSON.stringify(data, null, 2));
}

export function isUpToDate(stageDir, paramsHash) {
  const m = readManifest(stageDir);
  return !!m && m.paramsHash === paramsHash && m.completedAt;
}
