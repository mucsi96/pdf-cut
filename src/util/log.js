const start = Date.now();

function ts() {
  return ((Date.now() - start) / 1000).toFixed(1).padStart(6) + 's';
}

export const log = {
  info: (...args) => console.log(`[${ts()}]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] WARN`, ...args),
  error: (...args) => console.error(`[${ts()}] ERROR`, ...args),
  stage: (name, msg) => console.log(`[${ts()}] [${name}] ${msg}`)
};
