/* WayBack — повернись на точку. PWA, працює онлайн і офлайн. */
'use strict';

const APP_VERSION = '1.27.0';
const $ = (s) => document.querySelector(s);
// Android-додаток (WebView) підкладає window.WayBackNative; у браузері його немає
const NATIVE = typeof window.WayBackNative !== 'undefined';
// Android-додаток 1.24+ пише слід сам, у службі: GPS працює і з вимкненим екраном.
const NREC = NATIVE && typeof WayBackNative.recStart === 'function';
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
  // Найдрібніша деталізація: стежки, ґрунтовки з покриттям, просіки, струмки, лавки,
  // джерела - аж до масштабу 20. Сервер OSM France, тож наперед не качаємо (як і «Схему»),
  // але все переглянуте кешується.
  detail: { name: 'Деталь', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', sub: 'abc', max: 20, dl: false,
    attr: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> | <a href="https://www.cyclosm.org">CyclOSM</a>' },
  // Супутник + дороги й назви поверх - видно і ліс, і куди веде дорога. Качається в офлайн.
  hybrid: { name: 'Гібрид', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 18, dl: true,
    over: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
           'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
    attr: '© Esri, Maxar, Earthstar Geographics, HERE, Garmin' },
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
  S.settings.zmax = near(+S.settings.zmax || 16, [16, 17, 18]);
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
const map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 20, preferCanvas: true, fadeAnimation: true }).setView(view.c, view.z);
let baseLayer = null, overLayers = [];

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
  overLayers.forEach((o) => map.removeLayer(o)); overLayers = [];
  baseLayer = new FastTiles(l.url, {
    subdomains: l.sub || 'abc', maxNativeZoom: l.max, maxZoom: 20, attribution: l.attr,
    keepBuffer: 4, updateWhenZooming: false, updateWhenIdle: false,
  }).addTo(map);
  // підписи й дороги поверх (у «Гібриді») - прозорі плитки над основою
  for (const u of l.over || []) {
    overLayers.push(new FastTiles(u, { subdomains: 'abc', maxNativeZoom: l.max, maxZoom: 20, zIndex: 2,
      keepBuffer: 4, updateWhenZooming: false, updateWhenIdle: false }).addTo(map));
  }
  S.settings.layer = id; saveSettings();
  if (typeof styleHistLine === 'function') try { styleHistLine(); } catch (e) { /* лінії ще не створені */ }
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
// Поточний слід - червоний, як і в архіві.
const trackCase = L.polyline([], Object.assign({}, CASE, { weight: 7 })).addTo(map);
const trackLine = L.polyline([], { color: '#ff2a2a', weight: 4, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(map);
// Пропуски в сліді (GPS мовчав) - тонким пунктиром: де саме ти йшов, невідомо,
// і суцільна пряма через ліс брехала б.
const trackGap = L.polyline([], { color: '#ff2a2a', weight: 2, opacity: .75, dashArray: '4 7', interactive: false, lineCap: 'round' }).addTo(map);
// Слід з історії - суцільна червона лінія. Малюється в окремому шарі зі змішуванням
// «multiply»: на світлій карті червоне лягає на дорогу, а чорні написи (назви вулиць,
// номери будинків) лишаються видно крізь лінію. На супутнику й темній карті таке
// змішування з'їло б лінію, тож там вона звичайна, з темною облямівкою.
map.createPane('histPane').style.zIndex = 405;
const histRenderer = L.canvas({ pane: 'histPane', padding: 0.3 });
const histCase  = L.polyline([], Object.assign({}, CASE, { weight: 8, renderer: histRenderer })).addTo(map);
const histLine  = L.polyline([], { color: '#ff2a2a', weight: 4.5, opacity: 1, lineCap: 'round', lineJoin: 'round', renderer: histRenderer }).addTo(map);
const histGap   = L.polyline([], { color: '#ff2a2a', weight: 2, opacity: .75, dashArray: '4 7', interactive: false, lineCap: 'round' }).addTo(map);
{ const set = histLine.setLatLngs.bind(histLine); histLine.setLatLngs = (ll) => { histCase.setLatLngs(ll); return set(ll); }; }
function styleHistLine() {
  const light = ['osm', 'topo', 'detail'].includes(S.settings.layer), z = map.getZoom();
  map.getPane('histPane').classList.toggle('blend', light);
  // ближче - тонше, щоб лінія не перекривала півкварталу
  const w = z >= 18 ? 3 : z >= 16 ? 3.6 : 4.5;
  histLine.setStyle({ weight: w, color: light ? '#ff1f1f' : '#ff2a2a' });
  histCase.setStyle({ weight: light ? 0 : w + 3.5, opacity: light ? 0 : .5 });
}
map.on('zoomend', styleHistLine);
styleHistLine();
const routeCase = L.polyline([], Object.assign({}, CASE, { weight: 6 })).addTo(map);
const routeLine = L.polyline([], { color: '#00d4ff', weight: 3.2, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(map);
const guideCase = L.polyline([], Object.assign({}, CASE, { weight: 5 })).addTo(map);
const guideLine = L.polyline([], { color: '#22e06a', weight: 2.8, opacity: 1, dashArray: '10 8', interactive: false, lineCap: 'round' }).addTo(map);
const chevrons  = L.layerGroup().addTo(map);

const RMODE = {
  direct: { name: 'Пряма',      ico: '↗',  color: '#22e06a' },
  track:  { name: 'Моїм треком', ico: '👣', color: '#ffd60a' },
  route:  { name: 'Дорогами',    ico: '🛣️', color: '#00d4ff' },
  alt:    { name: 'Іншою дорогою', ico: '🔀', color: '#c77dff' },   // лише в місті
};
const isRoadMode = (m) => m === 'route' || m === 'alt';
const pointLayer = L.layerGroup().addTo(map);

function setFollow(v) { S.follow = v; $('#fabMe').classList.toggle('on', v); }

function renderPoints() {
  pointLayer.clearLayers();
  // відкрито маршрут з архіву - на карті лише місця з тієї прогулянки (і ціль)
  const only = S.shownTrackId ? S.points.filter((p) => p.trk === S.shownTrackId || p.id === S.targetId) : S.points;
  for (const p of only) {
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
  S.gpsText = text;
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
  if (!NATIVE) watchGpsSwitch(true);
  const [flat, flon] = kalman(c.latitude, c.longitude, c.accuracy, t, c.speed);
  S.pos = { lat: flat, lon: flon, raw: [c.latitude, c.longitude], acc: c.accuracy, alt: c.altitude, t, speed: c.speed, heading: c.heading };
  const ll = [flat, flon];
  const a = c.accuracy;
  gpsBadge(a <= 15 ? 'ok' : a <= 40 ? 'mid' : 'bad', '±' + Math.round(a) + ' м');

  trackCourse(c, ll);

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
  } else {
    gpsBadge('bad', e.code === 2 ? 'Увімкни GPS' : 'Шукаю…');
    if (e.code === 2 && !NATIVE) watchGpsSwitch(false);
  }
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
{ const g = $('#vAcc'); if (g) g.onclick = () => (S.gpsDenied || !S.pos ? gpsHelp() : null); }

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
  S.cmpHeading = S.cmpHeading != null ? (S.cmpHeading + angDiff(h, S.cmpHeading) * 0.3 + 360) % 360 : h;
  S.lastCompass = Date.now();
  refreshHeading();
  updateHeadingUi();
}

/* ---------- напрям: куди ти йдеш / дивишся ----------
   Два джерела. Коли рухаєшся - напрям руху (курс GPS або зміщення на 8+ м):
   він надійний і не залежить від магнітів, заліза в машині чи некаліброваного
   компаса. Коли стоїш - компас телефона. Старий курс GPS після зупинки не
   використовуємо: розвернувся на місці - а він досі «дивиться» туди, куди йшов. */
const COURSE_FRESH = 4000;
function trackCourse(c, ll) {
  const now = Date.now();
  if (c.heading != null && !isNaN(c.heading) && (c.speed || 0) > 1) { S.course = c.heading; S.courseAt = now; }
  else if (c.accuracy <= 20) {
    if (!S.mvA || now - S.mvAt > 20000) { S.mvA = ll; S.mvAt = now; }
    else if (dist(S.mvA, ll) >= 8) {
      if (now - (S.courseAt || 0) > 1500) { S.course = bearing(S.mvA, ll); S.courseAt = now; }
      S.mvA = ll; S.mvAt = now;
    }
  }
  refreshHeading();
}
function refreshHeading() {
  const now = Date.now();
  if (S.course != null && now - S.courseAt < COURSE_FRESH) { S.heading = S.course; S.headingSrc = 'course'; }
  else if (S.cmpHeading != null && now - S.lastCompass < 3000) { S.heading = S.cmpHeading; S.headingSrc = 'compass'; }
  else { S.headingSrc = null; }
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

/* ---------- пропуски в сліді ----------
   Якщо між двома точками понад 45 с і 40+ м, то GPS у цей час не писав
   (екран гас у браузері, втрата сигналу). Такий відрізок малюємо пунктиром,
   а не суцільною лінією, і не прикладаємо до доріг пішохідний трек через нього. */
const GAP_MS = 45 * 1000, GAP_M = 40;
const isGap = (a, b) => a[2] != null && b[2] != null && b[2] - a[2] > GAP_MS && dist(a, b) > GAP_M;
/** Розбити точки на суцільні шматки й пропуски між ними. Розрив у прив'язаному сліді - null. */
function splitTrack(pts) {
  const segs = [], gaps = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p == null) { if (cur.length) segs.push(cur); cur = []; continue; }
    const prev = i > 0 ? pts[i - 1] : null;
    if (prev && isGap(prev, p)) { segs.push(cur); cur = []; gaps.push([[prev[0], prev[1]], [p[0], p[1]]]); }
    else if (prev == null && cur.length === 0 && segs.length) {
      const last = segs[segs.length - 1]; gaps.push([last[last.length - 1], [p[0], p[1]]]);
    }
    cur.push([p[0], p[1]]);
  }
  if (cur.length) segs.push(cur);
  return { segs: segs.filter((x) => x.length), gaps };
}
/** Поточний слід на карті. Перемальовуємо цілим (рідко, тож не важко). */
let liveDrawT = 0;
function drawLive() {
  liveDrawT = 0;
  if (!S.track) { trackLine.setLatLngs([]); trackCase.setLatLngs([]); trackGap.setLatLngs([]); return; }
  const { segs, gaps } = splitTrack(S.track.pts);
  trackLine.setLatLngs(segs); trackCase.setLatLngs(segs); trackGap.setLatLngs(gaps);
}
const drawLiveSoon = () => { if (!liveDrawT) liveDrawT = requestAnimationFrame(drawLive); };

/* ---------- запис у фоні (Android) ---------- */
/** Передати запис Android-службі. false - не вийшло, тоді пише сторінка, як раніше. */
function nativeRecStart() {
  S.nrecOk = false;
  if (!NREC || !S.track) return false;
  try { S.nrecOk = !!WayBackNative.recStart(S.track.id, Math.max(PROF().minStep, TRAV().minStep || 0), PROF().maxAcc); } catch (e) { S.nrecOk = false; }
  return S.nrecOk;
}
/** Забрати нові точки, які записав Android (у т.ч. поки екран був вимкнений). */
function pullRec() {
  if (!S.nrecOk || !S.track) return;
  let d;
  try { d = JSON.parse(WayBackNative.recPts(S.track.id, S.track.nn || 0)); } catch (e) { return; }
  if (d.id !== S.track.id || !d.rec) { nativeRecStart(); return; }     // служба перезапустилась - продовжуємо той самий трек
  let added = 0;
  for (const p of d.pts || []) {
    const last = S.track.pts[S.track.pts.length - 1];
    if (last && p[2] <= last[2]) continue;
    if (last) S.track.dist += dist(last, p);
    S.track.pts.push(p); added++;
  }
  S.track.nn = d.n;
  if (added) { drawLiveSoon(); saveTrack(); }
}
setInterval(pullRec, 2000);

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
  if (S.nrecOk) { pullRec(); return; }               // у додатку слід пише Android
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
    drawLiveSoon();
    saveTrack();
    return;
  }
  tr.pts.push(cur);                                   // перша точка запису
  drawLiveSoon();
  saveTrack();
}
function startTrack(silent) {
  if (S.gpsDenied) { if (!silent) gpsHelp(); return; }
  if (!S.pos) {
    if (silent) return;
    S.pendingStart = true; toast('Чекаю сигнал GPS…'); updateTrackBtn(); return;
  }
  if (!silent && !target() && S.settings.auto) {
    const had = S.points.some((x) => x.icon === '🚗' && isTemp(x));
    const pt = placeCar(S.pos.lat, S.pos.lon);
    toast(had ? `🚗 «${pt.name}» перенесено сюди` : `🚗 Точку «${pt.name}» позначено`, 'good');
  }
  if (!silent) S.autoOff = false;
  S.stillAt = null;
  S.track = { id: 't' + Date.now(), start: Date.now(), pts: [], dist: 0, target: target() ? target().name : null,
              travel: S.settings.travel, profile: S.settings.profile };
  drawLive();
  if (nativeRecStart()) pullRec(); else recordPoint();
  saveTrack(true);
  wake(true); if (!silent) vibrate(40);
  updateTrackBtn(); updateAll();
}

/* ---------- GPS і батарея: попередити до того, як слід вийде порожнім ---------- */
const nGpsOn = () => { try { return !NATIVE || typeof WayBackNative.gpsOn !== 'function' || WayBackNative.gpsOn(); } catch (e) { return true; } };
const nBattFree = () => { try { return !NATIVE || typeof WayBackNative.batteryFree !== 'function' || WayBackNative.batteryFree(); } catch (e) { return true; } };
async function askGpsOn() {
  vibrate([200, 100, 200]);
  const go = await modal({
    title: '📍 GPS вимкнений',
    html: `<div class="note" style="font-size:13px;color:var(--text);line-height:1.5">Без GPS слід не пишеться і повернути до точки не вийде.<br><br>
      Увімкни <b>«Місцезнаходження»</b> у шторці зверху або кнопкою нижче. Запис почнеться сам, щойно зʼявиться сигнал.</div>`,
    ok: NATIVE ? 'Відкрити налаштування' : 'Зрозуміло', cancel: 'Скасувати', validate: () => true,
  });
  if (go && NATIVE) { try { WayBackNative.openGpsSettings(); } catch (e) { /* */ } }
  return !!go;
}
async function askBattery() {
  if (nBattFree() || S.battAsked) return;
  S.battAsked = true;                                  // раз за сеанс, щоб не набридати
  const go = await modal({
    title: '🔋 Дозволь WayBack працювати у фоні',
    html: `<div class="note" style="font-size:13px;color:var(--text);line-height:1.5">Зараз телефон економить батарею на WayBack і може приспати запис, коли екран вимкнено, — тоді в сліді будуть пропуски.<br><br>
      Натисни <b>«Дозволити»</b> і вибери <b>«Дозволити»</b> / <b>«Без обмежень»</b>.<br>
      Samsung: Налаштування → Додатки → WayBack → Батарея → <b>«Без обмежень»</b>.</div>`,
    ok: 'Дозволити', cancel: 'Не зараз', validate: () => true,
  });
  if (go) { try { WayBackNative.openBatterySettings(); } catch (e) { /* */ } }
}
/** «Старт» з кнопки: спершу перевірити GPS, потім почати, потім - батарею. */
async function startTrackUi() {
  if (!S.gpsDenied && (!nGpsOn() || S.gpsOff)) {
    const go = await askGpsOn();
    if (!go) return;
    S.pendingStart = true; updateTrackBtn(); toast('Чекаю сигнал GPS…');
    return;
  }
  startTrack();
  if (S.track || S.pendingStart) askBattery();
}
/* GPS вимкнули посеред запису чи ведення - вібрація і попередження, увімкнули - підтвердження. */
let gpsWasOn = true;
function watchGpsSwitch(on) {
  if (on === gpsWasOn) return;
  gpsWasOn = on;
  S.gpsOff = !on;
  if (!(S.track || S.navOpen || S.pendingStart)) return;
  if (!on) {
    vibrate([400, 150, 400, 150, 400]);
    toast('⚠️ GPS вимкнено — слід не пишеться! Увімкни місцезнаходження', 'warn');
    if ($('#modal').classList.contains('hidden')) askGpsOn();
  } else toast('📍 GPS знову працює', 'good');
}
setInterval(() => { if (NATIVE) watchGpsSwitch(nGpsOn()); }, 3000);

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
/** Покласти готовий трек в архів (одне місце для «Стоп», автозупинки й «Очистити»). */
function archiveTrack(tr) {
  if (!tr || !tr.pts || tr.pts.length < 2) return false;
  S.tracks.unshift(tr);
  const dropped = trimTracks();
  LS.set('tracks', S.tracks);
  if (dropped) toast(`Історію підчищено: найстаріших треків прибрано ${dropped}`, 'warn');
  setTimeout(() => snapAndStore(tr), 1500);
  return true;
}
/** Зберегти активний запис в архів. end - коли рух насправді скінчився. */
function finishTrack(end, auto) {
  S.autoOff = true;                         // більше не починати самому
  pullRec();                                // останні точки, які записав Android
  const tr = S.track; tr.end = end;
  if (auto) tr.autoStop = true;
  if (S.pos && !auto) {   // останній крок - до самої точки зупинки
    const last = tr.pts[tr.pts.length - 1], cur = [+S.pos.lat.toFixed(6), +S.pos.lon.toFixed(6), Date.now(), Math.round(S.pos.acc), null];
    if (last && dist(last, cur) >= 3 && S.pos.acc <= PROF().maxAcc) { tr.dist += dist(last, cur); tr.pts.push(cur); }
  }
  delete tr.turnI; delete tr.turnPend; delete tr.nn;
  autoTravel(tr);
  archiveTrack(tr);
  S.track = null; saveTrack(true);
  if (NREC) { try { WayBackNative.recStop(); } catch (e) { /* */ } }
  S.nrecOk = false;
  drawLive();
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
  p.kind = (p.icon === '🚗' || p.icon === '👤') ? 'temp' : 'place';
  if (S.track) p.trk = S.track.id;                    // поставлена під час цієї прогулянки
  S.points.push(p);
  if (makeTarget || !S.targetId) S.targetId = p.id;
  savePoints(); renderPoints(); renderPointList(); updateAll();
  return p;
}
function setTarget(id) { S.targetId = id; S.arrived = false; S.wentFar = false; savePoints(); renderPoints(); renderPointList(); updateAll(); }

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
  const la = opts.coords ? res.lat : lat, lo = opts.coords ? res.lon : lon;
  if (res.icon === '🚗') {                            // машина одна - переносимо наявну
    const p = placeCar(la, lo);
    if (res.name && res.name !== p.name) { p.name = res.name; savePoints(); renderPoints(); renderPointList(); }
    vibrate(30); toast(`🚗 «${p.name}» тепер тут`, 'good');
    if (opts.coords) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
    return;
  }
  const twin = await samePlace(res.icon, la, lo);
  if (twin) {
    twin.visits = (twin.visits || 1) + 1; twin.t = Date.now();
    if (res.tgt) S.targetId = twin.id;
    savePoints(); renderPoints(); renderPointList(); updateAll();
    vibrate(30); toast(`${twin.icon} «${twin.name}» — знаходив тут уже ${twin.visits} р.`, 'good');
    return;
  }
  const p = addPoint({ name: res.name, icon: res.icon, lat: la, lon: lo }, res.tgt);
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
  if (!(await confirmBox('Видалити точку?', `${esc(p.icon)} ${esc(p.name)}. Вона полежить у кошику точок ${PT_TRASH_DAYS} днів — звідти можна повернути.`, 'Видалити'))) return;
  trashPoints([id]);
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

$('#pointList').onclick = async (e) => {
  const g = e.target.closest('[data-grp]');
  if (g) { S.grpOpen[g.dataset.grp] = S.grpOpen[g.dataset.grp] === false; LS.set('grpOpen', S.grpOpen); renderPointList(); return; }
  if (e.target.closest('[data-clean]')) { cleanPoints(); return; }
  if (e.target.closest('[data-pttrash]')) { S.ptTrashOpen = !S.ptTrashOpen; renderPointList(); return; }
  const tb = e.target.closest('[data-pt]');
  if (tb) {
    const t = S.ptTrash.find((x) => x.id === tb.closest('[data-ptid]').dataset.ptid); if (!t) return;
    if (tb.dataset.pt === 'restore') {
      S.ptTrash = S.ptTrash.filter((x) => x.id !== t.id); savePtTrash();
      const back = Object.assign({}, t); delete back.deletedAt; delete back.done;
      if (isTemp(back)) back.t = Date.now();                  // повернута тимчасова - ще 7 днів
      if (back.icon === '🚗' && isTemp(back) && S.points.some((x) => x.icon === '🚗' && isTemp(x))) back.kind = 'place';
      S.points.push(back); savePoints(); renderPoints(); updateAll();
      toast(`♻️ «${back.name}» повернуто`, 'good');
    } else {
      if (!(await confirmBox('Стерти назавжди?', `${esc(t.icon)} ${esc(t.name)}. Повернути вже не вийде.`, 'Стерти'))) return;
      S.ptTrash = S.ptTrash.filter((x) => x.id !== t.id); savePtTrash();
    }
    renderPointList(); return;
  }
  const a = e.target.closest('[data-a]'), it = e.target.closest('[data-id]'); if (!a || !it) return;
  const id = it.dataset.id, p = S.points.find((x) => x.id === id); if (!p) return;
  switch (a.dataset.a) {
    case 'tgt': setTarget(id); toast(`🎯 Ціль: ${p.name}`, 'good'); break;
    case 'keep': p.kind = 'place'; delete p.done; savePoints(); renderPointList(); toast(`📌 «${p.name}» тепер у «Моїх місцях» — сама не зникне`, 'good'); break;
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
  // У місті трек годиться, лише якщо він суцільний аж до цілі. Пропуск у записі
  // (GPS не писав) або трек, що закінчується далеко від цілі, дав би пряму крізь
  // квартали - краще тоді без лінії, зі стрілкою й відстанню.
  if (!straightOk() && trackBroken(tr.pts.slice(0, at.i + 1), path)) return null;
  path = thin(path, 4);
  return path.length > 1 ? path : null;
}

/** Чи є в шляху треком розрив: пропуск у записі або стрибок понад TRACK_JUMP. */
const TRACK_JUMP = 250;
function trackBroken(raw, path) {
  for (let i = 1; i < raw.length; i++) if (isGap(raw[i - 1], raw[i])) return true;
  for (let i = 1; i < path.length; i++) if (dist(path[i - 1], path[i]) > TRACK_JUMP) return true;
  return false;
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
  // тайм-аут теж обриває запит, але це не «перебив новий запит»: тоді треба
  // питати інший двигун, а не мовчки здаватись
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  try { return await fetch(url, { signal: ctl.signal }); }
  catch (e) { if (timedOut) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); throw e; }
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
/* Пішки чи машиною - визначаємо за швидкістю, а не лише за перемикачем:
   буває, що їдеш, а в WayBack лишилось «Пішки». Відрізок понад 18 км/год
   (між точками з часом) - це їзда. */
const CAR_MS = 5;                         // м/с ≈ 18 км/год
/** Частка шляху, пройдена зі швидкістю авто. */
function carShare(pts) {
  let all = 0, car = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a[2] == null || b[2] == null || isGap(a, b)) continue;
    const d = dist(a, b), dt = (b[2] - a[2]) / 1000;
    all += d;
    if (dt > 0 && d / dt >= CAR_MS) car += d;
  }
  return all > 0 ? car / all : 0;
}
/** Після запису: якщо більшість шляху проїхано, трек - автомобільний. */
function autoTravel(tr) {
  if (!tr || !tr.pts || tr.pts.length < 3 || tr.travel === 'car') return;
  if (carShare(tr.pts) >= 0.6) { tr.travel = 'car'; tr.travelAuto = true; }
}
const trackIsCar = (tr) => (tr.travel || S.settings.travel) === 'car' || carShare(tr.pts || []) >= 0.6;
const snapAllowed = (tr) => trackIsCar(tr) || (tr.profile || S.settings.profile) === 'city';
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
/** Дорога між двома точками (для пропуску в автомобільному сліді). */
async function roadBetween(a, b) {
  const body = { locations: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }], costing: 'auto', directions_type: 'none' };
  const r = await snapGet(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`, 15000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  let out = [];
  ((j.trip && j.trip.legs) || []).forEach((lg) => { if (lg.shape) out = out.concat(decodePoly6(lg.shape)); });
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
/** Прив'язати один суцільний шматок (без пропусків). */
async function snapPiece(seg, car) {
  const pts = thin(seg, car ? 8 : 5).map((p) => [p[0], p[1]]);
  if (pts.length < 2) return { path: pts, ok: false };
  const CH = 90, out = [];
  let ok = false;
  for (let i = 0; i < pts.length - 1; i += CH - 1) {
    const chunk = pts.slice(i, i + CH);
    let m = null;
    for (const ask of [matchValhalla, matchOsrm]) {
      try { const r = await ask(chunk, car); if (matchSane(chunk, r)) { m = r; break; } } catch (e) { /* наступний сервер */ }
    }
    if (m) ok = true;
    const part = m || chunk;
    out.push(...(out.length ? part.slice(1) : part));
  }
  return { path: out, ok };
}
/** Прив'язати трек до доріг. Кожен шматок окремо: машина - автодорогами, пішки в місті -
 *  тротуарами, пішки в лісі - як записано. Пропуск в автомобільному сліді заповнюємо
 *  дорогою між краями (замість прямої через поля); пішохідний пропуск лишається пунктиром.
 *  Повертає ламану, де null - розрив, або null, якщо нічого не прив'язалось. */
async function snapTrack(tr) {
  if (!tr || !tr.pts || tr.pts.length < 3 || !snapAllowed(tr) || !navigator.onLine) return null;
  const city = (tr.profile || S.settings.profile) === 'city';
  const forceCar = (tr.travel || S.settings.travel) === 'car';
  // шматки між пропусками
  const pieces = [];
  let cur = [tr.pts[0]];
  for (let i = 1; i < tr.pts.length; i++) {
    if (isGap(tr.pts[i - 1], tr.pts[i])) { pieces.push(cur); cur = []; }
    cur.push(tr.pts[i]);
  }
  pieces.push(cur);
  const out = [];
  let snapped = 0;
  for (let k = 0; k < pieces.length; k++) {
    const seg = pieces[k];
    const car = forceCar || carShare(seg) >= 0.5;
    let path = seg.map((p) => [p[0], p[1]]);
    if (seg.length >= 2 && (car || city)) {
      const r = await snapPiece(seg, car);
      if (r.ok) { path = r.path; snapped++; }
    }
    if (k > 0) {
      const prev = pieces[k - 1], a = prev[prev.length - 1], b = seg[0];
      const dt = (b[2] - a[2]) / 1000, straight = dist(a, b);
      const carGap = car || carShare(prev) >= 0.5 || (dt > 0 && straight / dt >= CAR_MS);
      let road = null;
      if (carGap) {
        try {
          const r = await roadBetween(a, b);
          if (pathLen(r) <= straight * 2.5 + 300) road = r;
        } catch (e) { /* лишимо пропуск */ }
      }
      if (road) { out.push(...road); snapped++; } else out.push(null);
    }
    out.push(...path);
  }
  if (!snapped) return null;
  return out.map((p) => (p ? [+p[0].toFixed(6), +p[1].toFixed(6)] : null));
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
    const alt = S.settings.rmode === 'alt';
    const res = alt ? await fetchAltRoute(here, [t.lat, t.lon]) : await fetchRoute(here, [t.lat, t.lon]);
    S.rpath = stitch(res.path, here, [t.lat, t.lon]);
    S.rsrc = alt ? 'alt' : 'route'; S.rpathLen = res.len; S.rpathFrom = here;
    S.rOv = alt ? res.ov : null;
    S.rErr = null; S.noLine = false; S.rVia = res.via;
    S.rSnap = res.snap && res.snap.length ? Math.max.apply(null, res.snap) : 0;
    drawReturn();
  } catch (e) {
    if (e && e.name === 'AbortError') { S.rErr = 'перервано'; return; }
    S.rErr = routeErrText(e);
    applyFallback('Не вийшло прокласти дорогами');
  } finally { S.rBusy = false; updateAll(); }
}

/** Людською мовою, чому сервер маршрутів не дав дороги. */
function routeErrText(e) {
  if (!e) return 'немає дороги';
  if (e.busy) return 'сервер маршрутів зайнятий';
  if (e.name === 'TimeoutError' || /timeout|час/i.test(e.message || '')) return 'сервер маршрутів не відповів вчасно';
  if (e.name === 'TypeError') return 'сервер маршрутів недоступний';
  if (/не схоже/.test(e.message || '')) return 'сервер дав маршрут, коротший за пряму';
  return 'дороги між точками не знайдено';
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
  if (p) { S.rpath = p; S.rsrc = 'track'; S.noLine = false; if (!S.navOpen) toast(msg + ' — веду твоїм треком', 'warn'); }
  else {
    S.rpath = null; S.rsrc = null; S.noLine = !straightOk();
    if (!S.navOpen) toast(S.noLine ? msg + ' — показую напрям і відстань, без лінії' : msg + ' — веду по прямій', 'warn');
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
  if (S.navOpen && inOverview() && S.rpath && !S.rOverDone) { S.rOverDone = true; routeOverview(overviewUntil === Infinity ? 0 : Math.max(2500, overviewUntil - Date.now())); }
  else if (S.navOpen && S.follow) navFrame();       // зʼявився або змінився шлях - підлаштувати кадр
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
  S.altBase = null;                         // «туди» для «Іншою дорогою» рахуємо заново
  if (!S.settings.rmodeBy) S.settings.rmodeBy = {};
  S.settings.rmodeBy[S.settings.profile] = m;   // у кожного профілю свій спосіб
  saveSettings();
  syncModeSeg();
  S.rpath = null; S.rsrc = null; S.rpathLen = null; S.rpathFrom = null; S.rErr = null;
  S.noLine = false; S.rVia = null; S.rSnap = 0;
  routeCase.setLatLngs([]); routeLine.setLatLngs([]); chevrons.clearLayers();
  if (m === 'track') {
    const p = buildTrackPath();
    if (p) { S.rpath = p; S.rsrc = 'track'; S.rpathLen = null; }
    else if (!silent && !S.navOpen) toast(S.track ? 'Слід ще короткий — поки веду прямою' : 'Немає записаного сліду — поки веду прямою', 'warn');
  } else if (isRoadMode(m) && S.navOpen) {
    requestRoute(true);
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
  if (isRoadMode(m)) {
    // немає лінії або веде запасний трек - пробуємо дорогу знову (не частіше ніж раз на 20 с)
    if (!S.rpath || S.rsrc !== m) { requestRoute(false); return; }
    const at = nearestOnPath(S.rpath, [S.pos.lat, S.pos.lon]);
    if (at.d > 60) requestRoute(false);   // збився з маршруту - перерахувати
  }
}


/* ---------- спосіб пересування ---------- */
function syncTravSeg() {
  document.querySelectorAll('#travSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.t === S.settings.travel));
  if ($('#modeChipTxt')) syncModeChip();
}
function setTravel(id, silent) {
  if (!TRAVEL[id] || id === S.settings.travel) { syncTravSeg(); return; }
  S.settings.travel = id; saveSettings();
  syncTravSeg();
  if (S.track && S.nrecOk) nativeRecStart();
  if (isRoadMode(S.settings.rmode)) {      // маршрут рахувався іншим профілем - перебудувати
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
  if ($('#modeChipTxt')) syncModeChip();
}
function setProfile(id, silent) {
  if (!PROFILES[id]) return;
  const p = PROFILES[id];
  S.settings.profile = id;
  S.settings.layer = p.layer;
  saveSettings();
  setLayer(p.layer);
  if (S.track && S.nrecOk) nativeRecStart();
  const want = (S.settings.rmodeBy || {})[id] || p.rmode || 'track';
  if (want !== S.settings.rmode) setReturnMode(want, true);
  syncModeSeg();
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
    if (straight > 150) S.wentFar = true;              // відійшов - тепер прибуття справжнє, а не старт біля машини
    if (near && !S.arrived) {
      S.arrived = true; vibrate([200, 100, 200]); if (S.navOpen) toast('🎉 Ти на місці!', 'good');
      const tp = target();
      if (tp && S.wentFar && isTemp(tp) && !tp.done) { tp.done = Date.now(); savePoints(); }   // тимчасова - зникне за 2 год
    }
    else if (!near && straight > 40) S.arrived = false;
  }
  if (S.navOpen) renderNav();
  updateHeadingUi();
}
function updateTimer() {
  if (S.track) {
    $('#vWalk').textContent = fmtDist(S.track.dist);
    $('#vTime').textContent = fmtDur(Date.now() - S.track.start);
  } else { $('#vWalk').textContent = '—'; $('#vTime').textContent = 'не пишеться'; }
  { const h = $('#vHist'); if (h) h.textContent = S.tracks.length || '—'; }
}
setInterval(updateTimer, 1000);

function headingFresh() {
  refreshHeading();
  return S.heading != null && !!S.headingSrc;
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
  if (S.navOpen) {
    el.classList.remove('off');
    mcRot = smoothRot(mcRot, ROT.on ? -ROT.b : 0);
    $('#mcRose').setAttribute('transform', `rotate(${mcRot.toFixed(1)})`);
    $('#mcDeg').textContent = ROT.on ? 'за рухом' : 'північ ↑';
    return;
  }
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
  if (S.navOpen) {                       // під час ведення: карта за рухом ⇄ північ угорі
    S.settings.headUp = !headUp(); saveSettings();
    setFollow(true); if (!headUp()) rotLayout(false);
    navFrame(true); renderMapCompass();
    toast(headUp() ? '🧭 Карта повертається за напрямом руху' : '🧭 Північ завжди вгорі');
    return;
  }
  if (needsCompassPermission() && !compassBound) { await enableCompass(); renderMapCompass(); return; }
  bindCompass();
  if (headingFresh()) {
    const src = S.headingSrc === 'compass' ? 'за компасом' : 'за напрямом руху';
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
  // тут лише напрям; що з маршрутом - пише один рядок під перемикачем режимів
  let sub = `азимут ${Math.round(S.navBearing)}° · ${dirName(S.navBearing)}`;
  if (m !== 'direct' && S.rpath && S.navStraight != null) sub += ` · навпростець ${fmtDist(S.navStraight)}`;
  $('#navSub').textContent = sub;
  const info = $('#rmodeInfo');
  if (info) {
    if (m === 'direct') info.textContent = 'Пряма — найкоротший напрям, без урахування доріг і перешкод.';
    else if (S.rBusy) info.textContent = 'Будую маршрут…';
    else if (S.rOff) info.innerHTML = '<b style="color:var(--orange)">Ти осторонь маршруту</b> — зеленим показано, як до нього вийти.';
    else if (S.rpath && S.rsrc === 'alt') {
      info.textContent = S.rOv == null ? 'Веду іншою дорогою.'
        : S.rOv <= 0.15 ? 'Веду іншою дорогою — вулицями, якими ти сюди не йшов.'
        : `Веду іншою дорогою. Повністю оминути шлях «туди» не вийшло: спільного ${Math.round(S.rOv * 100)}%.`;
    } else if (S.rpath && S.rsrc === 'route') {
      let s = S.settings.travel === 'car' ? 'Веду дорогами для авто' : 'Веду вулицями й тротуарами';
      if (S.rVia) s += ` · ${S.rVia}`;
      if (S.rSnap > 120) s += `. Найближча дорога за ${Math.round(S.rSnap)} м — до неї йди за стрілкою.`;
      else s += '.';
      info.textContent = s;
    } else if (S.rpath) {
      info.textContent = (isRoadMode(m) && S.rErr && S.rErr !== 'перервано')
        ? `Дорогами не вийшло: ${S.rErr}. Поки веду твоїм слідом, дорогу пробую знову.`
        : 'Веду назад твоїм же слідом.';
    }
    else if (S.noLine) info.innerHTML = `<b style="color:var(--orange)">Дорогами не вийшло</b>${S.rErr && S.rErr !== 'перервано' ? ': ' + esc(S.rErr) : ''}. Лінію не малюю, щоб не вести крізь будинки — іди за стрілкою й відстанню, або обери «Пряма». Дорогу пробую знову.`;
    else info.textContent = m === 'track' ? 'Немає записаного треку — веду по прямій.' : 'Маршрут недоступний — веду по прямій.';
  }
  if (hasH) {
    hint.innerHTML = S.headingSrc === 'compass' ? 'Тримай телефон горизонтально. Іди за зеленою стрілкою.' : 'Напрям — за твоїм рухом. Іди за зеленою стрілкою.';
  } else if (needsCompassPermission() && !compassBound) {
    hint.innerHTML = 'Компас вимкнено.<br><button class="btn primary" id="cmpBtn">Увімкнути компас</button>';
    $('#cmpBtn').onclick = () => enableCompass();
  } else {
    hint.innerHTML = 'Компаса немає: стрілка — відносно півночі (<b style="color:var(--red)">N</b>). Почни йти — напрям візьме GPS.';
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#rmodeSeg button');
  if (b) setReturnMode(b.dataset.m);
});
function syncModeSeg() {
  document.querySelectorAll('#rmodeSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.m === S.settings.rmode);
    if (b.dataset.m === 'alt') b.hidden = S.settings.profile !== 'city';   // «Іншою дорогою» - для міста
  });
}
syncModeSeg();
syncProfSeg(); syncTravSeg();

/* Де ти і як рухаєшся міняють раз за прогулянку, тож на головному екрані -
   один короткий рядок «🏙️ Місто · 🚶 Пішки ▾». Торкнувся - відкриваються перемикачі,
   обрав - знову згортаються і карта отримує місце назад. */
function syncModeChip() {
  const p = PROF(), t = TRAV();
  $('#modeChipTxt').textContent = `${p.ico} ${p.name} · ${t.ico} ${t.name}`;
}
function setModesOpen(open) {
  $('#quick').classList.toggle('open', open);
  $('#modeChip').setAttribute('aria-expanded', String(open));
  setTimeout(() => { try { map.invalidateSize(); } catch (e) { /* */ } }, 50);
}
$('#modeChip').onclick = () => setModesOpen(!$('#quick').classList.contains('open'));
$('#quick').addEventListener('click', (e) => {
  if (e.target.closest('#profSeg button, #travSeg button')) setTimeout(() => { syncModeChip(); setModesOpen(false); }, 250);
});
syncModeChip();

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


/* ---------- ведення як у Google Maps ----------
   Поки ведемо до точки, карта повертається за напрямом руху (куди йдеш - те вгорі),
   ти - внизу по центру, а попереду видно шлях. Масштаб сам: пішки ~250 м уперед,
   в авто - більше з ростом швидкості; підходиш до цілі - карта наближається.
   Обертання - власне, без сторонніх бібліотек: сам контейнер карти стає квадратом
   на діагональ екрана й повертається, а значки точок повертаються назад, щоб
   підписи лишались рівними. Торкнувся карти - вона стає північчю вгору і відпускає
   ведення; кнопка ◎ повертає все як було. Компас на карті перемикає режим. */
const ROT = { on: false, b: 0 };
let frameAt = 0, frameZoomIn = 0;
const headUp = () => S.settings.headUp !== false;
function rotLayout(on) {
  if (ROT.on === on) return;
  const wrap = $('.map-wrap'), m = $('#map');
  const c = map.getCenter(), z = map.getZoom();
  ROT.on = on;
  document.body.classList.toggle('maprot', on);
  if (on) {
    const W = wrap.clientWidth, H = wrap.clientHeight, D = Math.ceil(Math.hypot(W, H)) + 4;
    Object.assign(m.style, { width: D + 'px', height: D + 'px', left: (W - D) / 2 + 'px', top: (H - D) / 2 + 'px', right: 'auto', bottom: 'auto' });
  } else {
    m.style.cssText = ''; ROT.b = 0;
    document.body.style.setProperty('--brg', '0deg');
  }
  map.invalidateSize({ pan: false, animate: false });
  map.setView(c, z, { animate: false });
}
function setMapBearing(b) {
  const nb = smoothRot(ROT.b, b);
  if (Math.abs(nb - ROT.b) < 2) return;
  ROT.b = nb;
  $('#map').style.transform = `rotate(${(-ROT.b).toFixed(1)}deg)`;
  document.body.style.setProperty('--brg', ROT.b.toFixed(1) + 'deg');
  renderMapCompass();
}
/** Куди «дивиться» карта: напрям руху / компас; немає - напрям на ціль. */
function wantBearing() {
  if (!headUp()) return 0;
  if (headingFresh()) return S.heading;
  if (S.navBearing != null) return S.navBearing;
  return ((ROT.b % 360) + 360) % 360;
}
/* Огляд маршруту: весь шлях від тебе до цілі в одному кадрі, північ угорі.
   Показується кілька секунд щойно натиснув «Назад», а також кнопкою ⤢ - доки
   не натиснеш ◎. Поки огляд, ведення кадр не чіпає. */
let overviewUntil = 0, overviewT = null;
const inOverview = () => Date.now() < overviewUntil;
function routeOverview(ms) {
  const t = target();
  if (!t) return;
  const ll = [[t.lat, t.lon]];
  if (S.pos) ll.push([S.pos.lat, S.pos.lon]);
  (S.rpath || []).forEach((p) => ll.push([p[0], p[1]]));
  overviewUntil = ms ? Date.now() + ms : Infinity;
  clearTimeout(overviewT);
  if (ms) overviewT = setTimeout(() => { overviewUntil = 0; if (S.navOpen && S.follow) navFrame(true); }, ms);
  rotLayout(false); renderMapCompass();
  const navH = S.navOpen ? ($('#nav').offsetHeight || 0) : 0;
  try {
    if (ll.length === 1) map.setView(ll[0], 17);
    else map.fitBounds(L.latLngBounds(ll), { paddingTopLeft: L.point(70, 60), paddingBottomRight: L.point(70, navH + 40), maxZoom: 18, animate: true });
  } catch (e) { /* */ }
}
function endOverview() { overviewUntil = 0; clearTimeout(overviewT); }
/* Масштаб, який ти виставив пальцями, ведення не перебиває: міняємо лише центр.
   ◎ повертає автомасштаб. */
{
  const mark = () => { if (S.navOpen) { S.userZoom = true; endOverview(); } };
  const el = $('#map');
  el.addEventListener('touchstart', (e) => { if (e.touches && e.touches.length > 1) mark(); }, { passive: true });
  el.addEventListener('wheel', mark, { passive: true });
  el.addEventListener('dblclick', mark);
}
function navFrame(force) {
  if (!S.navOpen || !S.follow || !S.pos || !target()) return;
  if (inOverview()) return;
  const now = Date.now();
  if (!force && now - frameAt < 800) return;
  frameAt = now;
  rotLayout(headUp());
  const b = ROT.on ? wantBearing() : 0;
  if (ROT.on) setMapBearing(b);
  const here = [S.pos.lat, S.pos.lon], t = target();
  const toGo = S.navDist != null ? S.navDist : dist(here, [t.lat, t.lon]);
  const wrap = $('.map-wrap'), Hp = wrap.clientHeight;
  const navH = $('#nav').offsetHeight || 0, Hv = Math.max(160, Hp - navH);
  const yMe = Math.round(Hv * 0.74);                       // ти - нижче центру видимої частини
  // скільки метрів показати попереду
  const sp = S.pos.speed > 0 ? S.pos.speed : 0;
  let ahead = S.settings.travel === 'car' ? Math.min(2000, Math.max(300, sp * 25)) : 250;
  ahead = Math.min(ahead, Math.max(toGo * 1.25, 35));       // ціль ближче - наближаємо до неї
  const avail = Math.max(60, yMe - 40);
  const mpp0 = 156543.03 * Math.cos(rad(here[0]));          // метрів на піксель при масштабі 0
  let zw = Math.floor(Math.log2(mpp0 * avail / ahead));
  zw = Math.max(12, Math.min(19, zw));
  const cur = map.getZoom();
  let z = cur;
  if (S.userZoom) { z = cur; frameZoomIn = 0; }
  else if (force || zw < cur) { z = zw; frameZoomIn = 0; } else if (zw > cur) { if (++frameZoomIn >= 2) { z = zw; frameZoomIn = 0; } } else frameZoomIn = 0;
  // центр карти такий, щоб ти опинився в точці (середина, yMe) з урахуванням повороту
  const br = rad(ROT.on ? ROT.b : 0), oy = yMe - Hp / 2;
  const mx = -oy * Math.sin(br), my = oy * Math.cos(br);
  const center = map.unproject(map.project(here, z).subtract(L.point(mx, my)), z);
  const moved = map.latLngToContainerPoint(center).distanceTo(map.latLngToContainerPoint(map.getCenter()));
  if (force || z !== cur || moved > 3) map.setView(center, z, { animate: true, duration: 0.5 });
}
window.addEventListener('resize', () => { if (ROT.on) { rotLayout(false); navFrame(true); } });
// у режимі обертання перший дотик повертає карту північчю вгору і відпускає ведення
$('#map').addEventListener('pointerdown', (e) => {
  if (!ROT.on) return;
  e.stopPropagation(); e.preventDefault();
  setFollow(false); rotLayout(false); renderMapCompass();
}, true);
$('#map').addEventListener('touchstart', (e) => { if (ROT.on) { e.stopPropagation(); } }, { capture: true, passive: true });

/* Картку ведення можна згорнути: лишаються назва, відстань і маленька стрілка,
   а карта отримує половину екрана назад. Вибір запамʼятовується. */
function applyNavMin() {
  const min = !!S.settings.navMin;
  $('#nav').classList.toggle('min', min);
  $('#navMin').textContent = min ? '▴' : '▾';
  $('#navMin').title = min ? 'Розгорнути' : 'Згорнути';
  requestAnimationFrame(() => {
    document.body.style.setProperty('--navh', ($('#nav').offsetHeight || 0) + 'px');
    if (S.navOpen && S.follow) navFrame(true);
  });
}
$('#navMin').onclick = () => { S.settings.navMin = !S.settings.navMin; saveSettings(); applyNavMin(); };

function openNav() {
  if (!target()) { toast('Спочатку познач точку', 'warn'); return; }
  S.rOverDone = false;
  S.navOpen = true; $('#nav').classList.remove('hidden'); $('#navBtn').classList.add('on');
  $('#trkCard').classList.add('hidden');
  document.body.classList.add('nav-open');
  requestAnimationFrame(() => document.body.style.setProperty('--navh', ($('#nav').offsetHeight || 0) + 'px'));
  enableCompass(); wake(true);
  const t = target();
  setReturnMode(S.settings.rmode, true);
  applyNavMin();
  renderNav(); renderCompass();
  // карта веде тебе: у кадрі ти і ціль (картка ведення вже на екрані, її висоту враховуємо)
  // спершу - весь маршрут у кадрі, через 5 с карта переходить до ведення
  S.userZoom = false;
  setFollow(true);
  requestAnimationFrame(() => routeOverview(5000));
}
function closeNav() {
  S.navOpen = false; $('#nav').classList.add('hidden'); $('#navBtn').classList.remove('on');
  document.body.classList.remove('nav-open');
  endOverview(); S.userZoom = false;
  rotLayout(false); renderMapCompass();
  if (S.shownTrackId) $('#trkCard').classList.remove('hidden');
  updAskLater();
  // ведення скінчилось - лінію прибираємо, точка лишається
  if (routeAbort) { routeAbort.abort(); routeAbort = null; }
  S.rpath = null; S.rsrc = null; S.rpathLen = null; S.rpathFrom = null; S.rErr = null;
  S.noLine = false; S.rVia = null; S.rSnap = 0; S.rOff = false; S.altBase = null;
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
/* Коли екран гасне, браузер присипляє сторінку і GPS не пише. Повернувшись,
   кажемо про це прямо - щоб пропуск у сліді не був несподіванкою. */
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (S.track || S.navOpen) wake(true);
    pullRec();
    const gap = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (S.track && gap > 60 * 1000 && !NATIVE) {
      const last = S.track.pts[S.track.pts.length - 1];
      const silent = !last || Date.now() - last[2] > 60 * 1000;
      if (silent) setTimeout(() => toast(`⚠️ Екран був вимкнений ${fmtDur(gap)} — браузер у цей час не писав слід, пропуск на карті пунктиром. Щоб слід писався в кишені з вимкненим екраном, постав Android-додаток WayBack (APK).`, 'warn'), 600);
    }
  } else {
    hiddenAt = Date.now();
    if (S.track) saveTrack(true);
  }
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
  const mode = [(TRAVEL[tr.travel] && `${TRAVEL[tr.travel].ico} ${TRAVEL[tr.travel].name}${tr.travelAuto ? ' (за швидкістю)' : ''}`), (PROFILES[tr.profile] && `${PROFILES[tr.profile].ico} ${PROFILES[tr.profile].name}`)].filter(Boolean).join(' · ');
  const nGap = tr.pts.reduce((n, p, i) => n + (i && isGap(tr.pts[i - 1], p) ? 1 : 0), 0);
  const notes = [tr.snap ? '🛣️ прикладено до доріг' : '', nGap ? `┄ пропусків GPS: ${nGap} (пунктир)` : '', tr.autoStop ? '⏹ зупинено автоматично (стоянка 10 хв)' : ''].filter(Boolean);
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
/** « · 🍄×3 💧» - які місця позначено під час прогулянки. */
function placesLine(id) {
  const c = {};
  S.points.forEach((p) => { if (p.trk === id && !isTemp(p)) c[p.icon] = (c[p.icon] || 0) + 1; });
  const k = Object.keys(c);
  return k.length ? ' · ' + k.map((i) => esc(i) + (c[i] > 1 ? '×' + c[i] : '')).join(' ') : '';
}
function renderTrackCard(tr) {
  const st = trackStats(tr);
  $('#tcName').innerHTML = `${esc(fmtDate(tr.start))}${tr.target ? ' · ' + esc(tr.target) : ''}${placesLine(tr.id)}`;
  const v = (k, val) => `<div><span>${k}</span><b>${val}</b></div>`;
  $('#tcSum').innerHTML = v('Відстань', fmtDist(tr.dist)) + v('Час', fmtDur(st.dur)) + v('Сер. швидк.', fmtSpeed(st.avg)) + v('Макс.', fmtSpeed(st.max));
  $('#tcFull').innerHTML = trackStatsHtml(tr);
}
function showTrack(tr) {
  S.shownTrackId = tr.id;
  renderPoints();
  drawHist(tr);
  closeHist(); closeSheet(); setFollow(false);
  renderTrackCard(tr);
  $('#tcFull').classList.add('hidden'); $('#tcMore').textContent = '▴ Усі характеристики';
  if (!S.navOpen) $('#trkCard').classList.remove('hidden');
  requestAnimationFrame(fitShownTrack);
  if (!tr.snap && snapAllowed(tr) && navigator.onLine) {
    snapAndStore(tr).then((ok) => {
      if (ok && S.shownTrackId === tr.id) { drawHist(tr); renderTrackCard(tr); toast('🛣️ Слід прикладено до доріг', 'good'); }
    });
  }
}
function drawHist(tr) {
  const { segs, gaps } = splitTrack(tr.snap || tr.pts);
  histLine.setLatLngs(segs); histGap.setLatLngs(gaps);
}
function hideTrack() {
  S.shownTrackId = null;
  setTimeout(renderPoints, 0); histLine.setLatLngs([]); histGap.setLatLngs([]);
  $('#trkCard').classList.add('hidden');
}
$('#tcClose').onclick = () => { hideTrack(); toast('Слід сховано'); };
$('#tcPlay').onclick = () => { const tr = S.tracks.find((x) => x.id === S.shownTrackId); if (tr) openReplay(tr); };
$('#tcArch').onclick = () => { $('#trkCard').classList.add('hidden'); openHist(); };
$('#tcMore').onclick = () => {
  const full = $('#tcFull'), open = full.classList.toggle('hidden') === false;
  $('#tcMore').textContent = open ? '▾ Згорнути' : '▴ Усі характеристики';
  requestAnimationFrame(fitShownTrack);
};

/* ---------- кошик ----------
   Видалений маршрут не зникає одразу: 30 днів він лежить у кошику під архівом,
   звідки його можна повернути. Старші за 30 днів прибираються самі. */
const TRASH_DAYS = 30;
S.trash = LS.get('trash', []).filter((t) => Date.now() - (t.deletedAt || 0) < TRASH_DAYS * 864e5);
LS.set('trash', S.trash);
function trashHtml() {
  if (!S.trash.length) return '';
  const left = (t) => Math.max(1, Math.ceil((t.deletedAt + TRASH_DAYS * 864e5 - Date.now()) / 864e5));
  let h = `<button class="trash-head" data-trash-toggle>🗑️ Кошик · ${S.trash.length} <span>${S.trashOpen ? '▴' : '▾'}</span></button>`;
  if (S.trashOpen) h += S.trash.map((t) => `<div class="item trash-item" data-tid="${t.id}">
      <span class="i-ico">🗑️</span>
      <div class="i-main"><b>${fmtDate(t.start)}${t.target ? ' · ' + esc(t.target) : ''}</b><small>${fmtDist(t.dist)} · зникне через ${left(t)} дн.</small></div>
      <div class="i-acts"><button data-t="restore" title="Повернути">♻️</button><button data-t="purge" title="Стерти назавжди">✖️</button></div></div>`).join('');
  return h;
}

/* ---------- tracks history ---------- */
function renderTrackList() {
  const el = $('#trackList');
  let html = '';
  if (S.track) {
    html += `<div class="item tgt"><span class="i-ico">🔴</span><div class="i-main"><b>Поточний запис</b><small>${fmtDist(S.track.dist)} · ${fmtDur(Date.now() - S.track.start)} · ${S.track.pts.length} т.</small></div>
      <div class="i-acts"><button data-cur="gpx" title="GPX">⬇️</button></div></div>`;
  }
  if (!S.tracks.length && !S.track) { el.innerHTML = '<div class="empty">Збережених треків ще немає</div>' + trashHtml(); return; }
  if (S.tracks.length) {
    const kb = tracksBytes() / 1024, pct = Math.round(tracksBytes() / TRACKS_BUDGET * 100);
    html += `<div class="kv tracks-kv"><span>Історія: ${S.tracks.length} ${S.tracks.length === 1 ? 'трек' : 'тр.'}</span>` +
            `<b class="${pct > 85 ? 'c-orange' : ''}">${kb < 1024 ? kb.toFixed(0) + ' КБ' : (kb / 1024).toFixed(1) + ' МБ'} · ${pct}%</b></div>`;
  }
  html += S.tracks.map((t) => {
    const st = trackStats(t);
    return `<div class="item trk${t.id === S.shownTrackId ? ' tgt' : ''}" data-id="${t.id}">
      <span class="i-ico">${t.travel === 'car' ? '🚗' : '🥾'}</span>
      <div class="i-main" data-a="open"><b>${fmtDate(t.start)}${t.target ? ' · ' + esc(t.target) : ''}</b><small>${fmtDist(t.dist)} · ${fmtDur(st.dur)} · ${fmtSpeed(st.avg)}${placesLine(t.id)}</small></div>
      <div class="i-acts">
        <button data-a="show" class="${t.id === S.shownTrackId ? 'on' : ''}" title="Показати">👁️</button>
        <button data-a="gpx" title="GPX">⬇️</button>
        <button data-a="del" title="Видалити">🗑️</button>
      </div></div>`;
  }).join('');
  el.innerHTML = html + trashHtml();
}
$('#trackList').onclick = async (e) => {
  if (e.target.closest('[data-cur]')) { downloadGpx(S.track); return; }
  if (e.target.closest('[data-trash-toggle]')) { S.trashOpen = !S.trashOpen; renderTrackList(); return; }
  const tb = e.target.closest('[data-t]');
  if (tb) {
    const tr = S.trash.find((x) => x.id === tb.closest('[data-tid]').dataset.tid); if (!tr) return;
    if (tb.dataset.t === 'restore') {
      S.trash = S.trash.filter((x) => x.id !== tr.id); LS.set('trash', S.trash);
      const back = Object.assign({}, tr); delete back.deletedAt;
      if (!S.tracks.some((x) => x.id === back.id)) { S.tracks.push(back); S.tracks.sort((a, b) => b.start - a.start); trimTracks(); LS.set('tracks', S.tracks); }
      toast('♻️ Маршрут повернуто в архів', 'good');
    } else if (tb.dataset.t === 'purge') {
      if (!(await confirmBox('Стерти назавжди?', `${fmtDate(tr.start)} · ${fmtDist(tr.dist)}. Повернути вже не вийде.`, 'Стерти'))) return;
      S.trash = S.trash.filter((x) => x.id !== tr.id); LS.set('trash', S.trash);
    }
    renderTrackList(); return;
  }
  const a = e.target.closest('[data-a]'), it = e.target.closest('[data-id]'); if (!a || !it) return;
  const tr = S.tracks.find((x) => x.id === it.dataset.id); if (!tr) return;
  if (a.dataset.a === 'show' && S.shownTrackId === tr.id) { hideTrack(); renderTrackList(); toast('Слід сховано'); return; }
  if (a.dataset.a === 'show' || a.dataset.a === 'open') showTrack(tr);
  else if (a.dataset.a === 'gpx') downloadGpx(tr);
  else if (a.dataset.a === 'del') {
    if (!(await confirmBox('Видалити трек?', `${fmtDate(tr.start)} · ${fmtDist(tr.dist)}. Він полежить у кошику ${TRASH_DAYS} днів — звідти можна повернути.`, 'Видалити'))) return;
    S.tracks = S.tracks.filter((x) => x.id !== tr.id); LS.set('tracks', S.tracks);
    S.trash.unshift(Object.assign({}, tr, { deletedAt: Date.now() }));
    if (S.trash.length > 20) S.trash.length = 20;
    LS.set('trash', S.trash);
    if (S.shownTrackId === tr.id) hideTrack();
    renderTrackList();
  }
};
function toGpx(tr) {
  // пропуск у сліді - новий <trkseg>, щоб інші програми теж не тягнули пряму
  const pts = tr.pts.map((p, i) => (i && isGap(tr.pts[i - 1], p) ? '    </trkseg>\n    <trkseg>\n' : '')
    + `      <trkpt lat="${p[0]}" lon="${p[1]}">${p[4] != null ? `<ele>${p[4]}</ele>` : ''}<time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('\n');
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
function tileUrl(l, z, x, y, u) { return (u || l.url).replace('{s}', (l.sub || 'a')[0]).replace('{z}', z).replace('{x}', x).replace('{y}', y); }
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
    $('#dlInfo').innerHTML = `Шар «${l.name}» не можна завантажувати наперед — так вимагають сервери OpenStreetMap (переглянуте все одно зберігається).` +
      ` Для офлайну підходять «Топо», «Супутник» і «Гібрид».<br><button class="btn primary mini" id="toTopo">Перемкнути на «Топо»</button>`;
    const t = $('#toTopo');
    if (t) t.onclick = () => { setLayer('topo'); renderMapTab(); toast('🗺️ Шар «Топо» — тепер можна завантажити', 'good'); };
    btn.disabled = true; return;
  }
  const perTile = (l.url.includes('World_Imagery') ? 22 : 14) + (l.over || []).length * 5; // приблизно, КБ
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
      for (const u of [l.url, ...(l.over || [])]) {
      const url = tileUrl(l, z, x, y, u), key = tileKey(url);
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
      }
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
  seg($('#radiusSeg'), [[1, '1 км'], [3, '3 км'], [10, '10 км']], S.settings.radius, (v) => { S.settings.radius = +v; saveSettings(); updateDlInfo(); });
  seg($('#zoomSeg'), [[16, 'Звичайно'], [17, 'Детально'], [18, 'Максимум']], S.settings.zmax, (v) => { S.settings.zmax = +v; saveSettings(); updateDlInfo(); });
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
    // пройдене не стираємо - воно йде в архів, а на карті слід починається заново
    const txt = `Пройдене (${fmtDist(S.track.dist)}) збережеться в архів, а слід на карті почнеться з цього місця. Запис триває.`;
    if (!(await confirmBox('Очистити карту?', txt, 'Очистити'))) return;
    if (!S.track) return;
    pullRec();
    const done = Object.assign({}, S.track, { id: S.track.id + 'c' + Date.now().toString(36), end: Date.now(), pts: S.track.pts.slice() });
    delete done.turnI; delete done.turnPend; delete done.nn;
    autoTravel(done);
    archiveTrack(done);
    S.track.pts = []; S.track.dist = 0; S.track.start = Date.now(); S.track.turnI = null;   // запис не уриваємо
    drawLive();
    if (S.pos && !S.nrecOk) recordPoint();
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
  toast((hasTrack ? 'Пройдене збережено в архів · ' : '') + (hadTgt ? 'точка лишилась у списку' : 'карту очищено'), 'good');
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
  const e = $('#updSub2'); if (e) e.textContent = t;
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
  box.open = false;                 // для новачка є вікно при першому запуску; тут - довідка на потім
  void used;
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
  const body = $('#sheet .sheet-body'); if (body) body.scrollTop = 0;   // нова вкладка - з початку
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
  else startTrackUi();
};
$('#navBtn').onclick = () => (S.navOpen ? closeNav() : openNav());
$('#navClose').onclick = closeNav;
$('#pTarget').onclick = () => (target() ? openNav() : openSheet('points'));
$('#fabMe').onclick = () => {
  endOverview(); S.userZoom = false;          // ◎ - назад до ведення з автомасштабом
  setFollow(true);
  if (!S.pos) { toast('Шукаю GPS…'); return; }
  if (S.navOpen && target()) navFrame(true);
  else map.setView([S.pos.lat, S.pos.lon], Math.max(map.getZoom(), 16));
};
$('#fabFit').onclick = () => {
  // під час ведення ⤢ показує весь маршрут до цілі (доки не натиснеш ◎)
  if (S.navOpen && target()) { setFollow(true); routeOverview(0); toast('Весь маршрут · ◎ — назад до ведення'); return; }
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
    placeCar(pk.lat, pk.lon, { auto: 'car' });       // та сама єдина «Машина», що й з телефона
    toast('🚗 Місце машини збережено — вона тепер ціль', 'good');
  }
  if (ack.trips.length || ack.parking) { try { WayBackNative.ack(JSON.stringify(ack)); } catch (e) { /* */ } }
}
window.wbNativePull = wbNativePull;
/** Кнопка «Назад» на Android: закрити відкриту панель. false — закривати нічого. */
window.wbBack = () => {
  if (!$('#rp').classList.contains('hidden')) { closeReplay(); return true; }
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

/* ---------- «Іншою дорогою» (місто) ----------
   Повернутися не тим шляхом, яким прийшов, а іншими вулицями. Беремо кілька варіантів
   маршруту (OSRM дає альтернативи) і обираємо той, що найменше збігається зі слідом «туди».
   Якщо всі варіанти йдуть тією самою вулицею - пробуємо обхід через точку збоку від сліду.
   «Туди» - це слід до моменту, коли ввімкнули цей режим: дорога назад у нього не входить. */
const ALT_NEAR = 25;              // ближче за стільки метрів до сліду - вважаємо ту саму вулицю
const ALT_LONGER = 1.8;           // інша дорога може бути довшою за найкоротшу щонайбільше у стільки разів
function altOutbound() {
  if (!S.track || !S.track.pts || S.track.pts.length < 2) return null;
  if (S.altBase == null || S.altBaseId !== S.track.id) { S.altBase = S.track.pts.length; S.altBaseId = S.track.id; }
  const pts = S.track.pts.slice(0, S.altBase).filter(Boolean).map((p) => [p[0], p[1]]);
  return pts.length > 1 ? pts : null;
}
/** Яка частка довжини маршруту лежить уздовж сліду «туди». */
function overlapShare(path, trk) {
  if (!trk) return 0;
  let total = 0, near = 0;
  for (let i = 1; i < path.length; i++) {
    const d = dist(path[i - 1], path[i]); if (!d) continue;
    const mid = [(path[i - 1][0] + path[i][0]) / 2, (path[i - 1][1] + path[i][1]) / 2];
    total += d; if (nearestOnPath(trk, mid).d <= ALT_NEAR) near += d;
  }
  return total ? near / total : 0;
}
/** Точка на відстані m метрів від p у напрямку brg. */
function destPoint(p, brg, m) {
  const d = m / R, b = rad(brg), la = rad(p[0]), lo = rad(p[1]);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [deg(la2), deg(lo2)];
}
/** Точка на ламаній на частці f її довжини. */
function alongPath(pts, f) {
  const want = pathLen(pts) * f; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (acc + d >= want && d) { const k = (want - acc) / d; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; }
    acc += d;
  }
  return pts[pts.length - 1];
}
async function osrmRoutes(coords, alts) {
  const u = TRAV().osrm + coords.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';')
    + `?overview=full&geometries=geojson&alternatives=${alts ? 3 : 'false'}&steps=false&generate_hints=false`;
  const r = await httpGet(u, 12000);
  if (r.status === 429 || r.status >= 500) throw busyErr(r.status);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.code && j.code !== 'Ok') throw new Error(j.code);
  return (j.routes || []).map((rt) => ({ path: rt.geometry.coordinates.map((c) => [c[1], c[0]]), len: rt.distance }))
    .filter((c) => c.path.length > 1);
}
async function fetchAltRoute(from, to) {
  const trk = altOutbound();
  if (routeAbort) { routeAbort.abort(); routeAbort = null; }
  let cands = [];
  try { cands = await osrmRoutes([from, to], true); } catch (e) { if (e && e.name === 'AbortError') throw e; }
  if (!cands.length) {                      // OSRM не відповів - звичайний маршрут через Valhalla
    const r = await fetchRoute(from, to);
    cands = [{ path: r.path, len: r.len, via: r.via }];
  }
  const base = Math.min(...cands.map((c) => c.len || pathLen(c.path)));
  const score = (c) => { c.len = c.len || pathLen(c.path); c.ov = overlapShare(c.path, trk); return c; };
  const pickBest = () => {
    const ok = cands.filter((c) => c.len <= base * ALT_LONGER + 300);
    return (ok.length ? ok : cands).reduce((a, b) => (b.ov < a.ov - 0.05 || (Math.abs(b.ov - a.ov) <= 0.05 && b.len < a.len) ? b : a));
  };
  cands.forEach(score);
  let best = pickBest();
  if (trk && best.ov > 0.35) {
    // усі варіанти - тією самою вулицею: обхід через точку збоку від середини сліду «туди»
    const mid = alongPath(trk, 0.5), brg = bearing(from, to), D = Math.min(700, Math.max(150, dist(from, to) * 0.25));
    for (const k of [1, 1.8]) {
      for (const side of [90, -90]) {
        try { const r = await osrmRoutes([from, destPoint(mid, brg + side, D * k), to], false); if (r[0]) cands.push(score(r[0])); }
        catch (e) { if (e && e.name === 'AbortError') throw e; }
      }
      best = pickBest();
      if (best.ov <= 0.35) break;
    }
  }
  return { path: best.path, len: best.len, snap: [], via: best.via || 'OSRM', ov: trk ? best.ov : null };
}

