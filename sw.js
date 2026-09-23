/* WayBack service worker: офлайн-оболонка + кеш плиток карти */
const VERSION = 'wayback-v1.1.0';
const TILE_CACHE = 'wayback-tiles';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'leaflet.js', 'leaflet.css',
];
const OPTIONAL = ['icon-192-1.png', 'icon-512-1.png', 'icon-maskable-512.png'];
const TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com|basemaps\.cartocdn\.com)$/;
const tileKey = (url) => url.replace(/^https:\/\/[a-d]\./, 'https://').replace(/\?.*$/, '');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL).then(() => Promise.all(OPTIONAL.map((u) => c.add(u).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // плитки карти: спершу кеш, потім мережа (і зберегти)
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const key = tileKey(req.url);
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 9000); // не чекати вічно на повільний сервер
        const res = await fetch(req.url, { mode: 'cors', credentials: 'omit', signal: ctl.signal });
        clearTimeout(timer);
        if (res.ok) cache.put(key, res.clone());
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  // файли додатку: з кешу одразу, оновлення у фоні
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const res = await net;
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('index.html');
      return new Response('', { status: 504 });
    })());
  }
});
