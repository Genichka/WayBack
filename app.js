/* WayBack — повернись на точку. PWA, працює онлайн і офлайн. */
'use strict';

const APP_VERSION = '1.21.1';
const $ = (s) => document.querySelector(s);
// Android-додаток (WebView) підкладає window.WayBackNative; у браузері його немає
const NATIVE = typeof window.WayBackNative !== 'undefined';
const WEB_URL = 'https://genichka.github.io/WayBack/';
const RAW_APP_JS = 'https://raw.githubusercontent.com/Genichka/WayBack/main/app.js';
let nativeTimer = null;   // тут, а не нижче: LS.set викликається ще під час старту
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('wb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) {
    const raw = (() => { try { return JSON.stringify(v); } catch (e) { return null; } })();
    if (raw == null) return false;
    try { localStorage.setItem('wb.' + k, raw); nativeSyncSoon(k); return true; }
    catch (e) {
      // Жертвувати треками можна ЛИШЕ коли браузер прямо каже «місця немає».
      // Приватний режим чи вимкнене сховище - теж помилка, але історію там чіпати не можна.
      const quota = !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
                            || e.code === 22 || e.code === 1014);
      if (!quota) { toast('Не вдалося зберегти дані на цьому пристрої', 'warn'); return false; }
      if (typeof S === 'undefined' || !S.tracks) { toast('Памʼять заповнена', 'warn'); return false; }
      let dropped = 0;
      while (S.tracks.length > 1 && dropped < 20) {     // звільняємо місце найстарішими треками
        S.tracks.pop(); dropped++;
        try {
          localStorage.setItem('wb.tracks', JSON.stringify(S.tracks));
          if (k !== 'tracks') localStorage.setItem('wb.' + k, raw);
          toast(`Памʼять була заповнена — прибрано найстаріших треків: ${dropped}`, 'warn');
          return true;
        } catch (e2) { /* ще мало місця - пробуємо далі */ }
      }
      toast('Не вдалося зберегти — памʼять заповнена', 'warn');
      return false;
    }
  },
};

/* ---------- map layers ---------- */
const LAYERS = {
  osm: { name: 'Схема', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, dl: false,
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  topo: { name: 'Топо', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', sub: 'abc', max: 17, dl: true,
    attr: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a>' },
  sat: { name: 'Супутник', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 18, dl: true,
    attr: '© Esri, Maxar, Earthstar Geographics' },
  dark: { name: 'Темна', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', max: 16, dl: true,
    attr: '© Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright">OSM</a>' },
};
const TILE_CACHE = 'wayback-tiles';
const tileKey = (url) => url.replace(/^https:\/\/[a-d]\./, 'https://').replace(/\?.*$/, '');

/* ---------- state ---------- */
const DEF_SETTINGS = { v: 5, layer: 'osm', theme: 'dark', wake: true, vibrate: true, auto: true, autorec: false, radius: 3, zmax: 16, rmode: 'route', travel: 'foot', rmodeBy: { city: 'route', forest: 'track', mount: 'track' }, profile: 'city' };

/* Профіль середовища. Міняє не лише підпис, а й поведінку:
   layer   - шар карти за замовчуванням
   minStep - мінімальний крок між точками треку, м (у лісі густіше - точніше назад)
   maxAcc  - гірша похибка GPS, за якої точку ще пишемо (під кроною вона велика)
   arrive  - радіус "ти на місці", м */
const PROFILES = {
  city:   { name: 'Місто', ico: '🏙️', layer: 'osm',  rmode: 'route', minStep: 8, maxAcc: 40, arrive: 15,
            info: 'Дороги й вулиці, схема карти. Повернення вулицями — потрібен інтернет.' },
  forest: { name: 'Ліс',   ico: '🌲', layer: 'topo', rmode: 'track', minStep: 5, maxAcc: 60, arrive: 25,
            info: 'Ведення своїм треком, топокарта, густіший запис. Завантаж район заздалегідь.' },
  mount:  { name: 'Гори',  ico: '⛰️', layer: 'topo', rmode: 'track', minStep: 4, maxAcc: 60, arrive: 30,
            info: 'Тільки трек: пряма в горах може вести через урвище. Показано висоту.' },
};
const PROF = () => PROFILES[S.settings.profile] || PROFILES.city;
const S = {
  settings: (() => {
    const st = Object.assign({}, DEF_SETTINGS, LS.get('settings', {}));
    if (!(st.v >= 2)) { st.v = 2; st.layer = 'osm'; }
    // v4: спосіб повернення став окремим для кожного профілю.
    // У місті типово «дорогами», щоб не вести через квартали.
    if (!(st.v >= 4) || !st.rmodeBy) {
      st.rmodeBy = Object.assign({}, DEF_SETTINGS.rmodeBy);
      st.rmode = st.rmodeBy[st.profile] || 'route';
      st.v = 4;
    }
    // v5: запис більше не починається сам. Хто хоче - увімкне вручну в «Інше».
    if (!(st.v >= 5)) { st.autorec = false; st.v = 5; }
    return st;
  })(),
  points: LS.get('points', []),
  targetId: LS.get('target', null),
  track: LS.get('track', null),        // активний трек {id,start,pts:[[lat,lon,t,acc,alt]],dist}
  tracks: LS.get('tracks', []),        // історія
  pos: null,
  heading: null, headingSrc: null, lastCompass: 0,
  follow: true, firstFix: true, pendingStart: false, arrived: false, navOpen: false,
  shownTrackId: null,
  // повернення: rpath - ламана від мене до цілі, rsrc - звідки вона ('track'|'route')
  rpath: null, rsrc: null, rpathLen: null, rpathFrom: null, rpathAt: 0,
  rBusy: false, rErr: null, rOff: false, rLastReq: 0,
  rVia: null, rSnap: 0, noLine: false,   // чим порахували, як далеко дорога, і чи свідомо без лінії
};
// у старих версіях вибір був дрібніший - приводимо до нового набору
(() => {
  const near = (v, list) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  S.settings.radius = near(+S.settings.radius || 3, [1, 3, 10]);
  S.settings.zmax = near(+S.settings.zmax || 16, [16, 17]);
})();
const saveSettings = () => LS.set('settings', S.settings);
const savePoints = () => { LS.set('points', S.points); LS.set('target', S.targetId); };
/* Треки живуть у localStorage, а він на домен дає близько 5 МБ.
   Одна точка - 42 байти, тож густий лісовий трек на 10 км це ~80 КБ.
   Тримаємо історію в межах бюджету, найстаріші витісняються. */
const TRACKS_BUDGET = 1.5 * 1024 * 1024;
const tracksBytes = () => JSON.stringify(S.tracks).length;
function trimTracks() {
  if (S.tracks.length > 40) S.tracks = S.tracks.slice(0, 40);
  let dropped = 0;
  while (S.tracks.length > 1 && tracksBytes() > TRACKS_BUDGET) { S.tracks.pop(); dropped++; }
  return dropped;
}
let trackSaveTimer = null;
const saveTrack = (now) => {
  clearTimeout(trackSaveTimer);
  if (now) LS.set('track', S.track); else trackSaveTimer = setTimeout(() => LS.set('track', S.track), 4000);
};

/* ---------- geo helpers ---------- */
const R = 6371008.8, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function dist(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const DIRS = ['Пн', 'ПнСх', 'Сх', 'ПдСх', 'Пд', 'ПдЗх', 'Зх', 'ПнЗх'];
const dirName = (b) => DIRS[Math.round(b / 45) % 8];
const fmtDist = (m) => m == null ? '—' : m < 1000 ? Math.round(m) + ' м' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' км';
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}
const fmtDate = (t) => new Date(t).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtCoord = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}
function vibrate(p) { if (S.settings.vibrate && navigator.vibrate) try { navigator.vibrate(p); } catch (e) { /* */ } }

function modal({ title, html, ok = 'Зберегти', cancel = 'Скасувати', onOpen, validate }) {
  return new Promise((resolve) => {
    $('#mTitle').textContent = title; $('#mBody').innerHTML = html || '';
    $('#mOk').textContent = ok; $('#mCancel').textContent = cancel;
    $('#mCancel').classList.toggle('hidden', !cancel);
    $('#modal').classList.remove('hidden');
    if (onOpen) onOpen($('#mBody'));
    // торкнулись поля - клавіатура з'їсть половину екрана, тож підтягуємо поле вгору
    $('#mBody').querySelectorAll('input, textarea').forEach((el) => {
      el.addEventListener('focus', () => setTimeout(() => {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      }, 260));
    });
    const close = (val) => { $('#modal').classList.add('hidden'); $('#mOk').onclick = $('#mCancel').onclick = null; resolve(val); updAskLater(); };
    $('#mOk').onclick = () => { const v = validate ? validate($('#mBody')) : true; if (v !== false && v !== undefined) close(v); };
    $('#mCancel').onclick = () => close(null);
  });
}
const confirmBox = (title, text, ok = 'Так') => modal({ title, html: `<p class="note" style="font-size:14px;color:var(--text)">${text}</p>`, ok, validate: () => true });

/* Клавіатура не зменшує звичайне вікно, тому міряємо видиму частину самі -
   модальне вікно за нею підлаштовується і кнопки лишаються на видноті. */
(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    const r = document.documentElement.style;
    r.setProperty('--vvh', Math.round(vv.height) + 'px');
    r.setProperty('--vvt', Math.round(vv.offsetTop) + 'px');
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
})();

/* ---------- theme ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  document.querySelector('meta[name=theme-color]').content = S.settings.theme === 'light' ? '#ffffff' : '#111217';
}
applyTheme();

/* ---------- map ---------- */
const view = LS.get('view', { c: [49.0, 31.3], z: 6 });
const map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 19, preferCanvas: true, fadeAnimation: true }).setView(view.c, view.z);
let baseLayer = null;

/* Шар плиток з повторами і запасним показом: якщо плитка не прийшла — ще 3 спроби
   (з іншим піддоменом), далі показуємо збільшену плитку з меншого масштабу (з кешу/мережі).
   Завдяки цьому немає порожніх квадратів ні онлайн, ні офлайн. */
const FastTiles = L.TileLayer.extend({
  createTile(coords, done) {
    const wrap = document.createElement('div');
    wrap.className = 'wb-tile';
    const img = document.createElement('img');
    img.alt = ''; img.decoding = 'async'; img.draggable = false;
    img.crossOrigin = 'anonymous';
    wrap.appendChild(img);
    let tries = 0, finished = false, parentLevel = 0;
    const finish = (err) => { if (!finished) { finished = true; done(err, wrap); } };
    img.onload = () => finish(null);
    img.onerror = () => {
      if (tries < 3) {
        tries++;
        setTimeout(() => { img.src = this._urlFor(coords, tries); }, 300 * tries);
      } else if (parentLevel < 4 && coords.z - parentLevel > 3) {
        parentLevel++;
        this._showParent(img, coords, parentLevel);
      } else finish(new Error('tile'));
    };
    img.src = this._urlFor(coords, 0);
    return wrap;
  },
  _urlFor(c, attempt) {
    const subs = this.options.subdomains;
    const data = { x: c.x, y: c.y, z: this._getZoomForUrl(), s: subs[(Math.abs(c.x + c.y) + attempt) % subs.length], r: '' };
    const url = L.Util.template(this._url, L.Util.extend(data, this.options));
    return attempt && subs.length < 2 ? url + '?r=' + attempt : url;
  },
  _showParent(img, c, k) {
    const z = this._getZoomForUrl() - k, f = 1 << k;
    const px = Math.floor(c.x / f), py = Math.floor(c.y / f);
    const ts = this.getTileSize().x;
    const url = L.Util.template(this._url, L.Util.extend({ x: px, y: py, z, s: this.options.subdomains[0], r: '' }, this.options));
    img.style.width = img.style.height = ts * f + 'px';
    img.style.left = -(c.x - px * f) * ts + 'px';
    img.style.top = -(c.y - py * f) * ts + 'px';
    img.src = url;
  },
});

function setLayer(id) {
  const l = LAYERS[id] || LAYERS.osm;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = new FastTiles(l.url, {
    subdomains: l.sub || 'abc', maxNativeZoom: l.max, maxZoom: 19, attribution: l.attr,
    keepBuffer: 4, updateWhenZooming: false, updateWhenIdle: false,
  }).addTo(map);
  S.settings.layer = id; saveSettings();
}
setLayer(S.settings.layer);
map.on('moveend', () => { const c = map.getCenter(); LS.set('view', { c: [c.lat, c.lng], z: map.getZoom() }); updateDlInfo(); });
map.on('dragstart', () => setFollow(false));
map.getContainer().addEventListener('touchstart', (e) => { if (e.touches.length > 1) setFollow(false); }, { passive: true });
map.getContainer().addEventListener('wheel', () => setFollow(false), { passive: true });

