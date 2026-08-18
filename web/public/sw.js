/**
 * AgentVoice — Service Worker
 *
 * Minimal PWA service worker. Caches the app shell so the UI loads
 * instantly even on a slow Tailscale connection. API calls are always
 * fetched from the network (the bridge may be offline; we don't cache
 * stale data).
 *
 * Strategy: network-first for API routes, cache-first for static assets.
 * Offline voice models (Vosk archive, Silero VAD graph + ONNX runtime) are
 * cache-first after first download, so the app pays for them once. The PWA
 * pre-fetches them with progress into these same caches — see
 * web/src/model-download.ts.
 *
 * Cache is versioned — bump CACHE_NAME when deploying a new build, and
 * MODEL_CACHE_NAME when the bundled model assets themselves change.
 */

const CACHE_NAME = 'agentvoice-v4';
const VOSK_CACHE_NAME = 'agentvoice-vosk-v1';
const MODEL_CACHE_NAME = 'agentvoice-models-v1';
const VOSK_MODEL_PATH = '/vosk/model.tar.gz';
const SILERO_ASSET_PREFIX = '/silero-vad/';

const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon.svg',
];

// ── Install: pre-cache the app shell ──────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

// ── Activate: clean up old caches ─────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== CACHE_NAME &&
                key !== VOSK_CACHE_NAME &&
                key !== MODEL_CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Fetch: network-first for API, cache-first for assets ──────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept: API calls, WebSocket upgrades, cross-origin requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws/') ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // Offline voice models — cache-first, so a repeat visit never re-downloads them.
  // The PWA writes these same entries ahead of time with a progress bar; a direct
  // hit here is the fallback for anything it did not pre-fetch (e.g. the ONNX
  // runtime binary, whose filename ORT picks at runtime).
  if (event.request.method === 'GET') {
    const modelCache =
      url.pathname === VOSK_MODEL_PATH
        ? VOSK_CACHE_NAME
        : url.pathname.startsWith(SILERO_ASSET_PREFIX)
          ? MODEL_CACHE_NAME
          : null;

    if (modelCache) {
      event.respondWith(
        caches.open(modelCache).then(async (cache) => {
          const cached = await cache.match(url.pathname);
          if (cached) return cached;
          const response = await fetch(event.request);
          if (response.ok) {
            await cache.put(url.pathname, response.clone());
          }
          return response;
        }),
      );
      return;
    }
  }

  event.respondWith(
    // Network first — serve fresh; fall back to cache if offline
    fetch(event.request)
      .then((res) => {
        // Only cache successful GET responses
        if (event.request.method === 'GET' && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? Response.error())),
  );
});

// ── Web Push: agent approvals, job done, images ───────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { body: event.data.text() };
  }
  const p = payload;
  const title = p.title || 'AgentVoice';
  const body = p.body || 'New update from Cursor';
  const tag = p.tag || 'agentvoice';
  const url = p.url || '/?tab=voice';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
      requireInteraction: p.type === 'user_input_request' || p.type === 'plan_approval_request',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/?tab=voice';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    }),
  );
});
