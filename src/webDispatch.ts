/**
 * Web traffic dispatch — development proxy vs production static SPA.
 *
 * Development (unified port — see settings.runModes.test.backendPort, default 5089):
 *   - User opens ONE URL (e.g. http://localhost:5089).
 *   - /api/* and /ws/* are handled by the bridge.
 *   - Everything else is proxied to ng serve on webPort (HMR, internal only).
 *
 * Production:
 *   - Serve compiled assets from web/dist with SPA index.html fallback.
 */

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type HttpProxy from 'http-proxy';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { childLogger } from './log.js';

const log = childLogger('web-dispatch');

/** SharedArrayBuffer isolation — required for vosk-browser wake-word WASM. */
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

const BACKEND_WS_PATHS = ['/ws/control', '/ws/intelligence', '/ws/events'] as const;

function pathnameOf(url: string): string {
  return url.split('?')[0] ?? url;
}

function isBackendWebSocket(pathname: string): boolean {
  return BACKEND_WS_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isBackendOnlyPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || isBackendWebSocket(pathname);
}

/**
 * Load `http-proxy` on demand.
 *
 * It is a devDependency and only the Angular dev proxy needs it, so a
 * production install (`npm i -g`, a .deb, or a pruned `node_modules`) has no
 * copy of it. A top-level import made every such install crash on boot; the
 * dynamic import keeps the cost inside the one dev-only code path.
 */
async function loadHttpProxy(): Promise<typeof HttpProxy> {
  try {
    const mod = (await import('http-proxy')) as unknown as {
      default?: typeof HttpProxy;
    } & typeof HttpProxy;
    return mod.default ?? mod;
  } catch (err) {
    throw new Error(
      'The Angular dev proxy needs the "http-proxy" package, which is a devDependency. ' +
        'Run `npm install` in a git checkout, or start the bridge in production mode ' +
        `(it then serves web/dist directly). Original error: ${String(err)}`,
    );
  }
}

/** Proxy non-API / non-backend-WS traffic to the Angular dev server. */
export async function attachDevWebProxy(app: FastifyInstance, webPort: number): Promise<void> {
  const target = `http://127.0.0.1:${webPort}`;
  const httpProxy = await loadHttpProxy();
  const proxy = httpProxy.createProxyServer({ target, ws: true, changeOrigin: true });

  proxy.on('proxyRes', (proxyRes) => {
    for (const [key, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
      proxyRes.headers[key.toLowerCase()] = value;
    }
  });

  proxy.on('error', (err, req, res) => {
    log.warn({ err, url: req.url }, 'dev web proxy error');
    const response = res as ServerResponse | undefined;
    if (response && typeof response.writeHead === 'function' && !response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end(
        'Angular dev server unavailable — ensure ng serve is running on port ' + webPort,
      );
      return;
    }
    // WebSocket upgrade failures pass a Socket — not a ServerResponse.
    const socket = res as Socket | undefined;
    if (socket && typeof socket.destroy === 'function') {
      socket.destroy();
    }
  });

  app.addHook('onReady', async () => {
    app.server.on('upgrade', (req, socket, head) => {
      const pathname = pathnameOf(req.url ?? '');
      if (isBackendWebSocket(pathname)) return;
      proxy.ws(req, socket, head);
    });
    log.info({ target }, 'dev web proxy websocket upgrades enabled');
  });

  app.setNotFoundHandler((req, reply) => {
    const pathname = pathnameOf(req.url);
    if (isBackendOnlyPath(pathname)) {
      return reply.code(404).send({ error: 'Not found' });
    }

    return new Promise<void>((resolve, reject) => {
      reply.hijack();
      proxy.web(req.raw, reply.raw, { target }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  log.info({ target }, 'dev web proxy enabled');
}

/** Serve web/dist in production with SPA router fallback. */
export async function registerProductionWeb(
  app: FastifyInstance,
  webDistPath: string,
): Promise<void> {
  if (!existsSync(webDistPath)) {
    log.warn('web/dist not found — run npm run build:web');
    return;
  }

  // `wildcard: true` resolves files per request. With `false`, routes are
  // registered from a boot-time directory listing, so a rebuild's new asset
  // hashes fall through to the SPA handler (index.html served as .js/.css)
  // until the process restarts.
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    wildcard: true,
  });

  app.setNotFoundHandler((req, reply) => {
    const pathname = pathnameOf(req.url);
    if (isBackendOnlyPath(pathname)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  log.info({ webDistPath }, 'production static web serving enabled');
}