const meIcon = L.divIcon({ className: '', html: '<div class="me"><div class="me-dir" id="meDir"></div><div class="me-dot"></div></div>', iconSize: [26, 26], iconAnchor: [13, 13] });
let meMarker = null, accCircle = null;
// Лінії малюються парами: темна обводка знизу + яскрава лінія зверху.
// Так вони читаються і на супутнику, і на світлій схемі.
const CASE = { color: '#0a0d13', opacity: .5, interactive: false, lineCap: 'round', lineJoin: 'round' };
const trackCase = L.polyline([], Object.assign({}, CASE, { weight: 5 })).addTo(map);
const trackLine = L.polyline([], { color: '#ffb300', weight: 2.6, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(map);
// слід з історії - суцільна червона лінія з темною облямівкою, щоб було видно на будь-якій карті
const histCase  = L.polyline([], Object.assign({}, CASE, { weight: 8 })).addTo(map);
const histLine  = L.polyline([], { color: '#ff2a2a', weight: 4.5, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(map);
{ const set = histLine.setLatLngs.bind(histLine); histLine.setLatLngs = (ll) => { histCase.setLatLngs(ll); return set(ll); }; }
const routeCase = L.polyline([], Object.assign({}, CASE, { weight: 6 })).addTo(map);
const routeLine = L.polyline([], { color: '#00d4ff', weight: 3.2, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(map);
const guideCase = L.polyline([], Object.assign({}, CASE, { weight: 5 })).addTo(map);
const guideLine = L.polyline([], { color: '#22e06a', weight: 2.8, opacity: 1, dashArray: '10 8', interactive: false, lineCap: 'round' }).addTo(map);
const chevrons  = L.layerGroup().addTo(map);

const RMODE = {
  direct: { name: 'Пряма',      ico: '↗',  color: '#22e06a' },
  track:  { name: 'Моїм треком', ico: '👣', color: '#ffd60a' },
  route:  { name: 'Дорогами',    ico: '🛣️', color: '#00d4ff' },
};
const pointLayer = L.layerGroup().addTo(map);

function setFollow(v) { S.follow = v; $('#fabMe').classList.toggle('on', v); }

function renderPoints() {
  pointLayer.clearLayers();
  for (const p of S.points) {
    const tgt = p.id === S.targetId;
    const icon = L.divIcon({ className: '', html: `<div class="pin${tgt ? ' tgt' : ''}"><span>${esc(p.icon || '📍')}</span><div class="pin-label">${esc(p.name)}</div></div>`, iconSize: [34, 42], iconAnchor: [17, 40] });
    L.marker([p.lat, p.lon], { icon, zIndexOffset: tgt ? 1000 : 0 })
      .on('click', () => pointActions(p.id)).addTo(pointLayer);
  }
}
const target = () => S.points.find((p) => p.id === S.targetId) || null;

/* ---------- GPS ---------- */
function gpsBadge(state, text) {
  S.gpsState = state;                       // колір підхопить панель «GPS ±»
  const b = $('#gpsBadge');
  if (b) { b.className = 'gps ' + state; b.querySelector('span').textContent = text; }
}
/* Згладжування GPS (фільтр Калмана). Телефон дає точку з похибкою 3-10 м, і вона
   «гуляє» навіть коли стоїш. Фільтр зважує нову точку за її точністю: точна
   майже одразу приймається, розмита - лише трохи посуває позицію. Наскільки
   позиція може змінитись за секунду - залежить від швидкості, тож у машині
   фільтр не відстає, а пішки прибирає тремтіння. */
const KF = { lat: null, lon: null, v: 0, t: 0 };
function kalman(lat, lon, acc, t, speed) {
  acc = Math.max(acc || 10, 3);
  const sp = speed > 0 ? speed : 0;
  const q = S.settings.travel === 'car' ? Math.max(10, sp * 1.5) : Math.max(3, sp * 2);   // м/с
  const dt = (t - KF.t) / 1000;
  if (KF.lat == null || dt > 30 || dt < 0) { KF.lat = lat; KF.lon = lon; KF.v = acc * acc; KF.t = t; return [lat, lon]; }
  KF.v += dt * q * q;
  // стрибок далі, ніж фільтр вважає можливим утричі - це не шум, а справжній рух (тунель, перезапуск GPS)
  if (dist([KF.lat, KF.lon], [lat, lon]) > 3 * (Math.sqrt(KF.v) + acc) + 50) { KF.lat = lat; KF.lon = lon; KF.v = acc * acc; KF.t = t; return [lat, lon]; }
  const k = KF.v / (KF.v + acc * acc);
  KF.lat += k * (lat - KF.lat); KF.lon += k * (lon - KF.lon);
  KF.v = (1 - k) * KF.v; KF.t = t;
  return [KF.lat, KF.lon];
}
function onPos(p) {
  const c = p.coords, t = p.timestamp || Date.now();
  const [flat, flon] = kalman(c.latitude, c.longitude, c.accuracy, t, c.speed);
  S.pos = { lat: flat, lon: flon, raw: [c.latitude, c.longitude], acc: c.accuracy, alt: c.altitude, t, speed: c.speed, heading: c.heading };
  const ll = [flat, flon];
  const a = c.accuracy;
  gpsBadge(a <= 15 ? 'ok' : a <= 40 ? 'mid' : 'bad', '±' + Math.round(a) + ' м');

  // GPS курс як запасний варіант, якщо компаса немає
  if (c.heading != null && !isNaN(c.heading) && (c.speed || 0) > 0.7 && Date.now() - S.lastCompass > 3000) {
    S.heading = c.heading; S.headingSrc = 'gps';
  }

  if (!meMarker) {
    meMarker = L.marker(ll, { icon: meIcon, zIndexOffset: 2000, interactive: false }).addTo(map);
    accCircle = L.circle(ll, { radius: a, color: '#3d8bff', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
  } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(a); }

  if (S.firstFix) { S.firstFix = false; map.setView(ll, Math.max(map.getZoom(), 16)); }
  else if (S.follow) { if (S.navOpen && target()) navFrame(); else map.panTo(ll, { animate: true }); }

  if (S.pendingStart && a <= 50) { S.pendingStart = false; startTrack(); }
  autoRecord();
  recordPoint();
  stillCheck();
  updateAll();
}
let gpsWatch = null, gpsHelpShown = false;
function onPosErr(e) {
  if (e.code === 1) {
    S.gpsDenied = true; S.pendingStart = false; updateTrackBtn();
    gpsBadge('bad', 'Немає доступу');
    if (!gpsHelpShown) { gpsHelpShown = true; gpsHelp(); }
  } else gpsBadge('bad', e.code === 2 ? 'Увімкни GPS' : 'Шукаю…');
}
function startGps() {
  if (!('geolocation' in navigator)) { gpsBadge('bad', 'Немає GPS'); return; }
  if (!window.isSecureContext) { gpsBadge('bad', 'Потрібен HTTPS'); return; }
  if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch);
  S.gpsDenied = false; gpsBadge('', 'GPS…');
  gpsWatch = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}
// якщо дозвіл змінили в налаштуваннях — одразу підхопити
try {
  navigator.permissions.query({ name: 'geolocation' }).then((st) => {
    st.onchange = () => { if (st.state !== 'denied') { if (!$('#modal').classList.contains('hidden')) $('#mCancel').click(); startGps(); toast('📍 Доступ до GPS є', 'good'); } };
  });
} catch (e) { /* */ }
async function gpsHelp() {
  const again = await modal({
    title: '📍 Потрібен доступ до GPS',
    html: `<div class="note" style="font-size:13px;color:var(--text);line-height:1.5">
      <b>1. Увімкни місцезнаходження на телефоні</b><br>Шторка зверху → «Місцезнаходження» / «Геодані».<br><br>
      <b>2. Дозволь сайту</b><br>Chrome: торкнись значка <b>⚙︎/🔒</b> ліворуч від адреси → <b>Дозволи</b> → <b>Місцезнаходження</b> → <b>Дозволити</b>.<br><br>
      <b>3. Дозволь самому Chrome</b><br>Налаштування Android → Додатки → Chrome → Дозволи → Місцезнаходження → <b>«Під час використання»</b>, і увімкни <b>«Точне місцезнаходження»</b>.<br><br>
      iPhone: Параметри → Приватність → Служби геолокації → Safari → «Під час використання».</div>`,
    ok: 'Спробувати ще', cancel: 'Закрити', validate: () => true,
  });
  if (again) { startGps(); navigator.geolocation.getCurrentPosition(onPos, onPosErr, { enableHighAccuracy: true, timeout: 20000 }); }
}
{ const g = $('#pAcc') || $('#vAcc'); if (g) g.onclick = () => (S.gpsDenied || !S.pos ? gpsHelp() : null); }

/* ---------- compass ---------- */
let compassBound = false;
function onOrient(e) {
  let h = null;
  if (e.webkitCompassHeading != null && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
  else if ((e.absolute || e.type === 'deviceorientationabsolute') && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  h = (h + so + 360) % 360;
  // згладжування
  S.heading = S.headingSrc === 'compass' && S.heading != null ? (S.heading + angDiff(h, S.heading) * 0.3 + 360) % 360 : h;
  S.headingSrc = 'compass'; S.lastCompass = Date.now();
  updateHeadingUi();
}
function bindCompass() {
  if (compassBound) return;
  compassBound = true;
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient, true);
  else window.addEventListener('deviceorientation', onOrient, true);
}
async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { toast('Без дозволу компас не працює', 'warn'); return; }
    }
  } catch (e) { /* */ }
  bindCompass();
}
const needsCompassPermission = () => typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';

/* ---------- track ---------- */
/* Повороти. Звичайний крок (8/5/4 м пішки, 10 м в авто) на повороті зрізав би кут.
   Тож щойно напрям змінився на 10°+, пишемо густо: спершу кожен метр, далі
   поступово рідше - до 4 м, а потім знову звичайний крок. Новий поворот посеред
   цього починає густий запис заново. (В авто GPS дає точку раз на секунду,
   тож там «кожен метр» = кожна точка, яку дає телефон.) */
const TURN_STEPS = [1, 1, 2, 2, 3, 3, 4, 4];
const TURN_DEG = 10;
/** Напрям останньої ділянки сліду завдовжки щонайменше back метрів. */
function recentDir(pts, back) {
  const last = pts[pts.length - 1];
  for (let i = pts.length - 2; i >= 0; i--) if (dist(pts[i], last) >= back) return bearing(pts[i], last);
  return null;
}
/** Чи почався поворот. GPS тремтить, тож поворот, порахований по координатах,
 *  має підтвердитись двічі поспіль - інакше на прямій тремтіння давало б «повороти».
 *  Курс, який дає сам GPS у русі (машина, швидка хода), точніший - йому віримо одразу. */
function isTurn(tr, last, cur, d, p) {
  if (p.acc > 20) { tr.turnPend = 0; return false; }   // при поганому сигналі «поворот» - це шум
  const before = recentDir(tr.pts, 6);
  if (before == null) return false;
  const course = p.speed > 1 && p.heading != null && !isNaN(p.heading);
  const now = course ? p.heading : (d >= Math.max(2.5, p.acc * 0.5) ? bearing(last, cur) : null);
  if (now == null) return false;
  if (Math.abs(angDiff(now, before)) < TURN_DEG) { tr.turnPend = 0; return false; }
  if (course && p.speed > 3) return true;
  tr.turnPend = (tr.turnPend || 0) + 1;
  if (tr.turnPend < 2) return false;
  tr.turnPend = 0;
  return true;
}
function recordPoint() {
  const tr = S.track, p = S.pos;
  if (!tr || !p || p.acc > PROF().maxAcc) return;
  const cur = [+p.lat.toFixed(6), +p.lon.toFixed(6), p.t, Math.round(p.acc), p.alt != null ? Math.round(p.alt) : null];
  const last = tr.pts[tr.pts.length - 1];
  if (last) {
    const d = dist(last, cur), dt = (cur[2] - last[2]) / 1000;
    const inTurn = tr.turnI != null && tr.turnI < TURN_STEPS.length;
    const step = inTurn ? TURN_STEPS[tr.turnI] : Math.max(PROF().minStep, TRAV().minStep, p.acc * 0.4);
    const turn = d >= 1 && isTurn(tr, last, cur, d, p);
    if (d < step && !turn) return;
    // Стрибок GPS - це НЕМОЖЛИВА швидкість, а не просто швидка.
    // Межа 55 м/с ≈ 198 км/год: машина, потяг і велосипед проходять,
    // а телепорт на сотні метрів за секунду - ні.
    if (dt > 0 && d / dt > 55 && (S.jumps = (S.jumps || 0) + 1) < 3) return;
    S.jumps = 0;
    tr.dist += d;
    if (turn) tr.turnI = 0;                           // поворот - далі кожен метр
    else if (inTurn) tr.turnI++;                      // крок за кроком рідше: 1, 1, 2, 2, 3, 3, 4, 4 м
    tr.pts.push(cur);
    trackLine.addLatLng([cur[0], cur[1]]); trackCase.addLatLng([cur[0], cur[1]]);
    saveTrack();
    return;
  }
  tr.pts.push(cur);                                   // перша точка запису
  trackLine.addLatLng([cur[0], cur[1]]); trackCase.addLatLng([cur[0], cur[1]]);
  saveTrack();
}
function startTrack(silent) {
  if (S.gpsDenied) { if (!silent) gpsHelp(); return; }
  if (!S.pos) {
    if (silent) return;
    S.pendingStart = true; toast('Чекаю сигнал GPS…'); updateTrackBtn(); return;
  }
  if (!silent && !target() && S.settings.auto) {
    const pt = addPoint({ name: 'Машина', icon: '🚗', lat: S.pos.lat, lon: S.pos.lon }, true);
    toast(`🚗 Точку «${pt.name}» позначено`, 'good');
  }
  if (!silent) S.autoOff = false;
  S.stillAt = null;
  S.track = { id: 't' + Date.now(), start: Date.now(), pts: [], dist: 0, target: target() ? target().name : null,
              travel: S.settings.travel, profile: S.settings.profile };
  trackLine.setLatLngs([]); trackCase.setLatLngs([]);
  recordPoint(); saveTrack(true);
  wake(true); if (!silent) vibrate(40);
  updateTrackBtn(); updateAll();
}

/** Слід має писатись сам, інакше вертатись не буде по чому.
 *  Вмикається з першим надійним сигналом GPS. */
function autoRecord() {
  if (S.autoOff) return;                    // людина натиснула «Стоп» - не лізем
  if (!S.settings.autorec || S.track || S.pendingStart || S.gpsDenied) return;
  if (!S.pos || S.pos.acc > 50) return;
  startTrack(true);
}
async function stopTrack() {
  const ok = await confirmBox('Завершити запис?', `Пройдено ${fmtDist(S.track.dist)} за ${fmtDur(Date.now() - S.track.start)}. Трек збережеться в історії.`, 'Завершити');
  if (!ok || !S.track) return;              // поки питали, запис міг зупинитись сам
  finishTrack(Date.now(), false);
}
/** Зберегти активний запис в архів. end - коли рух насправді скінчився. */
function finishTrack(end, auto) {
  S.autoOff = true;                         // більше не починати самому
  const tr = S.track; tr.end = end;
  if (auto) tr.autoStop = true;
  if (S.pos && !auto) {   // останній крок - до самої точки зупинки
    const last = tr.pts[tr.pts.length - 1], cur = [+S.pos.lat.toFixed(6), +S.pos.lon.toFixed(6), Date.now(), Math.round(S.pos.acc), null];
    if (last && dist(last, cur) >= 3 && S.pos.acc <= PROF().maxAcc) { tr.dist += dist(last, cur); tr.pts.push(cur); }
  }
  if (tr.pts.length > 1) {
    S.tracks.unshift(tr);
    setTimeout(() => snapAndStore(tr), 1500);
    const dropped = trimTracks();
    LS.set('tracks', S.tracks);
    if (dropped) toast(`Історію підчищено: найстаріших треків прибрано ${dropped}`, 'warn');
  }
  S.track = null; saveTrack(true);
  trackLine.setLatLngs([]); trackCase.setLatLngs([]);
  if (!S.navOpen) wake(false);
  updateTrackBtn(); updateAll();
  updAskLater();
  if (auto) {
    vibrate([300, 150, 300]);
    toast(tr.pts.length > 1
      ? `⏹ Ти стоїш понад 10 хв — запис зупинено й збережено в архів: ${fmtDist(tr.dist)} за ${fmtDur(tr.end - tr.start)}`
      : '⏹ Ти стоїш понад 10 хв — запис зупинено (руху не було, зберігати нічого)', 'good');
  } else toast(S.settings.autorec ? 'Запис зупинено. Слід більше не пишеться — натисни «Старт»'
                                  : 'Трек збережено', 'good');
}

/* ---------- автозупинка ----------
   Стоїш на місці (у межах 25 м, або більше, якщо GPS неточний) понад 10 хвилин -
   запис зупиняється сам і йде в архів. Кінцем маршруту вважається мить, коли ти
   зупинився, тож ці 10 хвилин до часу маршруту не додаються. */
const STILL_MS = 10 * 60 * 1000, STILL_R = 25;
function stillCheck() {
  if (!S.track || !S.pos) { S.stillAt = null; return; }
  const now = Date.now(), here = [S.pos.lat, S.pos.lon];
  if (now - S.pos.t > 90 * 1000) return;              // позиція застаріла (екран спав) - чекаємо свіжу
  if (!S.stillAt || dist(S.stillAt, here) > Math.max(STILL_R, (S.pos.acc || 0) * 1.5)) {
    S.stillAt = here; S.stillSince = now; return;
  }
  if (now - S.stillSince >= STILL_MS) {
    const end = Math.max(S.track.start, S.stillSince);
    S.stillAt = null;
    if (!$('#modal').classList.contains('hidden') && $('#mTitle').textContent === 'Завершити запис?') $('#mCancel').click();
    finishTrack(end, true);
  }
}
setInterval(stillCheck, 30 * 1000);
function updateTrackBtn() {
  const b = $('#trackBtn'), on = !!S.track;
  b.classList.toggle('stop', on); b.classList.toggle('primary', !on);
  $('#trackIco').textContent = on ? '■' : S.pendingStart ? '…' : '▶';
  $('#trackTxt').textContent = on ? 'Стоп' : S.pendingStart ? 'Чекаю GPS' : 'Старт';
  $('#recBadge').classList.toggle('hidden', !on);
}

/* ---------- points ---------- */
function addPoint({ name, icon, lat, lon }, makeTarget) {
  const p = { id: 'p' + Date.now() + Math.floor(Math.random() * 1000), name: name || 'Точка', icon: icon || '📍', lat: +lat.toFixed(6), lon: +lon.toFixed(6), t: Date.now() };
  S.points.push(p);
  if (makeTarget || !S.targetId) S.targetId = p.id;
  savePoints(); renderPoints(); renderPointList(); updateAll();
  return p;
}
function setTarget(id) { S.targetId = id; S.arrived = false; savePoints(); renderPoints(); renderPointList(); updateAll(); }

const EMOJIS = ['🚗', '🍄', '🏠', '⛺', '🌲', '💧', '⭐', '📍', '⚠️', '🎣'];
/* Підпис до кожного значка. Обрав гриб - назва стає «Гриб», а не лишається «Машина». */
const EMOJI_NAME = {
  '🚗': 'Машина', '🍄': 'Гриб', '🏠': 'Дім', '⛺': 'Табір', '🌲': 'Ліс',
  '💧': 'Вода', '⭐': 'Цікаве', '📍': 'Точка', '⚠️': 'Небезпека', '🎣': 'Риболовля',
};
/** Вільна назва для значка: «Гриб», далі «Гриб 2», «Гриб 3»… */
function autoName(icon) {
  const base = EMOJI_NAME[icon] || 'Точка';
  const taken = new Set(S.points.map((p) => (p.name || '').trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 999; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  return base;
}
const isAutoName = (v) => {
  const t = (v || '').trim().toLowerCase();
  if (!t) return true;
  return Object.values(EMOJI_NAME).some((n) => t === n.toLowerCase() || new RegExp(`^${n.toLowerCase()} \\d+$`).test(t))
      || /^точка \d+$/.test(t);
};
function pointForm(p) {
  return `<input class="inp" id="fName" maxlength="40" placeholder="Назва" value="${esc(p.name || '')}">
    <div class="emojis" id="fEmo">${EMOJIS.map((e) => `<button type="button" data-e="${e}" class="${e === p.icon ? 'on' : ''}">${e}</button>`).join('')}</div>
    ${p.coordsInput ? '<input class="inp" id="fCoord" style="margin-top:10px" placeholder="49.839700, 24.029700" inputmode="text">' : ''}
    ${p.showTarget ? `<label class="chk"><input type="checkbox" class="sw" id="fTgt" ${p.tgt ? 'checked' : ''}> Повертатись сюди (ціль)</label>` : ''}`;
}
function bindEmoji(body) {
  const nameEl = body.querySelector('#fName');
  if (nameEl) nameEl.addEventListener('input', () => { nameEl.dataset.mine = '1'; });  // свою назву не чіпаємо
  body.querySelector('#fEmo').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    body.querySelectorAll('#fEmo button').forEach((x) => x.classList.toggle('on', x === b));
    if (nameEl && !nameEl.dataset.mine && isAutoName(nameEl.value)) nameEl.value = autoName(b.dataset.e);
  };
}
function readForm(body) {
  const on = body.querySelector('#fEmo button.on');
  return { name: body.querySelector('#fName').value.trim() || 'Точка', icon: on ? on.dataset.e : '📍', tgt: body.querySelector('#fTgt') ? body.querySelector('#fTgt').checked : false };
}
function parseCoords(s) {
  const m = String(s).replace(/[°]/g, ' ').match(/(-?\d{1,3}(?:[.,]\d+)?)[\s,;]+(-?\d{1,3}(?:[.,]\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1].replace(',', '.')), lon = parseFloat(m[2].replace(',', '.'));
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
async function newPointDialog(lat, lon, opts = {}) {
  const first = S.points.length === 0;
  const res = await modal({
    title: opts.coords ? 'Точка за координатами' : 'Нова точка',
    html: pointForm({ name: autoName(first ? '🚗' : '🍄'), icon: first ? '🚗' : '🍄', showTarget: true, tgt: first || !S.targetId, coordsInput: opts.coords }),
    onOpen: (b) => bindEmoji(b),
    validate: (b) => {
      const f = readForm(b);
      if (opts.coords) {
        const c = parseCoords(b.querySelector('#fCoord').value);
        if (!c) { toast('Не розпізнав координати. Приклад: 49.8397, 24.0297', 'warn'); return false; }
        f.lat = c.lat; f.lon = c.lon;
      }
      return f;
    },
  });
  if (!res) return;
  const p = addPoint({ name: res.name, icon: res.icon, lat: opts.coords ? res.lat : lat, lon: opts.coords ? res.lon : lon }, res.tgt);
  vibrate(30); toast(`${p.icon} «${p.name}» збережено`, 'good');
  if (opts.coords) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
}
function markHere() {
  if (S.gpsDenied) { gpsHelp(); return; }
  if (!S.pos) { toast('Ще немає сигналу GPS', 'warn'); return; }
  if (S.pos.acc > 50) toast(`Точність поки низька (±${Math.round(S.pos.acc)} м)`, 'warn');
  newPointDialog(S.pos.lat, S.pos.lon);
}
async function editPoint(id) {
  const p = S.points.find((x) => x.id === id); if (!p) return;
  const res = await modal({ title: 'Редагувати точку', html: pointForm({ name: p.name, icon: p.icon }), onOpen: bindEmoji, validate: readForm });
  if (!res) return;
  p.name = res.name; p.icon = res.icon; savePoints(); renderPoints(); renderPointList(); updateAll();
}
async function deletePoint(id) {
  const p = S.points.find((x) => x.id === id); if (!p) return;
  if (!(await confirmBox('Видалити точку?', `${esc(p.icon)} ${esc(p.name)}`, 'Видалити'))) return;
  S.points = S.points.filter((x) => x.id !== id);
  if (S.targetId === id) S.targetId = S.points.length ? S.points[S.points.length - 1].id : null;
  savePoints(); renderPoints(); renderPointList(); updateAll();
}
/* ---------- поділитись (Telegram, Viber, SMS…) ---------- */
const appLink = (lat, lon, name) => `${NATIVE ? WEB_URL : location.origin + location.pathname}?to=${lat.toFixed(6)},${lon.toFixed(6)}&n=${encodeURIComponent(name)}`;
function shareText(title, lat, lon, extra) {
  return `${title}${extra ? ' ' + extra : ''}\n${fmtCoord(lat, lon)}\n\n🗺 Google Maps: https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}\n🧭 Вести в WayBack: ${appLink(lat, lon, title.replace(/^\S+\s/, ''))}`;
}
/* Відкриває чат у месенджері з готовим текстом.
   Якщо застосунок не встановлений, браузер нічого не зробить -
   тому поруч лишаються «Копіювати» і системне «Надіслати». */
function sendToMessenger(kind, text, link) {
  const t = encodeURIComponent(text);
  const urls = {
    tg: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${t}`,
    wa: `https://wa.me/?text=${t}`,
    vb: `viber://forward?text=${t}`,
  };
  const u = urls[kind];
  if (!u) return;
  try { window.open(u, '_blank', 'noopener'); }
  catch (e) { location.href = u; }
}
function shareDialog(title, lat, lon, text) {
  const link = appLink(lat, lon, title.replace(/^\S+\s/, ''));
  modal({
    title, ok: 'Закрити', cancel: null,
    html: `<div class="qr-box"><canvas id="qrC"></canvas></div>
      <p class="note" style="text-align:center;margin:6px 0 0">Хай друг наведе камеру — точка стане в нього ціллю.<br>Працює без інтернету.</p>
      <div class="msg-row">
        <button class="btn msg tg" data-a="tg">Telegram</button>
        <button class="btn msg vb" data-a="vb">Viber</button>
        <button class="btn msg wa" data-a="wa">WhatsApp</button>
      </div>
      <div class="row-btns">
        <button class="btn primary" data-a="send">📤 Інший застосунок</button>
        <button class="btn" data-a="copy">📋 Копіювати</button>
        <button class="btn" data-a="scan">📷 Сканувати</button>
      </div>`,
    onOpen: (b) => {
      try { QR.draw(b.querySelector('#qrC'), link, { scale: 6, quiet: 3 }); }
      catch (e) { b.querySelector('.qr-box').innerHTML = '<p class="note">QR не вміщається</p>'; }
      b.onclick = (e) => {
        const a = e.target.closest('[data-a]'); if (!a) return;
        const act = a.dataset.a;
        if (act === 'send') { shareSend(title, text); return; }
        if (act === 'scan') { $('#mOk').click(); setTimeout(scanQr, 60); return; }
        if (act === 'copy') {
          navigator.clipboard.writeText(text)
            .then(() => toast('📋 Скопійовано — встав у будь-який чат', 'good'))
            .catch(() => toast('Браузер не дав скопіювати', 'warn'));
          return;
        }
        sendToMessenger(act, text, link);
      };
    },
  });
}

/* ---------- сканер QR (камера, офлайн) ---------- */
async function scanQr() {
  if (!('BarcodeDetector' in window)) {
    toast('Сканер тут недоступний — відкрий код камерою телефона', 'warn'); return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } }); }
  catch (e) { toast('Немає доступу до камери', 'warn'); return; }
  const ov = document.createElement('div');
  ov.className = 'scan';
  ov.innerHTML = '<video playsinline muted></video><div class="scan-frame"></div>'
    + '<div class="scan-hint">Наведи на QR-код</div><button class="btn" id="scanX">Скасувати</button>';
  document.body.appendChild(ov);
  const v = ov.querySelector('video');
  v.srcObject = stream; v.muted = true; v.playsInline = true;
  let stopped = false;
  const close = () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); ov.remove(); };
  ov.querySelector('#scanX').onclick = close;
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  const loop = async () => {
    if (stopped) return;
    try {
      const codes = await det.detect(v);
      if (codes && codes.length) { const val = codes[0].rawValue; close(); acceptScanned(val); return; }
    } catch (e) { /* кадр не розпізнано */ }
    setTimeout(loop, 150);
  };
  try { await v.play(); } catch (e) { /* */ }
  loop();
}
function acceptScanned(text) {
  let c = null, name = 'Точка від друга';
  try {
    const u = new URL(text, location.href);
    if (u.searchParams.get('to')) { c = parseCoords(u.searchParams.get('to')); name = u.searchParams.get('n') || name; }
    else if (u.searchParams.get('q')) c = parseCoords(u.searchParams.get('q'));
  } catch (e) { /* не URL */ }
  if (!c && /^geo:/i.test(text)) c = parseCoords(text.slice(4));
  if (!c) c = parseCoords(text);
  if (!c) { toast('Це не схоже на точку', 'warn'); return; }
  const p = addPoint({ name: name.slice(0, 40), icon: '👤', lat: c.lat, lon: c.lon }, true);
  setTarget(p.id); setFollow(false); S.firstFix = false;
  map.setView([p.lat, p.lon], 16);
  vibrate([60, 60, 60]);
  toast(`🎯 Прийнято: ${p.name} — тисни «Назад»`, 'good');
}

async function shareSend(title, text) {
  try {
    if (NATIVE) { WayBackNative.share(title, text); return; }
    if (navigator.share) { await navigator.share({ title, text }); return; }
    await navigator.clipboard.writeText(text); toast('Скопійовано — встав у месенджер', 'good');
  } catch (e) { /* скасовано */ }
}
async function sharePoint(id) {
  const p = S.points.find((x) => x.id === id); if (!p) return;
  shareDialog(`${p.icon} ${p.name}`, p.lat, p.lon, shareText(`${p.icon} ${p.name}`, p.lat, p.lon));
}
function shareHere() {
  if (S.gpsDenied) { gpsHelp(); return; }
  if (!S.pos) { toast('Ще немає сигналу GPS', 'warn'); return; }
  const when = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const txt = shareText('📍 Я тут', S.pos.lat, S.pos.lon, `(${when}, ±${Math.round(S.pos.acc)} м)`);
  shareDialog('📍 Я тут', S.pos.lat, S.pos.lon, txt);
}
// відкрили посилання від друга: ?to=lat,lon&n=Назва → точка-ціль
function handleIncomingLink() {
  const q = new URLSearchParams(location.search), to = q.get('to');
  if (!to) return;
  history.replaceState(null, '', location.pathname);
  const c = parseCoords(to); if (!c) return;
  const name = (q.get('n') || 'Точка від друга').slice(0, 40);
  let p = S.points.find((x) => Math.abs(x.lat - c.lat) < 1e-5 && Math.abs(x.lon - c.lon) < 1e-5);
  if (!p) p = addPoint({ name, icon: '👤', lat: c.lat, lon: c.lon }, true);
  setTarget(p.id); setFollow(false); S.firstFix = false;
  map.setView([p.lat, p.lon], 16);
  toast(`🎯 Ціль: ${p.name} — натисни «Назад», щоб іти`, 'good');
}
function pointActions(id) {
  const p = S.points.find((x) => x.id === id); if (!p) return;
  const d = S.pos ? fmtDist(dist([S.pos.lat, S.pos.lon], [p.lat, p.lon])) : '—';
  modal({
    title: `${p.icon} ${p.name}`,
    html: `<div class="kv"><span>Координати</span><b>${fmtCoord(p.lat, p.lon)}</b></div>
      <div class="kv" style="margin-top:4px"><span>Відстань</span><b>${d}</b></div>
      <div class="row-btns">
        <button class="btn primary" data-a="go">🧭 Вести сюди</button>
        <button class="btn" data-a="share">📤</button><button class="btn" data-a="edit">✏️</button><button class="btn danger" data-a="del">🗑️</button>
      </div>`,
    ok: 'Закрити', cancel: null,
    onOpen: (b) => b.onclick = (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      $('#modal').classList.add('hidden'); $('#mOk').onclick();
      setTimeout(() => {
        if (a.dataset.a === 'go') { setTarget(id); openNav(); }
        else if (a.dataset.a === 'share') sharePoint(id);
        else if (a.dataset.a === 'edit') editPoint(id);
        else if (a.dataset.a === 'del') deletePoint(id);
      }, 50);
    },
  });
}
map.on('contextmenu', (e) => newPointDialog(e.latlng.lat, e.latlng.lng));

function renderPointList() {
  const el = $('#pointList');
  if (!S.points.length) { el.innerHTML = '<div class="empty">Ще немає точок.<br>Натисни «Старт» біля машини — точка зʼявиться автоматично.</div>'; return; }
  const here = S.pos ? [S.pos.lat, S.pos.lon] : null;
  el.innerHTML = S.points.slice().reverse().map((p) => {
    const tgt = p.id === S.targetId;
    const d = here ? fmtDist(dist(here, [p.lat, p.lon])) + ' · ' : '';
    return `<div class="item${tgt ? ' tgt' : ''}" data-id="${p.id}">
      <span class="i-ico">${esc(p.icon)}</span>
      <div class="i-main" data-a="show"><b>${esc(p.name)}</b><small>${d}${fmtDate(p.t)}</small></div>
      <div class="i-acts">
        <button data-a="tgt" class="${tgt ? 'on' : ''}" title="Ціль">🎯</button>
        <button data-a="share" title="Поділитись">📤</button>
        <button data-a="edit" title="Редагувати">✏️</button>
        <button data-a="del" title="Видалити">🗑️</button>
      </div></div>`;
  }).join('');
}
$('#pointList').onclick = (e) => {
  const a = e.target.closest('[data-a]'), it = e.target.closest('[data-id]'); if (!a || !it) return;
  const id = it.dataset.id, p = S.points.find((x) => x.id === id);
  switch (a.dataset.a) {
    case 'tgt': setTarget(id); toast(`🎯 Ціль: ${p.name}`, 'good'); break;
    case 'share': sharePoint(id); break;
    case 'edit': editPoint(id); break;
    case 'del': deletePoint(id); break;
    case 'show': closeSheet(); setFollow(false); map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16)); break;
  }
};


