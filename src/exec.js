import { spawn } from 'node:child_process';

/**
 * Run an external command, returning a promise that resolves with the
 * captured stdout/stderr. Rejects on a non-zero exit code or spawn error.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ capture?: boolean, cwd?: string }} [options]
 */
export function run(cmd, args, { capture = true, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`Required command "${cmd}" was not found on PATH.`));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr.trim() || stdout.trim();
        reject(
          new Error(`Command "${cmd} ${args.join(' ')}" failed (exit ${code})${detail ? `:\n${detail}` : ''}`)
        );
      }
    });
  });
}

/**
 * Check whether a command exists on PATH.
 * @param {string} cmd
 * @returns {Promise<boolean>}
 */
export async function commandExists(cmd) {
  try {
    await run('sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that all required external tools are available, throwing a helpful
 * error listing everything that is missing.
 * @param {string[]} tools
 */
export async function ensureTools(tools) {
  const missing = [];
  for (const tool of tools) {
    if (!(await commandExists(tool))) {
      missing.push(tool);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required tool(s): ${missing.join(', ')}.\n` +
        'These are provided by the Docker image. If running outside Docker, install ' +
        'poppler-utils (pdftoppm), imagemagick (convert/identify) and img2pdf.'
    );
  }
}
