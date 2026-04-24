// projectfeed Service Worker · build 2026-04-24 v1.11 (search + AI card click-outside collapse)
// Strategy:
//   - HTML → network-first (always fresh, fallback to cache if offline)
//   - JS / CSS → network-first (PWA iteration phase — never stuck on stale code)
//   - Icons / manifest → cache-first (rarely change, save bandwidth)
//   - API → network-only (no cache)

const CACHE_VERSION = 'projectfeed-v2';
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

  // HTML (navigation) or JS/CSS: network-first
  const networkFirst =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    isNetworkFirstAsset(url);

  if (networkFirst) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
          }
          return resp;
        })
        .catch(() =>
          caches.match(event.request).then((r) => r || caches.match('/'))
        )
    );
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