/* ================= повернення: пряма / трек / дороги ================= */

/** Найближча точка ламаної до p. Повертає {i, t, pt, d} —
 *  i: індекс сегмента, t: 0..1 уздовж нього, pt: проєкція, d: відстань у метрах. */
function nearestOnPath(path, p) {
  let best = { i: 0, t: 0, pt: path[0], d: Infinity };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    // локальна плоска апроксимація, на масштабах прогулянки похибка нехтовна
    const kx = Math.cos(rad(p[0])), ax = a[1] * kx, bx = b[1] * kx, px = p[1] * kx;
    const vx = bx - ax, vy = b[0] - a[0], wx = px - ax, wy = p[0] - a[0];
    const len2 = vx * vx + vy * vy;
    let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const pt = [a[0] + vy * t, a[1] + (b[1] - a[1]) * t];
    const d = dist(p, pt);
    if (d < best.d) best = { i, t, pt, d };
  }
  return best;
}

/** Довжина ламаної від позиції (i,t) до кінця. */
function restLen(path, at) {
  let s = dist(at.pt, path[at.i + 1] || at.pt);
  for (let i = at.i + 1; i < path.length - 1; i++) s += dist(path[i], path[i + 1]);
  return s;
}

/** Точка на ламаній за `ahead` метрів попереду позиції (i,t) — щоб стрілка не смикалась. */
function pointAhead(path, at, ahead) {
  let left = ahead, cur = at.pt, i = at.i + 1;
  while (i < path.length) {
    const d = dist(cur, path[i]);
    if (d >= left) {
      const k = d ? left / d : 0;
      return [cur[0] + (path[i][0] - cur[0]) * k, cur[1] + (path[i][1] - cur[1]) * k];
    }
    left -= d; cur = path[i]; i++;
  }
  return path[path.length - 1];
}

