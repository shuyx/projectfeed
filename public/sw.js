// projectfeed Service Worker · build 2026-04-24 v1.16.9 (summarize timeout fix + radio-row selected highlight)
// Strategy:
//   - HTML → network-first (always fresh, fallback to cache if offline)
//   - JS / CSS → network-first (PWA iteration phase — never stuck on stale code)
//   - Icons / manifest → cache-first (rarely change, save bandwidth)
//   - API → network-only (no cache)

const CACHE_VERSION = 'projectfeed-v3';
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

  // HTML (navigation) or JS/CSS: stale-while-revalidate
  // v1.16.4: 5G/弱网下立即返回 cache 秒开 + 后台拉新版进 cache（下次打开生效）
  const swrCandidate =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    isNetworkFirstAsset(url);

  if (swrCandidate) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      // 后台 revalidate（不阻塞响应）
      const networkP = fetch(event.request).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        }
        return resp;
      }).catch(() => null);
      // 有 cache → 立即返回（秒开）
      if (cached) {
        networkP;  // fire-and-forget
        return cached;
      }
      // 首次访问无 cache → 等 network，失败 fallback 到根 shell
      const fresh = await networkP;
      if (fresh) return fresh;
      const root = await caches.match('/');
      return root || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
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
