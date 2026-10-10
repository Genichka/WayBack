/* WayBack service worker: офлайн-оболонка + кеш плиток карти.
   Цей файл між версіями НЕ змінюється (як у WordHunter і EnergyUA Junior): інакше браузер
   сам поставить новий service worker, і додаток оновиться без дозволу.
   Нову версію ставить сам WayBack після «🔄 Оновити»: чистить кеш оболонки (карти лишає),
   знімає service worker і перезавантажується. Номер версії - у app.js і version.json. */
const CACHE = 'wayback-app';
const TILE_CACHE = 'wayback-tiles';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'leaflet.js', 'leaflet.css', 'qr.js',
];
const OPTIONAL = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com)$/;
const tileKey = (url) => url.replace(/^https:\/\/[a-d]\./, 'https://').replace(/\?.*$/, '');
const fresh = (u) => new Request(u, { cache: 'reload' });

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(SHELL.map((u) => c.add(fresh(u))))
      .then(() => Promise.all(OPTIONAL.map((u) => c.add(fresh(u)).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
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

  if (url.origin !== self.location.origin) return;
  // version.json і запити з ?t=... - перевірка оновлення, лише мережа
  if (url.pathname.endsWith('/version.json') || url.searchParams.has('t')) {
    e.respondWith(fetch(req).catch(() => new Response('', { status: 504 })));
    return;
  }
  // файли додатку: спершу збережене (так нова версія не підміняє стару сама), інакше мережа
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('index.html') || await cache.match('./') : null);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