/** Прорідити ламану: прибрати точки ближчі за `min` метрів. */
function thin(pts, min) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (dist(out[out.length - 1], pts[i]) >= min) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out;
}

/** Трек, яким можна вертатись: активний запис або найсвіжіший збережений,
 *  що починається біля цілі. */
function returnTrack() {
  const t = target();
  if (S.track && S.track.pts.length > 3) return S.track;
  if (!t) return null;
  for (const tr of S.tracks) {
    if (!tr.pts || tr.pts.length < 4) continue;
    if (dist([tr.pts[0][0], tr.pts[0][1]], [t.lat, t.lon]) < 250) return tr;
  }
  return null;
}

/** Побудувати шлях назад по пройденому треку. */
function buildTrackPath() {
  const tr = returnTrack(), t = target();
  if (!tr || !S.pos) return null;
  const pts = tr.pts.map((p) => [p[0], p[1]]);
  const here = [S.pos.lat, S.pos.lon];
  const at = nearestOnPath(pts, here);
  // від точки виходу на трек -> назад по треку до його початку.
  // Саме мене в шлях не включаємо: відрізок "я -> трек" малюється
  // окремим поводком, і тоді видно, що я осторонь сліду.
  const back = pts.slice(0, at.i + 1).reverse();
  let path = [at.pt, ...back];
  if (t) path.push([t.lat, t.lon]);
  path = thin(path, 4);
  return path.length > 1 ? path : null;
}

/* ---- маршрут дорогами ---- */
/* Пішки й на авто маршрутизатор рахує по-різному: пішохідний профіль
   веде тротуарами й стежками, де машиною не проїхати.
   Двигунів два, і вони різні: якщо OSRM не відповів або його сервер зайнятий,
   питаємо Valhalla. Прямої замість дороги не малюємо - краще без лінії,
   ніж лінія крізь будинки. */
const TRAVEL = {
  foot: { name: 'Пішки', ico: '🚶', costing: 'pedestrian', minStep: 0,
          osrm: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
          info: 'Маршрут дорогами веде вулицями, тротуарами й стежками.' },
  car:  { name: 'Авто',  ico: '🚗', costing: 'auto', minStep: 10,
          osrm: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
          info: 'Маршрут дорогами враховує проїзд і напрямок руху. На поворотах слід пишеться густіше.' },
};
const TRAV = () => TRAVEL[S.settings.travel] || TRAVEL.foot;
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const TIE = 60;                 // наскільки близько дорога, щоб дотягнути до неї лінію, м
let routeAbort = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url, ms) {
  const ctl = new AbortController();
  routeAbort = ctl;
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal }); }
  finally { clearTimeout(timer); if (routeAbort === ctl) routeAbort = null; }
}
/** Зайнятий чи зламаний сервер - має сенс спробувати ще раз. */
const busyErr = (status) => Object.assign(new Error('busy ' + status), { busy: true });

/** Valhalla віддає геометрію як encoded polyline з точністю 1e-6. */
function decodePoly6(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    let res = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (res & 1) ? ~(res >> 1) : (res >> 1);
    res = 0; shift = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += (res & 1) ? ~(res >> 1) : (res >> 1);
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}

async function askOsrm(from, to) {
  const u = `${TRAV().osrm}${from[1].toFixed(6)},${from[0].toFixed(6)};${to[1].toFixed(6)},${to[0].toFixed(6)}`
    + '?overview=full&geometries=geojson&alternatives=false&steps=false&generate_hints=false';
  const r = await httpGet(u, 12000);
  if (r.status === 429 || r.status >= 500) throw busyErr(r.status);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.code && j.code !== 'Ok') throw new Error(j.code);
  const rt = j.routes && j.routes[0];
  const c = rt && rt.geometry && rt.geometry.coordinates;
  if (!c || c.length < 2) throw new Error('empty');
  return { path: c.map((p) => [p[1], p[0]]), len: rt.distance,
           snap: (j.waypoints || []).map((w) => w.distance || 0), via: 'OSRM' };
}

