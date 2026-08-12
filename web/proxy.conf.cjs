/**
 * Angular dev-server proxy — browser entry is :4200; /api and /ws go to the bridge.
 * Backend port comes from config.json → settings.runModes.test.backendPort.
 */
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

function readBackendPort() {
  const configPath = resolve(process.cwd(), 'config.json');
  if (!existsSync(configPath)) return 5089;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    return cfg.settings?.runModes?.test?.backendPort ?? 5089;
  } catch {
    return 5089;
  }
}

const port = readBackendPort();
const target = `http://127.0.0.1:${port}`;
const wsTarget = `ws://127.0.0.1:${port}`;

module.exports = {
  '/api': {
    target,
    secure: false,
    logLevel: 'warn',
    timeout: 0,
    proxyTimeout: 0,
    onProxyRes(proxyRes) {
      const type = String(proxyRes.headers['content-type'] || '');
      if (type.includes('text/event-stream')) {
        proxyRes.headers['cache-control'] = 'no-cache, no-transform';
        proxyRes.headers['x-accel-buffering'] = 'no';
      }
    },
  },
  '/ws': {
    target: wsTarget,
    ws: true,
    secure: false,
    logLevel: 'warn',
  },
};