/* ---------- відтворення маршруту 2D / 3D ----------
   Як у Garmin: маркер біжить по сліду, пройдене - яскраво-червоне, решта - бліда.
   2D - карта північчю вгору. 3D - карта нахилена, камера летить за маркером у напрямку руху.
   Довгі стоянки (затор, світлофор) стискаються, щоб не чекати. 1× - увесь маршрут
   приблизно за хвилину, далі 2×, 4×, 8×. Карта - MapLibre: вантажиться лише тут,
   лежить поруч із застосунком (є і в APK), плитки - ті самі, що в основній карті. */
const RP = { map: null, marker: null, P: null, pt: null, cum: null, T: 0, total: 0, t: 0,
             play: false, raf: 0, last: 0, speed: 1, dim: LS.get('rpDim', 2) === 3 ? 3 : 2, hd: null, follow: true };
const RP_SPEEDS = [1, 2, 4, 8], RP_BASE_S = 60;
const RP_RED = '#f2495c', RP_DIM = 'rgba(242, 73, 92, 0.32)';
let mlLoad = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (!mlLoad) {
    mlLoad = new Promise((ok, bad) => {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'maplibre-gl.css'; document.head.appendChild(l);
      const s = document.createElement('script'); s.src = 'maplibre-gl.js';
      s.onload = () => ok(); s.onerror = () => { mlLoad = null; bad(new Error('maplibre')); };
      document.head.appendChild(s);
    });
  }
  return mlLoad;
}
function rpStyle() {
  const l = LAYERS[S.settings.layer] || LAYERS.osm;
  const tiles = (u, sub) => (u.includes('{s}') ? (sub || 'abc').split('').map((x) => u.replace('{s}', x)) : [u]);
  const sources = { base: { type: 'raster', tiles: tiles(l.url, l.sub), tileSize: 256, maxzoom: l.max, attribution: l.attr } };
  const layers = [{ id: 'base', type: 'raster', source: 'base' }];
  (l.over || []).forEach((u, i) => {
    sources['o' + i] = { type: 'raster', tiles: tiles(u, 'abc'), tileSize: 256, maxzoom: l.max };
    layers.push({ id: 'o' + i, type: 'raster', source: 'o' + i });
  });
  return { version: 8, sources, layers };
}
/** Шкала відтворення: стоянки й пропуски GPS стискаємо, рух лишаємо як був. */
function rpPrep(tr) {
  const P = tr.pts.filter(Boolean).map((p) => [p[0], p[1], p[2]]);
  const pt = [0], cum = [0];
  for (let i = 1; i < P.length; i++) {
    const d = dist(P[i - 1], P[i]);
    let dt = Math.max(0, (P[i][2] - P[i - 1][2]) / 1000);
    if (d < 4 && dt > 1.5) dt = 1.5;                       // стоїш (затор, світлофор)
    dt = Math.min(dt, Math.max(2, d / 1.2), 60);           // пропуск GPS - не чекаємо
    pt.push(pt[i - 1] + Math.max(dt, 0.05)); cum.push(cum[i - 1] + d);
  }
  return { P, pt, cum, T: pt[pt.length - 1], total: cum[cum.length - 1] };
}
function rpIdx(arr, v) {
  let lo = 0, hi = arr.length - 1;
  if (v <= arr[0]) return [0, 0];
  if (v >= arr[hi]) return [Math.max(0, hi - 1), 1];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m; else hi = m; }
  return [lo, (v - arr[lo]) / ((arr[lo + 1] - arr[lo]) || 1)];
}
function rpLerp(i, f) {
  const a = RP.P[i], b = RP.P[Math.min(i + 1, RP.P.length - 1)];
  return { ll: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], time: a[2] + (b[2] - a[2]) * f,
           d: RP.cum[i] + (RP.cum[Math.min(i + 1, RP.P.length - 1)] - RP.cum[i]) * f };
}
const rpAtDist = (d) => { const [i, f] = rpIdx(RP.cum, d); return rpLerp(i, f).ll; };
function rpSpeedAt(i) {          // км/год за кілька точок довкола - щоб цифра не стрибала
  const a = Math.max(0, i - 3), b = Math.min(RP.P.length - 1, i + 3);
  const dt = (RP.P[b][2] - RP.P[a][2]) / 1000;
  return dt > 0 ? (RP.cum[b] - RP.cum[a]) / dt * 3.6 : 0;
}
const rpGrad = (f) => ['step', ['line-progress'], RP_RED, Math.min(0.99999, Math.max(1e-5, f)), RP_DIM];
const rpClock = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function rpRender(moveCam) {
  if (!RP.map || !RP.P) return;
  const [i, f] = rpIdx(RP.pt, RP.t), p = rpLerp(i, f);
  // напрям - з відрізка трохи позаду й попереду: на поворотах камера не смикається
  const h = RP.total > 5 ? bearing(rpAtDist(Math.max(0, p.d - 12)), rpAtDist(Math.min(RP.total, p.d + 30))) : 0;
  RP.hd = RP.hd == null ? h : (RP.hd + angDiff(h, RP.hd) * 0.12 + 360) % 360;
  RP.marker.setLngLat([p.ll[1], p.ll[0]]).setRotation(RP.hd);
  if (RP.map.getLayer('trk')) RP.map.setPaintProperty('trk', 'line-gradient', rpGrad(RP.total ? p.d / RP.total : 0));
  if (moveCam && RP.follow) {
    const o = { center: [p.ll[1], p.ll[0]] };
    if (RP.dim === 3) { o.bearing = RP.hd; o.pitch = 60; }
    RP.map.jumpTo(o);
  }
  $('#rpClock').textContent = rpClock(p.time);
  $('#rpDist').textContent = fmtDist(p.d);
  $('#rpSpd').textContent = Math.round(rpSpeedAt(i)) + ' км/год';
  $('#rpSeek').value = String(Math.round(RP.T ? RP.t / RP.T * 1000 : 0));
  $('#rpT0').textContent = fmtDur(p.time - RP.P[0][2]);
}
function rpFrame(now) {
  if (!RP.play) return;
  const dt = Math.min(0.1, (now - RP.last) / 1000); RP.last = now;
  RP.t = Math.min(RP.T, RP.t + dt * RP.T / RP_BASE_S * RP.speed);
  rpRender(true);
  if (RP.t >= RP.T) { rpPause(); setTimeout(() => rpOverview(false), 700); return; }
  RP.raf = requestAnimationFrame(rpFrame);
}
function rpPlay() {
  if (!RP.map) return;
  if (RP.t >= RP.T) RP.t = 0;
  RP.play = true; RP.follow = true; $('#rpPlay').textContent = '❚❚'; $('#rpPlay').setAttribute('aria-label', 'Пауза');
  const p = rpLerp(...rpIdx(RP.pt, RP.t));
  RP.map.easeTo({ center: [p.ll[1], p.ll[0]], zoom: Math.max(16, Math.min(17, RP.map.getZoom() + 2)),
                  pitch: RP.dim === 3 ? 60 : 0, bearing: RP.dim === 3 ? (RP.hd || 0) : 0, duration: 700 });
  setTimeout(() => { if (RP.play) { RP.last = performance.now(); cancelAnimationFrame(RP.raf); RP.raf = requestAnimationFrame(rpFrame); } }, 720);
  wake(true);
}
function rpPause() {
  RP.play = false; cancelAnimationFrame(RP.raf);
  const b = $('#rpPlay'); b.textContent = '▶'; b.setAttribute('aria-label', 'Відтворити');
}
function rpOverview(instant) {
  if (!RP.map || !RP.P) return;
  RP.follow = false;
  const b = new maplibregl.LngLatBounds();
  RP.P.forEach((p) => b.extend([p[1], p[0]]));
  const bot = ($('.rp-bot') ? $('.rp-bot').offsetHeight : 180) + 20;
  RP.map.fitBounds(b, { padding: { top: 80, bottom: bot, left: 30, right: 30 }, pitch: RP.dim === 3 ? 45 : 0,
                        bearing: 0, maxZoom: 17, duration: instant ? 0 : 900 });
}
async function openReplay(tr) {
  if (!tr || !tr.pts || tr.pts.filter(Boolean).length < 2) { toast('Замало точок, щоб відтворити маршрут', 'warn'); return; }
  $('#rp').classList.remove('hidden');
  $('#rpName').textContent = `${fmtDate(tr.start)}${tr.target ? ' · ' + tr.target : ''} · ${fmtDist(tr.dist)}`;
  $('#rpDim').querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.d === RP.dim));
  $('#rpSpeed').textContent = RP.speed + '×';
  try { await loadMapLibre(); }
  catch (e) { $('#rp').classList.add('hidden'); toast('Не вдалося відкрити карту для відтворення', 'warn'); return; }
  Object.assign(RP, rpPrep(tr), { t: 0, hd: null, follow: false, trId: tr.id });
  if (RP.map) { RP.map.remove(); RP.map = null; }
  try {
    RP.map = new maplibregl.Map({ container: 'rpMap', style: rpStyle(), center: [RP.P[0][1], RP.P[0][0]], zoom: 14,
                                  maxZoom: 19, maxPitch: 70, attributionControl: { compact: true }, fadeDuration: 0 });
  } catch (e) {
    $('#rp').classList.add('hidden'); toast('Цей телефон не вміє показувати таку карту (немає WebGL)', 'warn'); return;
  }
  const el = document.createElement('div'); el.className = 'rp-me';
  el.innerHTML = '<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="12" fill="#f2495c" stroke="#fff" stroke-width="3"/><path d="M15 6.5 L21 19 L15 16 L9 19 Z" fill="#fff"/></svg>';
  RP.marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'viewport' })
    .setLngLat([RP.P[0][1], RP.P[0][0]]).addTo(RP.map);
  RP.map.on('dragstart', () => { RP.follow = false; });
  RP.map.on('load', () => {
    RP.map.addSource('trk', { type: 'geojson', lineMetrics: true,
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: RP.P.map((p) => [p[1], p[0]]) } } });
    RP.map.addLayer({ id: 'trkCase', type: 'line', source: 'trk', layout: { 'line-join': 'round', 'line-cap': 'round' },
                      paint: { 'line-color': '#000000', 'line-opacity': 0.4, 'line-width': 8 } });
    RP.map.addLayer({ id: 'trk', type: 'line', source: 'trk', layout: { 'line-join': 'round', 'line-cap': 'round' },
                      paint: { 'line-width': 5, 'line-gradient': rpGrad(0) } });
    $('#rpT1').textContent = fmtDur(RP.P[RP.P.length - 1][2] - RP.P[0][2]);
    S.points.filter((q) => q.trk === RP.trId && !isTemp(q)).forEach((q) => {     // місця з цієї прогулянки
      const m = document.createElement('div'); m.className = 'rp-pin'; m.textContent = q.icon; m.title = q.name;
      new maplibregl.Marker({ element: m, anchor: 'bottom' }).setLngLat([q.lon, q.lat]).addTo(RP.map);
    });
    rpRender(false);
    rpOverview(true);
  });
}
function closeReplay() {
  rpPause();
  $('#rp').classList.add('hidden');
  if (RP.map) { RP.map.remove(); RP.map = null; RP.marker = null; }
  if (!S.track && !S.navOpen) wake(false);
}
$('#rpClose').onclick = closeReplay;
$('#rpPlay').onclick = () => (RP.play ? rpPause() : rpPlay());
$('#rpFit').onclick = () => { rpPause(); rpOverview(false); };
$('#rpBack').onclick = () => { RP.t = Math.max(0, RP.t - RP.T * 0.1); RP.follow = true; rpRender(true); };
$('#rpFwd').onclick = () => { RP.t = Math.min(RP.T, RP.t + RP.T * 0.1); RP.follow = true; rpRender(true); };
$('#rpSpeed').onclick = () => {
  RP.speed = RP_SPEEDS[(RP_SPEEDS.indexOf(RP.speed) + 1) % RP_SPEEDS.length];
  $('#rpSpeed').textContent = RP.speed + '×';
};
$('#rpSeek').addEventListener('input', (e) => { RP.t = (+e.target.value / 1000) * RP.T; RP.follow = true; rpRender(true); });
$('#rpDim').onclick = (e) => {
  const b = e.target.closest('button'); if (!b || !RP.map) return;
  RP.dim = +b.dataset.d; LS.set('rpDim', RP.dim);
  $('#rpDim').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  if (RP.follow || RP.play) {
    RP.map.easeTo({ pitch: RP.dim === 3 ? 60 : 0, bearing: RP.dim === 3 ? (RP.hd || 0) : 0, duration: 600 });
  } else rpOverview(false);
};