async function askValhalla(from, to) {
  const body = {
    locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }],
    costing: TRAV().costing, directions_type: 'none',
    directions_options: { units: 'kilometers' },
  };
  const r = await httpGet(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`, 12000);
  if (r.status === 429 || r.status >= 500) throw busyErr(r.status);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const tr = j.trip;
  if (!tr || !tr.legs || !tr.legs.length) throw new Error('empty');
  let path = [];
  tr.legs.forEach((lg) => { if (lg.shape) path = path.concat(decodePoly6(lg.shape)); });
  if (path.length < 2) throw new Error('empty');
  const km = tr.summary && tr.summary.length;
  return { path, len: km != null ? km * 1000 : null, snap: [], via: 'Valhalla' };
}

/* ---- прив'язка записаного сліду до доріг ----
   GPS телефона гуляє на кілька метрів, тож слід іде поруч із дорогою, а не по ній.
   Для прогулянок містом і поїздок авто просимо сервер «прикласти» слід до доріг
   (map matching). У лісі й горах - ні: стежок там часто немає на карті, і сервер
   потягнув би слід на найближчу дорогу. Результат перевіряємо: якщо він помітно
   довший чи коротший за слід або відходить від нього - лишаємо записаний слід.
   Прив'язаний слід зберігається в історії, тож далі працює й без інтернету. */
function encodePoly6(pts) {
  let out = '', plat = 0, plon = 0;
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of pts) {
    const ilat = Math.round(la * 1e6), ilon = Math.round(lo * 1e6);
    out += enc(ilat - plat) + enc(ilon - plon); plat = ilat; plon = ilon;
  }
  return out;
}
const pathLen = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]); return l; };
async function snapGet(url, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(timer); }
}
const snapAllowed = (tr) => (tr.travel || S.settings.travel) === 'car' || (tr.profile || S.settings.profile) === 'city';
async function matchValhalla(pts, car) {
  const body = { encoded_polyline: encodePoly6(pts), costing: car ? 'auto' : 'pedestrian',
                 shape_match: 'map_snap', directions_type: 'none', trace_options: { search_radius: 30 } };
  const r = await snapGet(`${VALHALLA.replace(/\/route$/, '/trace_route')}?json=${encodeURIComponent(JSON.stringify(body))}`, 15000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  let out = [];
  ((j.trip && j.trip.legs) || []).forEach((lg) => { if (lg.shape) out = out.concat(decodePoly6(lg.shape)); });
  if (out.length < 2) throw new Error('empty');
  return out;
}
async function matchOsrm(pts, car) {
  const base = (car ? TRAVEL.car : TRAVEL.foot).osrm.replace('/route/', '/match/');
  const u = base + pts.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';')
    + '?overview=full&geometries=geojson&gaps=ignore&tidy=true&radiuses=' + pts.map(() => 30).join(';');
  const r = await snapGet(u, 15000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.code && j.code !== 'Ok') throw new Error(j.code);
  let out = [];
  (j.matchings || []).forEach((m) => { if (m.geometry && m.geometry.coordinates) out = out.concat(m.geometry.coordinates.map((c) => [c[1], c[0]])); });
  if (out.length < 2) throw new Error('empty');
  return out;
}
/** Чи прив'язаний шматок справді той самий шлях, а не обʼїзд кварталом. */
function matchSane(raw, m) {
  const lr = pathLen(raw), lm = pathLen(m);
  if (lr > 30 && (lm < lr * 0.8 || lm > lr * 1.35 + 40)) return false;
  let far = 0;
  for (const p of raw) if (nearestOnPath(m, p).d > 30) far++;
  return far <= raw.length * 0.15;
}
/** Прив'язати трек. Повертає ламану або null, якщо не вийшло чи не треба. */
async function snapTrack(tr) {
  if (!tr || !tr.pts || tr.pts.length < 3 || !snapAllowed(tr) || !navigator.onLine) return null;
  const car = (tr.travel || S.settings.travel) === 'car';
  const pts = thin(tr.pts.map((p) => [p[0], p[1]]), car ? 8 : 5);
  if (pts.length < 2) return null;
  const CH = 90, out = [];
  let snapped = 0;
  for (let i = 0; i < pts.length - 1; i += CH - 1) {
    const chunk = pts.slice(i, i + CH);
    let m = null;
    for (const ask of [matchValhalla, matchOsrm]) {
      try { const r = await ask(chunk, car); if (matchSane(chunk, r)) { m = r; break; } } catch (e) { /* наступний сервер */ }
    }
    if (m) snapped++;
    const part = m || chunk;
    out.push(...(out.length ? part.slice(1) : part));
  }
  if (!snapped) return null;
  return out.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]);
}
/** Прив'язати й запамʼятати в історії. Тихо: без інтернету - просто лишається як є. */
let snapBusy = null;
async function snapAndStore(tr) {
  if (!tr || tr.snap || !snapAllowed(tr) || !navigator.onLine) return false;
  if (tr.snapTried && Date.now() - tr.snapTried < 10 * 60 * 1000) return false;   // не смикати сервер щоразу
  if (snapBusy === tr.id) return false;
  snapBusy = tr.id;
  let res = null;
  try { res = await snapTrack(tr); } finally { snapBusy = null; }
  tr.snapTried = Date.now();
  if (res) tr.snap = res;
  const i = S.tracks.findIndex((x) => x.id === tr.id);
  if (i >= 0) { S.tracks[i] = tr; LS.set('tracks', S.tracks); }
  return !!res;
}

/** Дорога не буває коротшою за пряму. Коротша - значить це не дорога. */
function routeSane(res, from, to) {
  if (!res.path || res.path.length < 2) return false;
  const straight = dist(from, to);
  if (res.len != null && straight > 40 && res.len < straight * 0.85) return false;
  return true;
}

/** Питаємо двигуни по черзі; зайнятий сервер пробуємо вдруге. */
async function fetchRoute(from, to) {
  if (routeAbort) { routeAbort.abort(); routeAbort = null; }
  let last = null;
  for (const ask of [askOsrm, askValhalla]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ask(from, to);
        if (!routeSane(res, from, to)) throw new Error('не схоже на дорогу');
        return res;
      } catch (e) {
        last = e;
        if (e && e.name === 'AbortError') throw e;        // перебив новий запит
        if (e && e.busy && attempt === 0) { await sleep(900); continue; }
        break;
      }
    }
  }
  throw last || new Error('немає дороги');
}

/** Дотягуємо лінію від мене до дороги і від дороги до точки, якщо то кілька
 *  метрів (двір, під'їзд). Далеко - лишаємо як є: домалювати означало б
 *  провести ту саму пряму через будинки, якої ми й позбуваємось. */
function stitch(path, from, to) {
  const p = path.slice();
  if (dist(from, p[0]) <= TIE) p.unshift(from.slice());
  if (dist(to, p[p.length - 1]) <= TIE) p.push(to.slice());
  return p;
}

async function requestRoute(force) {
  const t = target();
  if (!t || !S.pos || !S.navOpen) return;      // поки не натиснуто «Назад» - нічого не рахуємо
  const here = [S.pos.lat, S.pos.lon];
  const now = Date.now();
  if (!force) {
    if (S.rBusy || now - S.rLastReq < 20000) return;
    if (S.rpathFrom && dist(here, S.rpathFrom) < 75) return;
  }
  if (!navigator.onLine) {
    S.rErr = 'офлайн'; applyFallback('Немає інтернету — маршрут дорогами недоступний');
    return;
  }
  S.rBusy = true; S.rErr = null; S.rLastReq = now; renderNav();
  try {
    const res = await fetchRoute(here, [t.lat, t.lon]);
    S.rpath = stitch(res.path, here, [t.lat, t.lon]);
    S.rsrc = 'route'; S.rpathLen = res.len; S.rpathFrom = here;
    S.rErr = null; S.noLine = false; S.rVia = res.via;
    S.rSnap = res.snap && res.snap.length ? Math.max.apply(null, res.snap) : 0;
    drawReturn();
  } catch (e) {
    if (e && e.name === 'AbortError') { S.rErr = 'перервано'; return; }
    S.rErr = 'немає дороги';
    applyFallback('Не вийшло прокласти дорогами');
  } finally { S.rBusy = false; updateAll(); }
}

/** Чи доречна пряма замість дороги. У місті - ні: вона йде крізь будинки.
 *  У лісі й горах прямої нічим замінити, там вона й потрібна. */
function straightOk() {
  return S.settings.rmode === 'direct' || S.settings.profile !== 'city';
}

/** Обраний спосіб не вдався. Трек - справжня пройдена геометрія, його можна.
 *  Прямої в місті не підставляємо: краще стрілка й відстань, ніж лінія крізь двори. */
function applyFallback(msg) {
  const p = buildTrackPath();
  S.rpathLen = null; S.rVia = null; S.rSnap = 0;
  if (p) { S.rpath = p; S.rsrc = 'track'; S.noLine = false; toast(msg + ' — веду твоїм треком', 'warn'); }
  else {
    S.rpath = null; S.rsrc = null; S.noLine = !straightOk();
    toast(S.noLine ? msg + ' — показую напрям і відстань, без лінії' : msg + ' — веду по прямій', 'warn');
  }
  drawReturn();
}

/* ---- малювання ---- */
/* Лінія - це вже ведення, а не позначка. Поки не натиснуто «Назад»,
   на карті лишаються тільки точка і слід. */
function drawReturn() {
  const col = S.rsrc ? RMODE[S.rsrc].color : null;
  if (S.navOpen && S.rpath && S.rpath.length > 1) {
    routeCase.setLatLngs(S.rpath); routeLine.setLatLngs(S.rpath).setStyle({ color: col });
    guideLine.setLatLngs([]); guideCase.setLatLngs([]);
  } else {
    routeCase.setLatLngs([]); routeLine.setLatLngs([]);
    if (!S.navOpen) { guideLine.setLatLngs([]); guideCase.setLatLngs([]); }
  }
  drawChevrons();
  if (S.navOpen && S.follow) navFrame();       // зʼявився або змінився шлях - підлаштувати кадр
}

function drawChevrons() {
  chevrons.clearLayers();
  const p = S.rpath;
  if (!S.navOpen || !p || p.length < 2 || !map) return;
  const step = Math.max(70, (S.rpathLen || 1000) / 26);
  let acc = step, placed = 0;
  for (let i = 0; i < p.length - 1 && placed < 60; i++) {
    let seg = dist(p[i], p[i + 1]);
    if (!seg) continue;
    const br = bearing(p[i], p[i + 1]);
    while (acc <= seg && placed < 60) {
      const k = acc / seg;
      const ll = [p[i][0] + (p[i + 1][0] - p[i][0]) * k, p[i][1] + (p[i + 1][1] - p[i][1]) * k];
      chevrons.addLayer(L.marker(ll, {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'chev', iconSize: [12, 12], iconAnchor: [6, 6],
          html: `<i style="transform:rotate(${br}deg)"></i>` }),
      }));
      acc += step; placed++;
    }
    acc -= seg;
  }
}

/* ---- перемикання режиму ---- */
function setReturnMode(m, silent) {
  if (m === 'direct' && S.settings.profile === 'mount' && !silent)
    toast('⛰️ У горах пряма може вести через урвище — надійніше трек', 'warn');
  S.settings.rmode = m;
  if (!S.settings.rmodeBy) S.settings.rmodeBy = {};
  S.settings.rmodeBy[S.settings.profile] = m;   // у кожного профілю свій спосіб
  saveSettings();
  syncModeSeg();
  S.rpath = null; S.rsrc = null; S.rpathLen = null; S.rpathFrom = null; S.rErr = null;
  S.noLine = false; S.rVia = null; S.rSnap = 0;
  routeCase.setLatLngs([]); routeLine.setLatLngs([]); chevrons.clearLayers();
  if (m === 'track') {
    const p = buildTrackPath();
    if (p) { S.rpath = p; S.rsrc = 'track'; S.rpathLen = null; if (!silent) toast('👣 Веду твоїм треком', 'good'); }
    else if (!silent) toast(S.track ? 'Слід ще короткий — поки веду прямою' : 'Немає записаного сліду — поки веду прямою', 'warn');
  } else if (m === 'route' && S.navOpen) {
    requestRoute(true);
    if (!silent) toast('🛣️ Шукаю шлях дорогами…');
  }
  drawReturn(); updateAll();
}

/** Перебудова шляху на ходу. Викликається з updateAll, лише під час ведення. */
function refreshReturn() {
  const m = S.settings.rmode;
  if (m === 'direct' || !S.navOpen || !S.pos || !target()) return;
  if (m === 'track') {
    const p = buildTrackPath();
    if (p) { S.rpath = p; S.rsrc = 'track'; drawReturn(); }
    return;
  }
  if (m === 'route') {
    if (!S.rpath) { requestRoute(false); return; }
    const at = nearestOnPath(S.rpath, [S.pos.lat, S.pos.lon]);
    if (at.d > 60) requestRoute(false);   // збився з маршруту - перерахувати
  }
}


/* ---------- спосіб пересування ---------- */
function syncTravSeg() {
  document.querySelectorAll('#travSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.t === S.settings.travel));
  const el = $('#travInfo');
  if (el) el.textContent = TRAV().info;
}
function setTravel(id, silent) {
  if (!TRAVEL[id] || id === S.settings.travel) { syncTravSeg(); return; }
  S.settings.travel = id; saveSettings();
  syncTravSeg();
  if (S.settings.rmode === 'route') {      // маршрут рахувався іншим профілем - перебудувати
    S.rpath = null; S.rsrc = null; S.rpathLen = null; S.rpathFrom = null;
    requestRoute(true);
  }
  updateAll();
  if (!silent) toast(`${TRAV().ico} ${TRAV().name} — ${TRAV().info}`, 'good');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#travSeg button');
  if (b) setTravel(b.dataset.t);
});

/* ---------- профіль середовища ---------- */
function syncProfSeg() {
  document.querySelectorAll('#profSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.p === S.settings.profile));
  const el = $('#profInfo');
  if (el) el.textContent = PROF().info;
}
function setProfile(id, silent) {
  if (!PROFILES[id]) return;
  const p = PROFILES[id];
  S.settings.profile = id;
  S.settings.layer = p.layer;
  saveSettings();
  setLayer(p.layer);
  if (typeof renderMapTab === 'function' && $('#layerSeg')) renderMapTab();
  const want = (S.settings.rmodeBy || {})[id] || p.rmode || 'track';
  if (want !== S.settings.rmode) setReturnMode(want, true);
  syncProfSeg();
  if (!silent) toast(`${p.ico} ${p.name} — ${p.info}`, "good");
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#profSeg button');
  if (b) setProfile(b.dataset.p);
});

/* ---------- navigation / stats ---------- */
function updateAll() {
  const t = target(), here = S.pos ? [S.pos.lat, S.pos.lon] : null;
  let d = null, b = null;
  $('#pTargetName').textContent = t ? `${t.icon} ${t.name}` : 'До точки';
  const straight = (t && here) ? dist(here, [t.lat, t.lon]) : null;

  if (t && here) refreshReturn();

  const noGuide = () => { guideLine.setLatLngs([]); guideCase.setLatLngs([]); };
  const usePath = S.navOpen && t && here && S.settings.rmode !== 'direct' && S.rpath && S.rpath.length > 1;
  if (usePath) {
    const at = nearestOnPath(S.rpath, here);
    S.rpathAt = at.i; S.rOff = at.d > 50;
    d = at.d + restLen(S.rpath, at);
    b = bearing(here, pointAhead(S.rpath, at, 30));
    // короткий поводок від мене до маршруту, якщо я осторонь від нього
    if (at.d > 20) { guideLine.setLatLngs([here, at.pt]); guideCase.setLatLngs([here, at.pt]); }
    else noGuide();
  } else if (t && here) {
    d = straight; b = bearing(here, [t.lat, t.lon]);
    S.rOff = false;
    // пряму лінію малюємо лише під час ведення і лише там, де вона доречна:
    // просто позначена точка лінії не потребує, а в місті пряма йде крізь будинки
    if (S.navOpen && straightOk()) {
      guideLine.setLatLngs([here, [t.lat, t.lon]]);
      guideCase.setLatLngs([here, [t.lat, t.lon]]);
    } else noGuide();
  } else noGuide();
  S.navDist = d; S.navBearing = b; S.navStraight = straight;
  $('#vDist').textContent = t ? fmtDist(d) : 'немає';
  if (S.settings.profile === 'mount' && S.pos && S.pos.alt != null) {
    // похибка GPS і так видно у значку вгорі, тож у горах тут корисніша висота;
    // якщо пристрій висоти не дає - панель лишається з похибкою, а не порожня
    $('#accTitle').textContent = 'Висота';
    $('#vAcc').textContent = Math.round(S.pos.alt) + ' м';
    $('#vAcc').className = 'p-val c-blue';
  } else {
    $('#accTitle').textContent = 'GPS ±';
    $('#vAcc').textContent = S.pos ? Math.round(S.pos.acc) + ' м' : '—';
    $('#vAcc').className = 'p-val ' + ({ ok: 'c-green', mid: 'c-yellow', bad: 'c-red' }[S.gpsState] || '');
    $('#vAcc').className = 'p-val ' + (!S.pos ? '' : S.pos.acc <= 15 ? 'c-green' : S.pos.acc <= 40 ? 'c-yellow' : 'c-red');
  }
  updateTimer();

  // прибуття - завжди по прямій до цілі, незалежно від режиму
  if (straight != null) {
    const near = straight <= Math.max(PROF().arrive, (S.pos.acc || 0) * 0.8);
    if (near && !S.arrived) { S.arrived = true; vibrate([200, 100, 200]); if (S.navOpen) toast('🎉 Ти на місці!', 'good'); }
    else if (!near && straight > 40) S.arrived = false;
  }
  if (S.navOpen) renderNav();
  updateHeadingUi();
}
function updateTimer() {
  if (S.track) {
    $('#vWalk').textContent = fmtDist(S.track.dist);
    $('#vTime').textContent = fmtDur(Date.now() - S.track.start);
  } else { $('#vWalk').textContent = '—'; $('#vTime').textContent = '—'; }
  { const h = $('#vHist'); if (h) h.textContent = S.tracks.length || '—'; }
}
setInterval(updateTimer, 1000);

function headingFresh() {
  if (S.heading == null) return false;
  return S.headingSrc === 'compass' ? Date.now() - S.lastCompass < 3000 : true;
}
function updateHeadingUi() {
  const hasH = headingFresh();
  const dir = document.getElementById('meDir');
  if (dir) { dir.classList.toggle('on', hasH); if (hasH) dir.style.transform = `rotate(${S.heading}deg)`; }
  const ma = $('#miniArrow');
  if (S.navBearing != null) {
    const rel = hasH ? S.navBearing - S.heading : S.navBearing;
    ma.classList.remove('off'); ma.style.transform = `rotate(${rel - 90}deg)`;
  } else ma.classList.add('off');
  if (S.navOpen) renderCompass();
  renderMapCompass();
}

/* Компас на карті: стрілка завжди показує на північ, підпис - куди дивиться телефон.
   Карта сама орієнтована північчю вгору, тож компас допомагає звірити її з місцевістю. */
let mcRot = 0;
function renderMapCompass() {
  const el = $('#mapCmp'); if (!el) return;
  const hasH = headingFresh();
  el.classList.toggle('off', !hasH);
  if (hasH) {
    mcRot = smoothRot(mcRot, -S.heading);
    $('#mcRose').setAttribute('transform', `rotate(${mcRot.toFixed(1)})`);
    $('#mcDeg').textContent = `${Math.round(S.heading) % 360}° ${dirName(S.heading)}`;
  } else {
    $('#mcDeg').textContent = needsCompassPermission() && !compassBound ? 'увімкнути' : 'немає';
  }
}
$('#mapCmp').onclick = async () => {
  if (needsCompassPermission() && !compassBound) { await enableCompass(); renderMapCompass(); return; }
  bindCompass();
  if (headingFresh()) {
    const src = S.headingSrc === 'compass' ? 'за компасом' : 'за рухом GPS';
    toast(`🧭 Телефон дивиться на ${dirName(S.heading)} (${Math.round(S.heading) % 360}°), ${src}. Червоний кінець — північ.`);
  } else {
    toast('Компас не відповідає. Поклади телефон рівно або почни йти — напрям візьмемо з GPS.', 'warn');
  }
};

let roseRot = 0, arrowRot = 0; // накопичувальні кути для плавного повороту без стрибків через 360°
function smoothRot(prev, next) { return prev + angDiff(next, ((prev % 360) + 360) % 360); }
function renderCompass() {
  const hasH = headingFresh(), b = S.navBearing;
  const h = hasH ? S.heading : 0;
  roseRot = smoothRot(roseRot, -h);
  $('#rose').setAttribute('transform', `rotate(${roseRot})`);
  const arrow = $('#arrow');
  if (b == null) { arrow.style.opacity = .15; return; }
  arrow.style.opacity = 1;
  arrowRot = smoothRot(arrowRot, b - h);
  arrow.setAttribute('transform', `rotate(${arrowRot})`);
}
function renderNav() {
  const t = target();
  $('#navName').textContent = t ? `${t.icon} ${t.name}` : 'Ціль не обрано';
  const dEl = $('#navDist'), hint = $('#navHint');
  if (!t) { dEl.textContent = '—'; $('#navSub').textContent = 'Познач точку або обери ціль у меню'; hint.textContent = ''; return; }
  if (S.navDist == null) { dEl.textContent = '…'; $('#navSub').textContent = 'Чекаю сигнал GPS'; hint.textContent = ''; return; }
  if (S.arrived) { dEl.textContent = 'Ти на місці 🎉'; dEl.classList.add('arrived'); }
  else { dEl.textContent = fmtDist(S.navDist); dEl.classList.remove('arrived'); }
  const hasH = headingFresh();
  const m = S.settings.rmode, rm = RMODE[m];
  let sub = `азимут ${Math.round(S.navBearing)}° · ${dirName(S.navBearing)}`;
  if (m !== 'direct') {
    if (S.rBusy) sub += ' · шукаю маршрут…';
    else if (S.rpath) sub += ` · ${rm.name.toLowerCase()}, навпростець ${fmtDist(S.navStraight)}`;
    else if (S.noLine) sub += ' · дороги не знайшлось, лінії не малюю';
    else sub += ' · маршрут не побудовано, веду по прямій';
  }
  $('#navSub').textContent = sub;
  const info = $('#rmodeInfo');
  if (info) {
    if (m === 'direct') info.textContent = 'Пряма — найкоротший напрям, без урахування доріг і перешкод.';
    else if (S.rBusy) info.textContent = 'Будую маршрут…';
    else if (S.rOff) info.innerHTML = '<b style="color:var(--orange)">Ти осторонь маршруту</b> — зеленим показано, як до нього вийти.';
    else if (S.rpath && S.rsrc === 'route') {
      let s = S.settings.travel === 'car' ? 'Веду дорогами для авто' : 'Веду вулицями й тротуарами';
      if (S.rVia) s += ` · ${S.rVia}`;
      if (S.rSnap > 120) s += `. Найближча дорога за ${Math.round(S.rSnap)} м — до неї йди за стрілкою.`;
      else s += '.';
      info.textContent = s;
    } else if (S.rpath) info.textContent = 'Веду назад твоїм же слідом.';
    else if (S.noLine) info.innerHTML = '<b style="color:var(--orange)">Дороги не знайшлось</b> — лінію не малюю, щоб не вести крізь будинки. Іди за стрілкою й відстанню, або обери «Пряма».';
    else info.textContent = m === 'track' ? 'Немає записаного треку — веду по прямій.' : 'Маршрут недоступний — веду по прямій.';
  }
  if (hasH) {
    hint.innerHTML = S.headingSrc === 'compass' ? 'Тримай телефон горизонтально. Іди за зеленою стрілкою.' : 'Напрям за рухом GPS — іди рівно, стрілка уточниться.';
  } else if (needsCompassPermission() && !compassBound) {
    hint.innerHTML = 'Компас вимкнено.<br><button class="btn primary" id="cmpBtn">Увімкнути компас</button>';
    $('#cmpBtn').onclick = () => enableCompass();
  } else {
    hint.innerHTML = 'Компас недоступний: стрілка показує напрям відносно <b style="color:var(--red)">N</b> (півночі). Почни йти — напрям візьмемо з GPS.';
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#rmodeSeg button');
  if (b) setReturnMode(b.dataset.m);
});
function syncModeSeg() {
  document.querySelectorAll('#rmodeSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.m === S.settings.rmode));
}
syncModeSeg();
syncProfSeg(); syncTravSeg();

function buildTicks() {
  let s = '';
  for (let a = 0; a < 360; a += 15) {
    const major = a % 90 === 0, r1 = major ? 78 : 83;
    const x1 = Math.sin(rad(a)) * r1, y1 = -Math.cos(rad(a)) * r1, x2 = Math.sin(rad(a)) * 90, y2 = -Math.cos(rad(a)) * 90;
    s += `<line class="tick${major ? ' major' : ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  $('#ticks').innerHTML = s;
}
buildTicks();


/* ---------- кадр під час повернення ----------
   Поки ведемо до точки, карта сама тримає в кадрі тебе і ціль: ідеш - кадр іде слідом,
   підходиш - карта наближається, до останніх метрів - найдрібніший масштаб.
   Якщо ціль далеко (у лісі буває кілометри), у кадрі ти і найближчі ~800 м шляху,
   щоб видно було повороти, а не весь район дрібними цятками.
   Масштаб змінюється спокійно: віддалити - одразу (щоб нічого не вилізло за край),
   наблизити - лише коли це потрібно двічі поспіль. Потягнув карту пальцем -
   кадр відпускає; кнопка ◎ повертає його. */
const FRAME_FAR = 1500, FRAME_AHEAD = 800;
let frameAt = 0, frameZoomIn = 0;
function navFramePts() {
  const t = target(), here = [S.pos.lat, S.pos.lon], tgt = [t.lat, t.lon];
  const pts = [here];
  const far = dist(here, tgt) > FRAME_FAR;
  if (!far) pts.push(tgt);
  if (S.rpath && S.rpath.length > 1 && S.settings.rmode !== 'direct') {
    const at = nearestOnPath(S.rpath, here);
    let acc = 0, prev = at.pt;
    pts.push(at.pt);
    for (let i = at.i + 1; i < S.rpath.length; i++) {
      acc += dist(prev, S.rpath[i]); prev = S.rpath[i]; pts.push(S.rpath[i]);
      if (acc > (far ? FRAME_AHEAD : Infinity)) break;
    }
  } else if (far) {
    pts.push(pointAt(here, bearing(here, tgt), FRAME_AHEAD));      // точка по напряму на ціль
  }
  return { pts, keep: far ? [here] : [here, tgt] };
}
function pointAt(from, brg, m) {
  const d = m / R, b = rad(brg), la = rad(from[0]), lo = rad(from[1]);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [deg(la2), deg(lo2)];
}
function framePadding() {
  const navH = S.navOpen ? ($('#nav').offsetHeight || 0) : 0;
  return { paddingTopLeft: L.point(72, 20), paddingBottomRight: L.point(52, navH + 20) };
}
function navFrame(force) {
  if (!S.navOpen || !S.follow || !S.pos || !target()) return;
  const now = Date.now();
  if (!force && now - frameAt < 1500) return;
  frameAt = now;
  const { pts, keep } = navFramePts();
  const pad = framePadding();
  const near = dist([S.pos.lat, S.pos.lon], [target().lat, target().lon]) < 60;
  const opts = Object.assign({ maxZoom: near ? 19 : 18 }, pad);
  const b = L.latLngBounds(pts);
  let want;
  try { want = map._getBoundsCenterZoom(b, opts); } catch (e) { map.fitBounds(b, opts); return; }
  want.zoom = Math.max(3, Math.min(want.zoom, opts.maxZoom));
  const cur = map.getZoom();
  let z = cur;
  if (force || want.zoom < cur) { z = want.zoom; frameZoomIn = 0; }       // віддалити - одразу
  else if (want.zoom > cur) { if (++frameZoomIn >= 2) { z = want.zoom; frameZoomIn = 0; } }
  else frameZoomIn = 0;
  // чи все важливе видно в робочій частині карти (без компаса, кнопок і картки ведення)
  const size = map.getSize();
  const inView = (ll) => {
    const p = map.latLngToContainerPoint(ll);
    return p.x >= pad.paddingTopLeft.x && p.y >= pad.paddingTopLeft.y
      && p.x <= size.x - pad.paddingBottomRight.x && p.y <= size.y - pad.paddingBottomRight.y;
  };
  const off = map.latLngToContainerPoint(want.center).distanceTo(map.latLngToContainerPoint(map.getCenter()));
  if (force || z !== cur || !keep.every(inView) || off > Math.min(size.x, size.y) * 0.2) {
    map.setView(want.center, z, { animate: true, duration: 0.6 });
  }
}

