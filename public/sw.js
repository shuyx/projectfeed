// projectfeed Service Worker · build 2026-04-26 v1.24.0 (project-board grouped view)
// Strategy:
//   - HTML / JS / CSS → network-first with 1s timeout, fallback to cache (truly fresh, no stale-while-revalidate)
//   - Icons / manifest → cache-first (rarely change, save bandwidth)
//   - API → network-only (no cache)

const CACHE_VERSION = 'projectfeed-v29'; // bump for v1.28.2 chart full redesign
const STATIC_ASSETS = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

function isNetworkFirstAsset(url) {
  // JS/CSS always network-first so bug fixes propagate on next load
  return url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
}

function isCacheFirstAsset(url) {
  // Binary assets that rarely change
  return (
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname === '/manifest.json'
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // API: pass through, no caching
  if (url.pathname.startsWith('/api/')) return;

  // HTML (navigation) or JS/CSS: true network-first with 1s timeout fallback to cache
  // v1.18: replaced stale-while-revalidate — users now get fresh code on every load
  const networkFirstCandidate =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    isNetworkFirstAsset(url);

  if (networkFirstCandidate) {
    event.respondWith((async () => {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 1000);
      try {
        const resp = await fetch(event.request, { signal: controller.signal });
        clearTimeout(tid);
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, copy));
        }
        return resp;
      } catch {
        clearTimeout(tid);
        const cached = await caches.match(event.request);
        if (cached) return cached;
        const root = await caches.match('/');
        return root || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })());
    return;
  }

  // Icons / manifest: cache-first
  if (isCacheFirstAsset(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
          }
          return resp;
        });
      })
    );
    return;
  }

  // Default: try network, cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