/* ---------- точки: машина одна, тимчасові й «мої місця», кошик ----------
   Тимчасові (🚗 машина, 👤 точка від друга) потрібні лише щоб повернутись: зникають самі,
   коли ти до них дійшов (через 2 години) або коли їм понад 7 днів. «Мої місця» (гриби, вода…)
   лишаються назавжди, у списку - групами за значком. Видалене 30 днів лежить у кошику. */
const TEMP_DAYS = 7, DONE_HOURS = 2, SAME_R = 30, PT_TRASH_DAYS = 30;
const GROUP_NAME = { '🍄': 'Гриби', '🏠': 'Дім', '⛺': 'Табори', '🌲': 'Ліс', '💧': 'Вода', '⭐': 'Цікаве',
                     '📍': 'Точки', '⚠️': 'Небезпека', '🎣': 'Риболовля' };
const isTemp = (p) => (p.kind ? p.kind === 'temp' : (p.icon === '🚗' || p.icon === '👤' || p.auto === 'car'));
const fmtDay = (t) => new Date(t).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
S.ptTrash = LS.get('ptTrash', []).filter((p) => Date.now() - (p.deletedAt || 0) < PT_TRASH_DAYS * 864e5);
S.grpOpen = LS.get('grpOpen', {});
const savePtTrash = () => LS.set('ptTrash', S.ptTrash);