function openNav() {
  if (!target()) { toast('Спочатку познач точку', 'warn'); return; }
  S.navOpen = true; $('#nav').classList.remove('hidden'); $('#navBtn').classList.add('on');
  $('#trkCard').classList.add('hidden');
  enableCompass(); wake(true);
  const t = target();
  setReturnMode(S.settings.rmode, true);
  renderNav(); renderCompass();
  // карта веде тебе: у кадрі ти і ціль (картка ведення вже на екрані, її висоту враховуємо)
  if (S.pos) { setFollow(true); requestAnimationFrame(() => navFrame(true)); }
  else if (t) map.setView([t.lat, t.lon], Math.max(map.getZoom(), 16));
}
function closeNav() {
  S.navOpen = false; $('#nav').classList.add('hidden'); $('#navBtn').classList.remove('on');
  if (S.shownTrackId) $('#trkCard').classList.remove('hidden');
  updAskLater();
  // ведення скінчилось - лінію прибираємо, точка лишається
  if (routeAbort) { routeAbort.abort(); routeAbort = null; }
  S.rpath = null; S.rsrc = null; S.rpathLen = null; S.rpathFrom = null; S.rErr = null;
  S.noLine = false; S.rVia = null; S.rSnap = 0; S.rOff = false;
  drawReturn(); updateAll();
  if (!S.track) wake(false);
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function wake(on) {
  if (NATIVE) { try { WayBackNative.keepScreen(!!on && !!S.settings.wake); } catch (e) { /* */ } return; }
  try {
    if (on && S.settings.wake && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (S.track || S.navOpen) wake(true); }
  else if (S.track) saveTrack(true);
});
window.addEventListener('pagehide', () => { if (S.track) saveTrack(true); });

/* ---------- характеристики маршруту ---------- */
const fmtSpeed = (ms) => ms == null || !isFinite(ms) ? '—' : (ms * 3.6).toFixed(ms * 3.6 < 10 ? 1 : 0) + ' км/год';
const fmtTime = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
function trackStats(tr) {
  const pts = tr.pts || [];
  const end = tr.end || (pts.length ? pts[pts.length - 1][2] : tr.start);
  const dur = Math.max(0, end - tr.start);
  let moving = 0, maxSp = 0, up = 0, down = 0, far = 0, ref = null;
  const start = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]), dt = (pts[i][2] - pts[i - 1][2]) / 1000;
    if (dt > 0 && d / dt >= 0.3) moving += Math.min(dt, d / 0.3);   // довга пауза між точками - то стоянка, а не повільний рух
    if (start) far = Math.max(far, dist(start, pts[i]));
  }
  // максимальна швидкість - по відрізку щонайменше 10 с, щоб стрибок GPS не дав «200 км/год»
  for (let i = 1, j = 0, acc = 0; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    while (j < i - 1 && (pts[i][2] - pts[j + 1][2]) >= 10000) { acc -= dist(pts[j], pts[j + 1]); j++; }
    const dt = (pts[i][2] - pts[j][2]) / 1000;
    if (dt >= 10) { const sp = acc / dt; if (sp < 55) maxSp = Math.max(maxSp, sp); }
  }
  // набір і спуск висоти з порогом 4 м: дрібні коливання GPS по висоті не рахуємо
  for (const p of pts) {
    if (p[4] == null) continue;
    if (ref == null) { ref = p[4]; continue; }
    if (p[4] - ref >= 4) { up += p[4] - ref; ref = p[4]; } else if (ref - p[4] >= 4) { down += ref - p[4]; ref = p[4]; }
  }
  const hasAlt = pts.some((p) => p[4] != null);
  return {
    dur, end, moving: Math.min(moving * 1000, dur), stopped: Math.max(0, dur - moving * 1000),
    avg: dur > 0 ? tr.dist / (dur / 1000) : null, avgMove: moving > 0 ? tr.dist / moving : null,
    max: maxSp || null, far, back: start && pts.length > 1 ? dist(start, pts[pts.length - 1]) : null,
    up: hasAlt ? up : null, down: hasAlt ? down : null, n: pts.length,
  };
}
function trackStatsHtml(tr) {
  const st = trackStats(tr);
  const cell = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  const mode = [(TRAVEL[tr.travel] && `${TRAVEL[tr.travel].ico} ${TRAVEL[tr.travel].name}`), (PROFILES[tr.profile] && `${PROFILES[tr.profile].ico} ${PROFILES[tr.profile].name}`)].filter(Boolean).join(' · ');
  const notes = [tr.snap ? '🛣️ прикладено до доріг' : '', tr.autoStop ? '⏹ зупинено автоматично (стоянка 10 хв)' : ''].filter(Boolean);
  return `<div class="trk-stats">
    ${cell('Початок', `${fmtDate(tr.start)}`)}${cell('Кінець', fmtTime(st.end))}${cell('Тривалість', fmtDur(st.dur))}
    ${cell('Відстань', fmtDist(tr.dist))}${cell('У русі', fmtDur(st.moving))}${cell('Стоянки', fmtDur(st.stopped))}
    ${cell('Сер. швидкість', fmtSpeed(st.avg))}${cell('Сер. в русі', fmtSpeed(st.avgMove))}${cell('Макс. швидкість', fmtSpeed(st.max))}
    ${cell('Найдальше від старту', fmtDist(st.far))}${cell('Кінець від старту', fmtDist(st.back))}${cell('Точок сліду', st.n)}
    ${st.up != null ? cell('Набір висоти', Math.round(st.up) + ' м') + cell('Спуск', Math.round(st.down) + ' м') : ''}
    ${mode ? `<div class="wide"><span>Режим</span><b>${mode}</b></div>` : ''}
  </div>${notes.length ? `<div class="trk-notes">${notes.join(' · ')}</div>` : ''}`;
}

/* ---------- маршрут з архіву на карті ----------
   Архів закривається, слід - на карті, а внизу компактна картка з головним:
   відстань, час, швидкість. Повні характеристики розгортаються в самій картці,
   і карта щоразу підлаштовує кадр, щоб маршрут було видно над нею. */
function fitShownTrack() {
  if (!histLine.getLatLngs().length) return;
  const card = $('#trkCard'), h = card.classList.contains('hidden') ? 0 : card.offsetHeight;
  try {
    map.invalidateSize();
    map.fitBounds(histLine.getBounds(), { paddingTopLeft: L.point(72, 24), paddingBottomRight: L.point(52, h + 24), maxZoom: 17 });
  } catch (e) { /* */ }
}
function renderTrackCard(tr) {
  const st = trackStats(tr);
  $('#tcName').textContent = `${fmtDate(tr.start)}${tr.target ? ' · ' + tr.target : ''}`;
  const v = (k, val) => `<div><span>${k}</span><b>${val}</b></div>`;
  $('#tcSum').innerHTML = v('Відстань', fmtDist(tr.dist)) + v('Час', fmtDur(st.dur)) + v('Сер. швидк.', fmtSpeed(st.avg)) + v('Макс.', fmtSpeed(st.max));
  $('#tcFull').innerHTML = trackStatsHtml(tr);
}
function showTrack(tr) {
  S.shownTrackId = tr.id;
  histLine.setLatLngs(tr.snap || tr.pts.map((p) => [p[0], p[1]]));
  closeHist(); closeSheet(); setFollow(false);
  renderTrackCard(tr);
  $('#tcFull').classList.add('hidden'); $('#tcMore').textContent = '▴ Усі характеристики';
  if (!S.navOpen) $('#trkCard').classList.remove('hidden');
  requestAnimationFrame(fitShownTrack);
  if (!tr.snap && snapAllowed(tr) && navigator.onLine) {
    snapAndStore(tr).then((ok) => {
      if (ok && S.shownTrackId === tr.id) { histLine.setLatLngs(tr.snap); renderTrackCard(tr); toast('🛣️ Слід прикладено до доріг', 'good'); }
    });
  }
}
function hideTrack() {
  S.shownTrackId = null; histLine.setLatLngs([]);
  $('#trkCard').classList.add('hidden');
}
$('#tcClose').onclick = () => { hideTrack(); toast('Слід сховано'); };
$('#tcArch').onclick = () => { $('#trkCard').classList.add('hidden'); openHist(); };
$('#tcMore').onclick = () => {
  const full = $('#tcFull'), open = full.classList.toggle('hidden') === false;
  $('#tcMore').textContent = open ? '▾ Згорнути' : '▴ Усі характеристики';
  requestAnimationFrame(fitShownTrack);
};

