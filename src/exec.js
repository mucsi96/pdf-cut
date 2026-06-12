import { spawn } from 'node:child_process';

/**
 * Run an external command, streaming its output prefixed with the tool name.
 * Resolves with { code, stdout, stderr }. Rejects on non-zero exit unless
 * opts.allowFailure is set.
 */
export function run(cmd, args, opts = {}) {
  const { cwd, env, capture = false, allowFailure = false, quiet = false, label } = opts;
  const tag = label || cmd;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (!quiet && !capture) process.stdout.write(prefix(tag, s));
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (!quiet) process.stderr.write(prefix(tag, s));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${tag} exited with code ${code}\n${stderr.slice(-2000)}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function prefix(tag, text) {
  return text
    .split('\n')
    .map((l) => (l.length ? `  [${tag}] ${l}` : l))
    .join('\n');
}
