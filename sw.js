/* WayBack service worker: офлайн-оболонка + кеш плиток карти */
const VERSION = 'wayback-v1.5.1';
const TILE_CACHE = 'wayback-tiles';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'leaflet.js', 'leaflet.css', 'qr.js',
];
const OPTIONAL = ['icon-192-1.png', 'icon-512-1.png', 'icon-maskable-512.png'];
const TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com)$/;
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

  // файли додатку: спершу мережа (щоб оновлення з'являлось одразу),
  // але не довше 3.5 с — далі кеш. Без мережі — завжди кеш.
  if (url.origin === self.location.origin) {
    // запити з ?t=... — це перевірка оновлення, повз кеш
    if (url.search) { e.respondWith(fetch(req).catch(() => new Response('', { status: 504 }))); return; }
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = () => cache.match(req, { ignoreSearch: true })
        .then((r) => r || (req.mode === 'navigate' ? cache.match('index.html') : null));
      if (!navigator.onLine) {
        const hit = await cached();
        if (hit) return hit;
      }
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3500);
        const res = await fetch(new Request(req.url, { cache: 'reload' }), { signal: ctl.signal });
        clearTimeout(timer);
        if (res && res.ok) { cache.put(req, res.clone()); return res; }
        throw new Error('bad status');
      } catch (err) {
        const hit = await cached();
        if (hit) return hit;
        return new Response('', { status: 504 });
      }
    })());
  }
});