/* ---------- tracks history ---------- */
function renderTrackList() {
  const el = $('#trackList');
  let html = '';
  if (S.track) {
    html += `<div class="item tgt"><span class="i-ico">🔴</span><div class="i-main"><b>Поточний запис</b><small>${fmtDist(S.track.dist)} · ${fmtDur(Date.now() - S.track.start)} · ${S.track.pts.length} т.</small></div>
      <div class="i-acts"><button data-cur="gpx" title="GPX">⬇️</button></div></div>`;
  }
  if (!S.tracks.length && !S.track) { el.innerHTML = '<div class="empty">Збережених треків ще немає</div>'; return; }
  if (S.tracks.length) {
    const kb = tracksBytes() / 1024, pct = Math.round(tracksBytes() / TRACKS_BUDGET * 100);
    html += `<div class="kv tracks-kv"><span>Історія: ${S.tracks.length} ${S.tracks.length === 1 ? 'трек' : 'тр.'}</span>` +
            `<b class="${pct > 85 ? 'c-orange' : ''}">${kb < 1024 ? kb.toFixed(0) + ' КБ' : (kb / 1024).toFixed(1) + ' МБ'} · ${pct}%</b></div>`;
  }
  html += S.tracks.map((t) => {
    const st = trackStats(t);
    return `<div class="item trk${t.id === S.shownTrackId ? ' tgt' : ''}" data-id="${t.id}">
      <span class="i-ico">${t.travel === 'car' ? '🚗' : '🥾'}</span>
      <div class="i-main" data-a="open"><b>${fmtDate(t.start)}${t.target ? ' · ' + esc(t.target) : ''}</b><small>${fmtDist(t.dist)} · ${fmtDur(st.dur)} · ${fmtSpeed(st.avg)}</small></div>
      <div class="i-acts">
        <button data-a="show" class="${t.id === S.shownTrackId ? 'on' : ''}" title="Показати">👁️</button>
        <button data-a="gpx" title="GPX">⬇️</button>
        <button data-a="del" title="Видалити">🗑️</button>
      </div></div>`;
  }).join('');
  el.innerHTML = html;
}
$('#trackList').onclick = async (e) => {
  if (e.target.closest('[data-cur]')) { downloadGpx(S.track); return; }
  const a = e.target.closest('[data-a]'), it = e.target.closest('[data-id]'); if (!a || !it) return;
  const tr = S.tracks.find((x) => x.id === it.dataset.id); if (!tr) return;
  if (a.dataset.a === 'show' && S.shownTrackId === tr.id) { hideTrack(); renderTrackList(); toast('Слід сховано'); return; }
  if (a.dataset.a === 'show' || a.dataset.a === 'open') showTrack(tr);
  else if (a.dataset.a === 'gpx') downloadGpx(tr);
  else if (a.dataset.a === 'del') {
    if (!(await confirmBox('Видалити трек?', `${fmtDate(tr.start)} · ${fmtDist(tr.dist)}`, 'Видалити'))) return;
    S.tracks = S.tracks.filter((x) => x.id !== tr.id); LS.set('tracks', S.tracks);
    if (S.shownTrackId === tr.id) hideTrack();
    renderTrackList();
  }
};
function toGpx(tr) {
  const pts = tr.pts.map((p) => `      <trkpt lat="${p[0]}" lon="${p[1]}">${p[4] != null ? `<ele>${p[4]}</ele>` : ''}<time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('\n');
  const wpts = S.points.map((p) => `  <wpt lat="${p.lat}" lon="${p.lon}"><name>${esc(p.icon + ' ' + p.name)}</name><time>${new Date(p.t).toISOString()}</time></wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="WayBack" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk><name>WayBack ${fmtDate(tr.start)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}
function download(name, text, type) {
  if (NATIVE) {
    let ok = false; try { ok = WayBackNative.saveFile(name, text, type || ''); } catch (e) { /* */ }
    toast(ok ? `💾 Збережено: Завантаження/WayBack/${name}` : 'Не вдалося зберегти файл', ok ? 'good' : 'warn');
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace(/[:T]/g, '-');
function downloadGpx(tr) { if (tr && tr.pts.length) download(`wayback-${stamp(tr.start)}.gpx`, toGpx(tr), 'application/gpx+xml'); else toast('Трек порожній', 'warn'); }

/* ---------- offline tiles ---------- */
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * 2 ** z);
function tileList(lat, lon, rKm, zmin, zmax) {
  const dLat = rKm / 111.32, dLon = rKm / (111.32 * Math.cos(rad(lat)));
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const x0 = lon2x(lon - dLon, z), x1 = lon2x(lon + dLon, z), y0 = lat2y(lat + dLat, z), y1 = lat2y(lat - dLat, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}
function tileUrl(l, z, x, y) { return l.url.replace('{s}', (l.sub || 'a')[0]).replace('{z}', z).replace('{x}', x).replace('{y}', y); }
const MAX_TILES = 25000;
function dlPlan() {
  const l = LAYERS[S.settings.layer], c = map.getCenter();
  const zmax = Math.min(S.settings.zmax, l.max);
  return { l, list: tileList(c.lat, c.lng, S.settings.radius, 11, zmax), zmax };
}
function updateDlInfo() {
  if ($('#sheet').classList.contains('hidden')) return;
  const { l, list, zmax } = dlPlan();
  const btn = $('#dlBtn');
  if (!l.dl) {
    $('#dlInfo').innerHTML = `Шар «${l.name}» не можна завантажувати наперед — так вимагає OpenStreetMap.` +
      ` Для офлайну підходить «Топо».<br><button class="btn primary mini" id="toTopo">Перемкнути на «Топо»</button>`;
    const t = $('#toTopo');
    if (t) t.onclick = () => { setLayer('topo'); renderMapTab(); toast('🗺️ Шар «Топо» — тепер можна завантажити', 'good'); };
    btn.disabled = true; return;
  }
  const perTile = S.settings.layer === 'sat' ? 22 : 14; // приблизно, КБ
  const mb = list.length * perTile / 1024;
  const mins = Math.ceil(list.length / 6 / 60); // ~6 плиток/с
  const size = mb < 1000 ? `${mb.toFixed(mb < 10 ? 1 : 0)} МБ` : `${(mb / 1024).toFixed(1)} ГБ`;
  let note = '';
  if (list.length > MAX_TILES) note = `<br><span class="c-red">Завелико — обери менший район або «Звичайно».</span>`;
  else if (list.length > 6000) note = `<br><span class="c-yellow">Це надовго (~${mins} хв) — краще по Wi-Fi і з зарядкою.</span>`;
  else if (list.length > 1500) note = `<br>Орієнтовно ${mins} хв.`;
  $('#dlInfo').innerHTML = `Район ${S.settings.radius} км, шар «${l.name}» — приблизно <b>${size}</b>${note}`;
  btn.disabled = list.length > MAX_TILES || dlState.running;
}
const dlState = { running: false, cancel: false };
async function downloadArea() {
  const { l, list } = dlPlan();
  if (!l.dl || list.length > MAX_TILES || !('caches' in window)) return;
  if (!navigator.onLine) { toast('Немає інтернету', 'warn'); return; }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* */ }
  const cache = NATIVE ? null : await caches.open(TILE_CACHE);
  dlState.running = true; dlState.cancel = false;
  $('#dlProg').classList.remove('hidden'); $('#dlCancel').classList.remove('hidden'); $('#dlBtn').disabled = true;
  let done = 0, fail = 0, skip = 0, i = 0;
  const bar = $('#dlBar');
  const worker = async () => {
    while (i < list.length && !dlState.cancel) {
      const [z, x, y] = list[i++];
      const url = tileUrl(l, z, x, y), key = tileKey(url);
      try {
        if (NATIVE) {
          // у додатку плитки зберігає сам Android (їх бачить і Android Auto)
          const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
          if (!r.ok) fail++; else if (r.headers.get('X-WB-Cache') === 'hit') skip++;
        } else if (await cache.match(key)) skip++;
        else {
          const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
          if (r.ok) await cache.put(key, r); else fail++;
        }
      } catch (e) { fail++; }
      done++;
      if (done % 5 === 0 || done === list.length) {
        bar.style.width = (done / list.length * 100).toFixed(1) + '%';
        $('#dlInfo').textContent = `Завантажено ${done} / ${list.length}` + (skip ? ` (вже було ${skip})` : '') + (fail ? ` · помилок ${fail}` : '');
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  dlState.running = false;
  $('#dlCancel').classList.add('hidden'); $('#dlBtn').disabled = false;
  toast(dlState.cancel ? 'Завантаження зупинено' : fail ? `Готово, але ${fail} плиток не вдалося` : '✅ Район збережено для офлайну', fail ? 'warn' : 'good');
  updateCacheSize();
}
async function updateCacheSize() {
  if (NATIVE) {
    try { $('#cacheSize').textContent = (+WayBackNative.tileBytes() / 1048576).toFixed(1) + ' МБ'; }
    catch (e) { $('#cacheSize').textContent = '—'; }
    return;
  }
  try {
    const e = await navigator.storage.estimate();
    $('#cacheSize').textContent = (e.usage / 1048576).toFixed(1) + ' МБ';
  } catch (err) { $('#cacheSize').textContent = '—'; }
}
$('#dlBtn').onclick = downloadArea;
$('#dlCancel').onclick = () => { dlState.cancel = true; };
$('#clearTiles').onclick = async () => {
  if (!(await confirmBox('Очистити кеш карт?', 'Офлайн-карти доведеться завантажити знову. Точки й треки не постраждають.', 'Очистити'))) return;
  if (NATIVE) { try { WayBackNative.clearTiles(); } catch (e) { /* */ } }
  await caches.delete(TILE_CACHE); updateCacheSize(); toast('Кеш карт очищено');
};

/* ---------- segments ---------- */
function seg(el, items, cur, onPick) {
  el.innerHTML = items.map(([v, t]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${t}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); onPick(b.dataset.v); };
}
function renderMapTab() {
  seg($('#layerSeg'), Object.entries(LAYERS).map(([k, l]) => [k, l.name]), S.settings.layer, (v) => { setLayer(v); updateDlInfo(); });
  seg($('#radiusSeg'), [[1, '1 км'], [3, '3 км'], [10, '10 км']], S.settings.radius, (v) => { S.settings.radius = +v; saveSettings(); updateDlInfo(); });
  seg($('#zoomSeg'), [[16, 'Звичайно'], [17, 'Детально']], S.settings.zmax, (v) => { S.settings.zmax = +v; saveSettings(); updateDlInfo(); });
  updateDlInfo(); updateCacheSize();
}
$('#shareBtn').onclick = shareHere;
$('#fabLayer').onclick = () => {
  const keys = Object.keys(LAYERS), next = keys[(keys.indexOf(S.settings.layer) + 1) % keys.length];
  setLayer(next); toast('Карта: ' + LAYERS[next].name);
};

/** Прибрати намальоване: поточний слід і побудований шлях назад.
 *  Запис не зупиняємо - він просто починається заново з цього місця,
 *  інакше вертатись знову не буде по чому. */
async function clearCurrent() {
  const hasTrack = S.track && S.track.pts.length > 1;
  const hasPath = !!(S.rpath && S.rpath.length > 1);
  const hadTgt = !!target();
  // ціль на карті - теж те, що висить. Казати «нічого очищати», коли на екрані
  // точка і лінія до неї, немає сенсу: кнопку натиснули саме щоб їх прибрати.
  if (!hasTrack && !hasPath && !hadTgt) { toast('Нічого очищати'); return; }
  // питаємо лише там, де є що втратити - пройдений слід. Лінію й ціль прибираємо одразу.
  if (hasTrack) {
    const txt = `Пройдене (${fmtDist(S.track.dist)}) буде стерто без збереження в історію. Запис продовжиться з цього місця.`;
    if (!(await confirmBox('Очистити поточний слід?', txt, 'Очистити'))) return;
    S.track.pts = []; S.track.dist = 0; S.track.start = Date.now();   // запис не уриваємо
    trackLine.setLatLngs([]); trackCase.setLatLngs([]);
    if (S.pos) recordPoint();
    saveTrack(true);
  }
  if (S.navOpen) closeNav();
  S.rpath = null; S.rsrc = null; S.rpathLen = null; S.rpathFrom = null; S.rErr = null;
  S.noLine = false; S.rVia = null; S.rSnap = 0;
  routeCase.setLatLngs([]); routeLine.setLatLngs([]); chevrons.clearLayers();
  if (hadTgt) {                        // точка лишається в списку, просто перестає бути ціллю
    S.targetId = null; S.arrived = false;
    savePoints(); renderPoints(); renderPointList();
  }
  drawReturn(); updateTrackBtn(); updateAll();
  toast(hadTgt ? 'Очищено · точка лишилась у списку' : 'Очищено', 'good');
}
$('#clearBtn').onclick = clearCurrent;

/* ---------- settings ---------- */
function renderSettings() {
  seg($('#themeSeg'), [['dark', 'Темна'], ['light', 'Світла']], S.settings.theme, (v) => { S.settings.theme = v; saveSettings(); applyTheme(); });
  $('#setWake').checked = S.settings.wake; $('#setVib').checked = S.settings.vibrate; $('#setAuto').checked = S.settings.auto; $('#setAutoRec').checked = S.settings.autorec;
  updBadge();
  const vv = $('#updVer'); if (vv) vv.textContent = `WayBack v${APP_VERSION}`;
  $('#verNote').textContent = `WayBack v${APP_VERSION} · дані зберігаються лише на цьому пристрої`;
}
$('#setWake').onchange = (e) => { S.settings.wake = e.target.checked; saveSettings(); if (!e.target.checked) wake(false); else if (S.track || S.navOpen) wake(true); };
$('#setVib').onchange = (e) => { S.settings.vibrate = e.target.checked; saveSettings(); };
$('#setAuto').onchange = (e) => { S.settings.auto = e.target.checked; saveSettings(); };
$('#setAutoRec').onchange = (e) => {
  S.settings.autorec = e.target.checked; saveSettings();
  if (S.settings.autorec) { S.autoOff = false; autoRecord(); }
};
$('#exportBtn').onclick = () => download(`wayback-backup-${stamp(Date.now())}.json`, JSON.stringify({ app: 'wayback', v: 1, points: S.points, target: S.targetId, tracks: S.tracks }, null, 1), 'application/json');
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const text = await f.text();
  try {
    if (/\.gpx$/i.test(f.name) || text.trim().startsWith('<')) importGpx(text);
    else {
      const d = JSON.parse(text); if (d.app !== 'wayback') throw new Error();
      const ids = new Set(S.points.map((p) => p.id)); d.points.forEach((p) => { if (!ids.has(p.id)) S.points.push(p); });
      const tids = new Set(S.tracks.map((t) => t.id)); d.tracks.forEach((t) => { if (!tids.has(t.id)) S.tracks.push(t); });
      S.tracks.sort((a, b) => b.start - a.start);
      if (!S.targetId && d.target) S.targetId = d.target;
      savePoints(); LS.set('tracks', S.tracks);
      toast(`Відновлено: ${d.points.length} точок, ${d.tracks.length} треків`, 'good');
    }
    renderPoints(); renderPointList(); renderTrackList(); updateAll();
  } catch (err) { toast('Не вдалося прочитати файл', 'warn'); }
};
function importGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // Чужий файл може бути яким завгодно: порожні, NaN чи неможливі координати.
  // Пропускаємо лише придатне, решту мовчки відкидаємо й кажемо скільки.
  const okLL = (a, b) => Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
  const MAX_WPT = 300, MAX_TRKPT = 20000;
  let np = 0, skipped = 0;
  [...doc.querySelectorAll('wpt')].slice(0, MAX_WPT).forEach((w) => {
    const la = +w.getAttribute('lat'), lo = +w.getAttribute('lon');
    if (!okLL(la, lo)) { skipped++; return; }
    const n = w.querySelector('name');
    addPoint({ name: n ? n.textContent.slice(0, 40) : 'Точка', icon: '📍', lat: la, lon: lo }); np++;
  });
  const all = [...doc.querySelectorAll('trkpt, rtept')];
  const pts = [];
  for (let i = 0; i < all.length && pts.length < MAX_TRKPT; i++) {
    const p = all[i];
    const la = +p.getAttribute('lat'), lo = +p.getAttribute('lon');
    if (!okLL(la, lo)) { skipped++; continue; }
    const t = p.querySelector('time'), e = p.querySelector('ele');
    const ts = t ? Date.parse(t.textContent) : NaN;
    const el = e ? +e.textContent : NaN;
    pts.push([la, lo, Number.isFinite(ts) ? ts : Date.now() + i * 1000, 0,
              Number.isFinite(el) ? Math.round(el) : null]);
  }
  if (pts.length > 1) {
    let d = 0; for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
    S.tracks.unshift({ id: 't' + Date.now(), start: pts[0][2], end: pts[pts.length - 1][2], pts, dist: d, target: 'імпорт GPX' });
    trimTracks();                        // щоб імпорт не переповнив памʼять
    LS.set('tracks', S.tracks);
  }
  if (!np && pts.length < 2) { toast('У файлі не знайшлось придатних координат', 'warn'); return; }
  toast(`GPX: ${np} точок, ${pts.length > 1 ? 1 : 0} трек`
        + (skipped ? ` · пропущено хибних: ${skipped}` : ''), 'good');
}
$('#exitBtn').onclick = async () => {
  if (S.track) {
    if (!(await confirmBox('Вийти з додатка?', `Триває запис: ${fmtDist(S.track.dist)}. Трек збережеться в історії.`, 'Зберегти і вийти'))) return;
    const tr = S.track; tr.end = Date.now();
    if (tr.pts.length > 1) {
    S.tracks.unshift(tr);
    const dropped = trimTracks();
    LS.set('tracks', S.tracks);
    if (dropped) toast(`Історію підчищено: найстаріших треків прибрано ${dropped}`, 'warn');
  }
    S.track = null; saveTrack(true); trackLine.setLatLngs([]); trackCase.setLatLngs([]); updateTrackBtn();
  }
  wake(false); closeSheet();
  try { window.close(); } catch (e) { /* */ }
  setTimeout(() => toast('Закрий вікно свайпом або кнопкою «Назад» — дані збережено', 'good'), 400);
};
/* ---------- оновлення: як в EnergyUA Junior і WordHunter ----------
   Нова версія ставиться лише з дозволу. Додаток тихо читає version.json поруч із собою:
   {"version": "1.19.1", "changes": ["…", "…"]}. Є новіша - у шапці «🆕 є версія …»,
   кнопка оновлення світиться, і WayBack питає «Оновити / Пізніше» з описом змін.
   Під час запису треку чи ведення до точки не питає - спитає, коли закінчиш.
   Точки, треки й завантажені карти при оновленні зберігаються. */
let UPD = null, updBusy = false, updAsked = '';
const vNum = (v) => String(v || '').split('.').map((x) => +x || 0);
function vNewer(a, b) { const x = vNum(a), y = vNum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
function updStatus(t) {
  ['#updSub', '#updSub2'].forEach((sel) => { const e = $(sel); if (e) e.textContent = t; });
}
function updBadge() {
  const t = $('#verTag');
  if (t) t.textContent = UPD ? `v${APP_VERSION} · 🆕 ${UPD.version}` : 'v' + APP_VERSION;
  if (t) t.classList.toggle('hot', !!UPD);
  const b = $('#updBtn');
  if (b) {
    b.classList.toggle('hot', !!UPD);
    const tip = UPD ? `Є версія ${UPD.version} — що нового?` : 'Перевірити оновлення';
    b.title = tip; b.setAttribute('aria-label', tip);
  }
  updStatus(UPD ? `Є версія ${UPD.version} — натисни 🔄 у шапці` : `Версія ${APP_VERSION}`);
}
const updCalm = () => !S.track && !S.navOpen && $('#modal').classList.contains('hidden');
async function fetchRemoteVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.version) return { version: String(j.version), changes: Array.isArray(j.changes) ? j.changes.slice(0, 8) : [] };
    }
  } catch (e) { /* немає version.json - дивимось у сам app.js */ }
  const r = await fetch('app.js?t=' + Date.now(), { cache: 'no-store' });
  const m = (await r.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
  return m ? { version: m[1], changes: [] } : null;
}
async function checkUpdate(manual) {
  manual = manual === true;
  if (manual && UPD) { askUpdate(); return; }
  if (updBusy) return;
  if (NATIVE) { if (manual) await checkApkUpdate({ set textContent(t) { updStatus(t); } }); return; }
  if (location.protocol === 'file:') return;
  if (!navigator.onLine) { if (manual) { updStatus(`Версія ${APP_VERSION} · немає інтернету`); toast('Немає інтернету — оновлення потребує звʼязку', 'warn'); } return; }
  updBusy = true;
  const btn = $('#updBtn');
  if (btn && manual) { btn.disabled = true; btn.classList.add('busy'); }   // іконку не чіпаємо, лише крутимо
  if (manual) updStatus('Перевіряю…');
  try {
    const rv = await fetchRemoteVersion();
    if (!rv) throw new Error('no version');
    UPD = vNewer(rv.version, APP_VERSION) ? rv : null;
    updBadge();
    if (!UPD) { if (manual) { updStatus(`Версія ${APP_VERSION} — остання ✓`); toast('У тебе остання версія ✓', 'good'); } }
    else if (manual || (updCalm() && updAsked !== UPD.version)) askUpdate();
  } catch (e) {
    if (manual) { updStatus(`Версія ${APP_VERSION} · не вдалося перевірити`); toast('Не вдалося перевірити оновлення', 'warn'); }
  }
  updBusy = false;
  if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
}
/** Запис чи ведення скінчились - якщо чекає оновлення, спитати трохи згодом. */
function updAskLater() {
  setTimeout(() => { if (typeof UPD !== 'undefined' && UPD && updAsked !== UPD.version && updCalm()) askUpdate(); }, 1500);
}
async function askUpdate() {
  if (!UPD) return;
  updAsked = UPD.version;
  const list = UPD.changes.length ? UPD.changes.map((c) => `• ${esc(c)}`).join('<br>') : 'опису змін немає.';
  const busy = S.track ? '<p class="um-warn">Зараз іде запис треку — після оновлення він продовжиться сам.</p>' : '';
  const go = await modal({
    title: `🆕 Нова версія ${UPD.version}`,
    html: `<div class="um"><b class="um-h">Що змінилось:</b><div class="um-list">${list}</div>${busy}`
      + `<p class="um-cur">Зараз у тебе ${esc(APP_VERSION)}. Точки, треки й завантажені карти збережуться.</p></div>`,
    ok: '🔄 Оновити', cancel: 'Пізніше', validate: () => true,
  });
  if (go) doUpdate(); else toast('Добре, спитаю наступного разу');
}
async function doUpdate() {
  const to = UPD ? UPD.version : 'нової версії';
  updStatus(`Оновлюю до ${to}…`);
  toast(`⬇️ Оновлюю до ${to}…`, 'good');
  LS.set('updFrom', APP_VERSION);
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== TILE_CACHE).map((k) => caches.delete(k)));   // карти лишаємо
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch (e) { /* */ }
  setTimeout(() => location.replace(location.pathname + '?v=' + encodeURIComponent(UPD ? UPD.version : Date.now())), 600);
}
{ // щойно оновились - сказати й прибрати ?v= з адреси
  const from = LS.get('updFrom', '');
  if (from) { LS.set('updFrom', ''); if (from !== APP_VERSION) setTimeout(() => toast(`✅ Оновлено: ${from} → ${APP_VERSION}`, 'good'), 900); }
  if (/[?&]v=/.test(location.search)) try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* */ }
}
const _ub = $('#updateBtn'); if (_ub) _ub.onclick = () => checkUpdate(true);
$('#updBtn').onclick = (e) => { e.stopPropagation(); checkUpdate(true); };
{ const v = $('#updVer'); if (v) v.textContent = `WayBack v${APP_VERSION}`; }
updBadge();
setTimeout(() => checkUpdate(false), 3000);
setInterval(() => checkUpdate(false), 30 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(false); });

