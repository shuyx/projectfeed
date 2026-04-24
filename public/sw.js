// projectfeed Service Worker
// Strategy:
//   - HTML/API → network-first (always fresh, fallback to cache if offline)
//   - Static assets (js/css/icons) → cache-first

const CACHE_VERSION = 'projectfeed-v1';
const STATIC_ASSETS = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

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
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // API: network-only (fresh data always), offline → let it fail gracefully
  if (url.pathname.startsWith('/api/')) return;

  // HTML: network-first
  if (event.request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
          return resp;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match('/')))
    );
    return;
  }

  // Static: cache-first
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
});