/** Перенести точки в кошик (з них можна повернути 30 днів). */
function trashPoints(ids) {
  const set = new Set(ids); if (!set.size) return 0;
  const gone = S.points.filter((p) => set.has(p.id));
  S.points = S.points.filter((p) => !set.has(p.id));
  gone.forEach((p) => S.ptTrash.unshift(Object.assign({}, p, { deletedAt: Date.now() })));
  if (S.ptTrash.length > 60) S.ptTrash.length = 60;
  if (set.has(S.targetId)) { S.targetId = null; S.arrived = false; }
  savePtTrash(); savePoints(); renderPoints(); renderPointList(); updateAll();
  return gone.length;
}
/** Машина завжди одна: нова позначка переносить наявну, а не плодить «Машина 2». */
function placeCar(lat, lon, extra) {
  let p = S.points.find((x) => x.icon === '🚗' && isTemp(x));
  if (p) {
    p.lat = +lat.toFixed(6); p.lon = +lon.toFixed(6); p.t = Date.now(); delete p.done;
    p.trk = S.track ? S.track.id : null;
    if (extra) Object.assign(p, extra);
    S.targetId = p.id; S.arrived = false; S.wentFar = false;
    savePoints(); renderPoints(); renderPointList(); updateAll();
  } else {
    p = addPoint({ name: 'Машина', icon: '🚗', lat, lon }, true);
    if (extra) { Object.assign(p, extra); savePoints(); }
  }
  return p;
}
/** Те саме місце, що вже збережене поруч (той самий значок, ближче за 30 м)? */
async function samePlace(icon, lat, lon) {
  const near = S.points.filter((p) => !isTemp(p) && p.icon === icon)
    .map((p) => ({ p, d: dist([p.lat, p.lon], [lat, lon]) })).filter((x) => x.d <= SAME_R)
    .sort((a, b) => a.d - b.d)[0];
  if (!near) return null;
  const yes = await modal({
    title: 'Це те саме місце?',
    html: `<p class="note" style="font-size:14px;color:var(--text)">Поруч уже є ${esc(near.p.icon)} <b>«${esc(near.p.name)}»</b> — за ${Math.round(near.d)} м.<br><br>
      «Те саме» — нової точки не буде, а в цьому місці позначиться, що ти знаходив тут ще раз.</p>`,
    ok: 'Так, те саме', cancel: 'Ні, нова точка', validate: () => true,
  });
  return yes ? near.p : null;
}
/** Прибирання саме по собі: застарілі тимчасові точки - у кошик. Без питань, але з підказкою. */
function expirePoints() {
  const now = Date.now(), busy = S.targetId;   // поточна ціль сама не зникає, хіба ти до неї дійшов
  const old = S.points.filter((p) => isTemp(p) && (p.id !== busy || p.done) &&
    ((p.done && now - p.done > DONE_HOURS * 36e5) || now - (p.t || 0) > TEMP_DAYS * 864e5));
  if (old.length) { trashPoints(old.map((p) => p.id)); toast(`🧹 Прибрано тимчасових точок: ${old.length} (вони в кошику)`, 'good'); }
}
/** Одноразово для старих даних: зайві «Машина» - у кошик, точки - до прогулянок, під час яких їх поставили. */
function migratePoints() {
  if (LS.get('ptMig', 0) >= 1) return;
  const cars = S.points.filter((p) => p.icon === '🚗').sort((a, b) => (b.id === S.targetId) - (a.id === S.targetId) || (b.t || 0) - (a.t || 0));
  const extra = cars.slice(1);
  S.points.forEach((p) => {
    if (p.trk || !p.t) return;
    const tr = S.tracks.find((x) => p.t >= x.start - 60e3 && p.t <= (x.end || x.start) + 60e3);
    if (tr) p.trk = tr.id;
  });
  if (cars[0] && !cars[0].kind) cars[0].kind = 'temp';
  if (cars[0] && /^Машина \d+$/.test(cars[0].name || '')) cars[0].name = 'Машина';   // «Машина 2» - це та сама машина
  savePoints();
  if (extra.length) { trashPoints(extra.map((p) => p.id)); toast(`🚗 Залишив одну «Машину», зайвих прибрано: ${extra.length}`, 'good'); }
  LS.set('ptMig', 1);
}
function tempLeft(p) {
  if (p.done) return 'дійшов — зникне сьогодні';
  const d = Math.max(1, Math.ceil(((p.t || 0) + TEMP_DAYS * 864e5 - Date.now()) / 864e5));
  return `тимчасова · ще ${d} дн.`;
}
function ptItem(p, here) {
  const tgt = p.id === S.targetId, temp = isTemp(p), bits = [];
  if (here) bits.push(fmtDist(dist(here, [p.lat, p.lon])));
  bits.push(fmtDay(p.t));
  if ((p.visits || 1) > 1) bits.push(`знаходив ${p.visits} р.`);
  if (temp) bits.push(tempLeft(p));
  else if (p.trk && S.tracks.some((x) => x.id === p.trk)) bits.push('є прогулянка');
  return `<div class="item${tgt ? ' tgt' : ''}" data-id="${p.id}">
    <span class="i-ico">${esc(p.icon)}</span>
    <div class="i-main" data-a="show"><b>${esc(p.name)}</b><small>${bits.join(' · ')}</small></div>
    <div class="i-acts">
      <button data-a="tgt" class="${tgt ? 'on' : ''}" title="Ціль" aria-label="Зробити ціллю">🎯</button>
      ${temp ? '<button data-a="keep" title="Зберегти назавжди" aria-label="Зберегти назавжди">📌</button>'
             : '<button data-a="share" title="Поділитись" aria-label="Поділитись">📤</button>'}
      <button data-a="edit" title="Редагувати" aria-label="Редагувати">✏️</button>
      <button data-a="del" title="Видалити" aria-label="Видалити">🗑️</button>
    </div></div>`;
}
function ptTrashHtml() {
  if (!S.ptTrash || !S.ptTrash.length) return '';
  const left = (t) => Math.max(1, Math.ceil((t.deletedAt + PT_TRASH_DAYS * 864e5 - Date.now()) / 864e5));
  let h = `<button class="trash-head" data-pttrash>🗑️ Кошик точок · ${S.ptTrash.length} <span>${S.ptTrashOpen ? '▴' : '▾'}</span></button>`;
  if (S.ptTrashOpen) h += S.ptTrash.map((t) => `<div class="item trash-item" data-ptid="${t.id}">
      <span class="i-ico">${esc(t.icon)}</span>
      <div class="i-main"><b>${esc(t.name)}</b><small>${fmtDay(t.t)} · зникне через ${left(t)} дн.</small></div>
      <div class="i-acts"><button data-pt="restore" title="Повернути" aria-label="Повернути">♻️</button><button data-pt="purge" title="Стерти назавжди" aria-label="Стерти назавжди">✖️</button></div></div>`).join('');
  return h;
}
function renderPointList() {
  const el = $('#pointList');
  if (!el) return;
  const here = S.pos ? [S.pos.lat, S.pos.lon] : null;
  if (!S.points.length) {
    el.innerHTML = '<div class="empty">Ще немає точок.<br>Натисни «Старт» біля машини — точка зʼявиться автоматично.</div>' + ptTrashHtml();
    return;
  }
  const byNew = (a, b) => (b.t || 0) - (a.t || 0);
  const temp = S.points.filter(isTemp).sort(byNew);
  const groups = {};
  S.points.filter((p) => !isTemp(p)).forEach((p) => { (groups[p.icon] = groups[p.icon] || []).push(p); });
  let h = '';
  if (temp.length) h += `<div class="grp-title">Для повернення</div>` + temp.map((p) => ptItem(p, here)).join('');
  const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  if (keys.length) h += `<div class="grp-title">Мої місця</div>`;
  keys.forEach((k) => {
    const list = groups[k].sort(byNew), open = (S.grpOpen || {})[k] !== false;
    h += `<button class="grp-head" data-grp="${esc(k)}"><span class="i-ico">${esc(k)}</span><b>${esc(GROUP_NAME[k] || 'Інше')}</b><span class="grp-n">${list.length}</span><span class="grp-arr">${open ? '▴' : '▾'}</span></button>`;
    if (open) h += list.map((p) => ptItem(p, here)).join('');
  });
  h += `<button class="btn grp-clean" data-clean>🧹 Прибрати зайве</button>`;
  el.innerHTML = h + ptTrashHtml();
}
/** Що можна прибрати: старі тимчасові й дублікати поруч. Позначено - те, що варто прибрати. */
function cleanCandidates() {
  const out = [], now = Date.now(), busy = S.targetId;          // поточну ціль не пропонуємо
  S.points.filter(isTemp).forEach((p) => {
    if (p.id === busy && !p.done) return;
    const age = now - (p.t || 0);
    if (p.done || age > 864e5) out.push({ p, why: p.done ? 'ти до неї вже дійшов' : `тимчасова, їй ${Math.floor(age / 864e5)} дн.`, on: true });
  });
  const places = S.points.filter((p) => !isTemp(p));
  const seen = new Set();
  places.forEach((a) => {
    if (seen.has(a.id)) return;
    const twins = places.filter((b) => b !== a && b.icon === a.icon && !seen.has(b.id) && dist([a.lat, a.lon], [b.lat, b.lon]) <= SAME_R);
    if (!twins.length) return;
    const all = [a, ...twins].sort((x, y) => (y.visits || 1) - (x.visits || 1) || (y.t || 0) - (x.t || 0));
    const keep = all[0];
    all.forEach((x) => seen.add(x.id));
    all.slice(1).forEach((x) => out.push({ p: x, why: `те саме місце, що «${keep.name}» (${Math.round(dist([x.lat, x.lon], [keep.lat, keep.lon]))} м)`, on: true, keep: keep.id }));
  });
  return out;
}
async function cleanPoints() {
  const c = cleanCandidates();
  if (!c.length) { toast('Зайвого немає ✓ Тимчасових і дублікатів поруч не знайшов', 'good'); return; }
  const ids = await modal({
    title: '🧹 Прибрати зайве',
    html: `<p class="note" style="margin:0 0 8px">Позначене піде в кошик точок — звідти 30 днів можна повернути.</p>
      <div class="clean-list">${c.map((x, i) => `<label class="clean-row"><input type="checkbox" id="cl${i}" data-id="${x.p.id}"${x.on ? ' checked' : ''}>
        <span class="i-ico">${esc(x.p.icon)}</span><span class="clean-txt"><b>${esc(x.p.name)}</b><small>${esc(x.why)}</small></span></label>`).join('')}</div>`,
    ok: 'Прибрати', cancel: 'Скасувати',
    validate: (b) => [...b.querySelectorAll('input:checked')].map((i) => i.dataset.id),
  });
  if (!ids || !ids.length) return;
  // дублікат прибрано - його «знаходив» переходить до тієї, що лишилась
  c.forEach((x) => {
    if (!x.keep || !ids.includes(x.p.id)) return;
    const k = S.points.find((p) => p.id === x.keep); if (k) k.visits = (k.visits || 1) + (x.p.visits || 1);
  });
  const n = trashPoints(ids);
  toast(`🧹 Прибрано: ${n}. Повернути можна з кошика точок`, 'good');
}

/* ---------- init ---------- */
migratePoints();
expirePoints();
setInterval(expirePoints, 10 * 60 * 1000);
renderPoints();
if (S.track) {
  nativeRecStart(); pullRec();
  drawLive();
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