/* ---------- підказка для новачка ---------- */
function syncHelp() {
  const box = $('#helpBox');
  if (!box) return;
  const used = S.points.length || S.tracks.length || S.track;
  box.open = !used && !LS.get('helpSeen', false);
  box.ontoggle = () => { if (!box.open) LS.set('helpSeen', true); };
}
async function firstRun() {
  if (LS.get('seen', false)) return;
  LS.set('seen', true);
  LS.set('helpSeen', true);
  await modal({
    title: 'Привіт! Як це працює',
    cancel: '',
    ok: 'Зрозуміло',
    html: `<ol class="help-steps">
        <li><b>Познач точку</b> там, куди треба повернутись — біля авто чи на стоянці. Кнопка «Позначити».</li>
        <li><b>Натисни «Старт»</b> і йди. Додаток пише твій слід.</li>
        <li><b>Натисни «Назад»</b> — стрілка й лінія приведуть до точки.</li>
      </ol>
      <p class="note">У меню згори обери, де ти: місто, ліс чи гори — під це підлаштується карта й спосіб повернення.</p>`,
    validate: () => true,
  });
}
setTimeout(firstRun, 800);

/* ---------- sheet ---------- */
function openSheet(tab) {
  $('#sheet').classList.remove('hidden');
  syncHelp();
  showTab(tab || 'points');
}
function closeSheet() { $('#sheet').classList.add('hidden'); }
function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + tab));
  if (tab === 'points') renderPointList();
  if (tab === 'map') renderMapTab();
  if (tab === 'settings') renderSettings();
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
$('#sheet').onclick = (e) => { if (e.target.closest('[data-close]')) closeSheet(); };
$('#menuBtn').onclick = () => openSheet();
function openHist() { closeSheet(); $('#trkCard').classList.add('hidden'); $('#histSheet').classList.remove('hidden'); renderTrackList(); }
function closeHist() { $('#histSheet').classList.add('hidden'); if (S.shownTrackId && !S.navOpen) $('#trkCard').classList.remove('hidden'); }
$('#histBtn').onclick = openHist;
$('#histSheet').onclick = (e) => { if (e.target.closest('[data-hclose]')) closeHist(); };
$('#scanBtn').onclick = () => { closeSheet(); setTimeout(scanQr, 120); };
$('#addCoordBtn').onclick = () => { closeSheet(); findPlaceDialog(); };


/* ---------- адреса, посилання, геокодер ---------- */

/** Витягує координати з усього, що можна вставити:
 *  посилання Google Maps / OSM, «49.84, 24.03», градуси з символами.
 *  Повертає {lat,lon} | {short:true} | null (тоді це адреса для пошуку). */
function parseAnyLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  // короткі посилання не розгорнути з браузера - заважає CORS
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(s)) return { short: true };

  const pats = [
    /[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)/i,          // ?q=lat,lon
    /[?&]ll=(-?\d+\.\d+),\s*(-?\d+\.\d+)/i,         // ?ll=lat,lon
    /[?&](?:daddr|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/i,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,                   // /maps/@lat,lon,17z
    /[#?&]mlat=(-?\d+\.\d+).*?[&]mlon=(-?\d+\.\d+)/i, // openstreetmap.org
    /#map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const lat = +m[1], lon = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
  }

  // внутрішній формат google place: !3d - широта, !4d - довгота, порядок буває різний
  const d3 = s.match(/!3d(-?\d+\.\d+)/), d4 = s.match(/!4d(-?\d+\.\d+)/);
  if (d3 && d4) {
    const lat = +d3[1], lon = +d4[1];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }

  // градуси-хвилини-секунди: 50°27'00.4"N 30°31'24.3"E
  const dms = s.match(/(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([NSПп])[,\s]+(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([EWЗз])/i);
  if (dms) {
    const d = (a, b, c) => +a + +b / 60 + +c / 3600;
    let lat = d(dms[1], dms[2], dms[3]), lon = d(dms[5], dms[6], dms[7]);
    if (/[Ss]/.test(dms[4])) lat = -lat;
    if (/[Ww]/.test(dms[8])) lon = -lon;
    return { lat, lon };
  }

  // просто пара чисел - але не всередині посилання
  if (!/https?:\/\//i.test(s)) {
    const c = parseCoords(s);
    if (c) return c;
  }
  return null;
}

/** Пошук адреси через Nominatim (OpenStreetMap). Потрібен інтернет. */
async function geocode(q) {
  const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=uk&q=' + encodeURIComponent(q);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return j.map((x) => ({ lat: +x.lat, lon: +x.lon, name: x.display_name }));
  } finally { clearTimeout(timer); }
}

/** Діалог «знайти місце»: адреса, посилання або координати. */
async function findPlaceDialog() {
  let picked = null;
  const res = await modal({
    title: 'Знайти місце',
    ok: 'Далі', cancel: 'Скасувати',
    html: `<input class="inp" id="fQ" placeholder="Вулиця, місто — або посилання з карт" inputmode="text">
      <div class="row-btns"><button class="btn primary" type="button" id="fGo">🔎 Знайти</button>
        <button class="btn" type="button" id="fPaste">📋 Вставити</button></div>
      <div id="fRes" class="find-res"></div>
      <p class="note">Можна: «Львів, Шевченка 10» · посилання з Google Maps · «49.8397, 24.0297».
        Пошук адреси потребує інтернету, координати й посилання працюють без нього.</p>`,
    onOpen: (b) => {
      const inp = b.querySelector('#fQ'), out = b.querySelector('#fRes');
      const show = (html) => { out.innerHTML = html; };
      const pick = (lat, lon, name) => {
        picked = { lat, lon, name };
        show(`<div class="find-ok">✅ ${name ? esc(name) + '<br>' : ''}<small>${fmtCoord(lat, lon)}</small></div>`);
      };
      const run = async () => {
        const v = inp.value.trim();
        if (!v) return;
        const loc = parseAnyLocation(v);
        if (loc && loc.short) {
          show('<div class="find-err">Коротке посилання тут не розгорнути. Відкрий його в картах і скопіюй адресний рядок або самі координати.</div>');
          return;
        }
        if (loc) { pick(loc.lat, loc.lon, null); return; }
        if (!navigator.onLine) { show('<div class="find-err">Немає інтернету — пошук за адресою недоступний. Встав координати або посилання.</div>'); return; }
        show('<div class="find-wait">Шукаю…</div>');
        try {
          const list = await geocode(v);
          if (!list.length) { show('<div class="find-err">Нічого не знайшов. Спробуй інакше написати адресу.</div>'); return; }
          show(list.map((x, i) => `<button type="button" class="find-item" data-i="${i}">${esc(x.name)}</button>`).join(''));
          out.onclick = (e) => {
            const it = e.target.closest('.find-item'); if (!it) return;
            const x = list[+it.dataset.i]; pick(x.lat, x.lon, x.name.split(',').slice(0, 2).join(',').trim());
          };
        } catch (e) {
          show('<div class="find-err">Не вдалося виконати пошук. Перевір звʼязок.</div>');
        }
      };
      b.querySelector('#fGo').onclick = run;
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
      b.querySelector('#fPaste').onclick = async () => {
        try { inp.value = await navigator.clipboard.readText(); run(); }
        catch (e) { toast('Браузер не дав доступ до буфера — встав вручну', 'warn'); inp.focus(); }
      };
      setTimeout(() => inp.focus(), 50);
    },
    validate: () => {
      if (!picked) { toast('Спершу знайди місце', 'warn'); return false; }
      return picked;
    },
  });
  if (!res) return;
  const first = S.points.length === 0;
  const got = await modal({
    title: 'Зберегти точку',
    html: pointForm({ name: res.name ? res.name.slice(0, 40) : autoName('📍'), icon: '📍', showTarget: true, tgt: first || !S.targetId }),
    onOpen: (b) => bindEmoji(b),
    validate: (b) => readForm(b),
  });
  if (!got) return;
  const p = addPoint({ name: got.name, icon: got.icon, lat: res.lat, lon: res.lon }, got.tgt);
  vibrate(30); toast(`${p.icon} «${p.name}» збережено`, 'good');
  setFollow(false); map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
}

/* ---------- buttons ---------- */
$('#markBtn').onclick = markHere;
$('#trackBtn').onclick = () => {
  if (S.track) stopTrack();
  else if (S.pendingStart) { S.pendingStart = false; updateTrackBtn(); }
  else startTrack();
};
$('#navBtn').onclick = () => (S.navOpen ? closeNav() : openNav());
$('#navClose').onclick = closeNav;
$('#pTarget').onclick = () => (target() ? openNav() : openSheet('points'));
$('#fabMe').onclick = () => {
  setFollow(true);
  if (!S.pos) { toast('Шукаю GPS…'); return; }
  if (S.navOpen && target()) navFrame(true);
  else map.setView([S.pos.lat, S.pos.lon], Math.max(map.getZoom(), 16));
};
$('#fabFit').onclick = () => {
  const ll = S.points.map((p) => [p.lat, p.lon]);
  if (S.pos) ll.push([S.pos.lat, S.pos.lon]);
  if (S.track) S.track.pts.forEach((p) => ll.push([p[0], p[1]]));
  if (!ll.length) return;
  setFollow(false);
  if (ll.length === 1) map.setView(ll[0], 16); else map.fitBounds(L.latLngBounds(ll).pad(0.15), { maxZoom: 17 });
};

/* ---------- Android-додаток і Android Auto ---------- */
/* У додатку WayBack для Android сторінка працює всередині WebView, а поруч є
   window.WayBackNative. Через нього машина бачить точки й шар карти, а телефон
   отримує треки, записані в машині, і місце паркування. У браузері цього обʼєкта
   немає, і все працює як раніше. */
function nativeSyncSoon(k) {
  if (!NATIVE || !/^(points|target|settings|track)$/.test(k)) return;
  clearTimeout(nativeTimer);
  nativeTimer = setTimeout(nativeSync, 1200);
}
function nativeSync() {
  if (!NATIVE) return;
  try {
    WayBackNative.sync(JSON.stringify({
      layer: S.settings.layer,
      target: S.targetId,
      points: S.points.map((p) => ({ id: p.id, name: p.name, icon: p.icon, lat: p.lat, lon: p.lon })),
      track: S.track ? S.track.pts.slice(-3000).map((p) => [p[0], p[1]]) : [],
    }));
  } catch (e) { /* */ }
}
/** Забрати з Android те, що записала машина: треки поїздок і місце паркування. */
function wbNativePull() {
  if (!NATIVE) return;
  let d;
  try { d = JSON.parse(WayBackNative.pending() || '{}'); } catch (e) { return; }
  const ack = { trips: [], parking: 0 };
  let added = 0;
  (d.trips || []).forEach((t) => {
    ack.trips.push(t.start);
    const id = 'car' + t.start;
    if (!t.pts || t.pts.length < 2 || S.tracks.some((x) => x.id === id)) return;
    let dd = 0;
    for (let i = 1; i < t.pts.length; i++) dd += dist(t.pts[i - 1], t.pts[i]);
    S.tracks.unshift({ id, start: t.start, end: t.end || t.pts[t.pts.length - 1][2], pts: t.pts, dist: dd, target: '🚗 поїздка' });
    added++;
  });
  if (added) {
    S.tracks.sort((a, b) => b.start - a.start);
    trimTracks();
    LS.set('tracks', S.tracks);
    if (!$('#histSheet').classList.contains('hidden')) renderTrackList();
    toast(`🚗 Треків з машини: ${added} — вони в історії`, 'good');
  }
  const pk = d.parking;
  if (pk && Number.isFinite(pk.lat) && Number.isFinite(pk.lon)) {
    ack.parking = pk.t;
    // одна «автоматична» точка машини, яку щоразу пересуваємо, а не плодимо нові
    let p = S.points.find((x) => x.auto === 'car');
    if (p) {
      p.lat = +pk.lat.toFixed(6); p.lon = +pk.lon.toFixed(6); p.t = pk.t;
      S.targetId = p.id; S.arrived = false;
      savePoints(); renderPoints(); renderPointList(); updateAll();
    } else {
      p = addPoint({ name: 'Машина', icon: '🚗', lat: pk.lat, lon: pk.lon }, true);
      p.auto = 'car'; savePoints();
    }
    toast('🚗 Місце машини збережено — вона тепер ціль', 'good');
  }
  if (ack.trips.length || ack.parking) { try { WayBackNative.ack(JSON.stringify(ack)); } catch (e) { /* */ } }
}
window.wbNativePull = wbNativePull;
/** Кнопка «Назад» на Android: закрити відкриту панель. false — закривати нічого. */
window.wbBack = () => {
  for (const sel of ['#histSheet', '#sheet']) {
    const el = $(sel);
    if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); return true; }
  }
  if (S.navOpen) { closeNav(); return true; }
  return false;
};
/** У додатку оновлення приходить новим APK — лише перевіряємо, чи є новіша версія. */
async function checkApkUpdate(sub) {
  let remote = null;
  try {
    const r = await fetch(RAW_APP_JS + '?t=' + Date.now(), { cache: 'no-store' });
    const m = (await r.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    remote = m && m[1];
  } catch (e) { /* немає звʼязку */ }
  if (!remote) { sub.textContent = `Версія ${APP_VERSION} · не вдалося перевірити`; toast('Не вдалося перевірити оновлення', 'warn'); return; }
  const a = remote.split('.').map(Number), b = APP_VERSION.split('.').map(Number);
  let cmp = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && !cmp; i++) cmp = (a[i] || 0) - (b[i] || 0);
  if (cmp <= 0) { sub.textContent = `Версія ${APP_VERSION} — остання ✓`; toast('У тебе остання версія ✓', 'good'); return; }
  sub.textContent = `Є версія ${remote} — встанови новий APK з GitHub (Actions)`;
  toast(`⬇️ Є версія ${remote}: завантаж новий APK на GitHub`, 'good');
}

/* ---------- init ---------- */
renderPoints();
if (S.track) {
  trackLine.setLatLngs(S.track.pts.map((p) => [p[0], p[1]]));
  toast('▶ Продовжую запис треку', 'good');
  wake(true);
}
updateTrackBtn();
updateAll();
setFollow(true);
handleIncomingLink();
startGps();
nativeSync();
if (!needsCompassPermission()) bindCompass();

window.addEventListener('online', () => toast('🌐 Інтернет є'));
window.addEventListener('offline', () => toast('📴 Офлайн — працюю з кешованою картою', 'warn'));

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !NATIVE) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
