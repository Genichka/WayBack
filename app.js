/* WayBack — повернись на точку. PWA, працює онлайн і офлайн. */
'use strict';

const APP_VERSION = '1.3.1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('wb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('wb.' + k, JSON.stringify(v)); return true; } catch (e) { toast('Не вдалося зберегти дані — памʼять заповнена', 'warn'); return false; } },
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
const DEF_SETTINGS = { v: 2, layer: 'osm', theme: 'dark', wake: true, vibrate: true, auto: true, radius: 2, zmax: 16 };
const S = {
  settings: (() => { const st = Object.assign({}, DEF_SETTINGS, LS.get('settings', {})); if (!(st.v >= 2)) { st.v = 2; st.layer = 'osm'; } return st; })(),
  points: LS.get('points', []),
  targetId: LS.get('target', null),
  track: LS.get('track', null),        // активний трек {id,start,pts:[[lat,lon,t,acc,alt]],dist}
  tracks: LS.get('tracks', []),        // історія
  pos: null,
  heading: null, headingSrc: null, lastCompass: 0,
  follow: true, firstFix: true, pendingStart: false, arrived: false, navOpen: false,
  shownTrackId: null,
};
const saveSettings = () => LS.set('settings', S.settings);
const savePoints = () => { LS.set('points', S.points); LS.set('target', S.targetId); };
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
    const close = (val) => { $('#modal').classList.add('hidden'); $('#mOk').onclick = $('#mCancel').onclick = null; resolve(val); };
    $('#mOk').onclick = () => { const v = validate ? validate($('#mBody')) : true; if (v !== false && v !== undefined) close(v); };
    $('#mCancel').onclick = () => close(null);
  });
}
const confirmBox = (title, text, ok = 'Так') => modal({ title, html: `<p class="note" style="font-size:14px;color:var(--text)">${text}</p>`, ok, validate: () => true });

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

const meIcon = L.divIcon({ className: '', html: '<div class="me"><div class="me-dir" id="meDir"></div><div class="me-dot"></div></div>', iconSize: [26, 26], iconAnchor: [13, 13] });
let meMarker = null, accCircle = null;
const trackLine = L.polyline([], { color: '#ff9830', weight: 4, opacity: .9 }).addTo(map);
const histLine = L.polyline([], { color: '#b877d9', weight: 4, opacity: .85, dashArray: '2 7' }).addTo(map);
const guideLine = L.polyline([], { color: '#73bf69', weight: 2.5, opacity: .9, dashArray: '8 8', interactive: false }).addTo(map);
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
  const b = $('#gpsBadge'); b.className = 'gps ' + state; b.querySelector('span').textContent = text;
}
function onPos(p) {
  const c = p.coords;
  S.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, t: p.timestamp || Date.now(), speed: c.speed, heading: c.heading };
  const ll = [c.latitude, c.longitude];
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
  else if (S.follow) map.panTo(ll, { animate: true });

  if (S.pendingStart && a <= 50) { S.pendingStart = false; startTrack(); }
  recordPoint();
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
$('#gpsBadge').onclick = () => (S.gpsDenied || !S.pos ? gpsHelp() : null);

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
function recordPoint() {
  const tr = S.track, p = S.pos;
  if (!tr || !p || p.acc > 40) return;
  const cur = [+p.lat.toFixed(6), +p.lon.toFixed(6), p.t, Math.round(p.acc), p.alt != null ? Math.round(p.alt) : null];
  const last = tr.pts[tr.pts.length - 1];
  if (last) {
    const d = dist(last, cur), dt = (cur[2] - last[2]) / 1000;
    if (d < Math.max(5, p.acc * 0.4)) return;
    // стрибок GPS: ігноруємо, але якщо таких 3 поспіль — значить це реальний рух (напр. авто)
    if (dt > 0 && d / dt > 15 && (S.jumps = (S.jumps || 0) + 1) < 3) return;
    S.jumps = 0;
    tr.dist += d;
  }
  tr.pts.push(cur);
  trackLine.addLatLng([cur[0], cur[1]]);
  saveTrack();
}
function startTrack() {
  if (S.gpsDenied) { gpsHelp(); return; }
  if (!S.pos) { S.pendingStart = true; toast('Чекаю сигнал GPS…'); updateTrackBtn(); return; }
  if (!target() && S.settings.auto) {
    const pt = addPoint({ name: 'Машина', icon: '🚗', lat: S.pos.lat, lon: S.pos.lon }, true);
    toast(`🚗 Точку «${pt.name}» позначено`, 'good');
  }
  S.track = { id: 't' + Date.now(), start: Date.now(), pts: [], dist: 0, target: target() ? target().name : null };
  trackLine.setLatLngs([]);
  recordPoint(); saveTrack(true);
  wake(true); vibrate(40);
  updateTrackBtn(); updateAll();
}
async function stopTrack() {
  const ok = await confirmBox('Завершити запис?', `Пройдено ${fmtDist(S.track.dist)} за ${fmtDur(Date.now() - S.track.start)}. Трек збережеться в історії.`, 'Завершити');
  if (!ok) return;
  const tr = S.track; tr.end = Date.now();
  if (tr.pts.length > 1) { S.tracks.unshift(tr); S.tracks = S.tracks.slice(0, 40); LS.set('tracks', S.tracks); }
  S.track = null; saveTrack(true);
  trackLine.setLatLngs([]);
  if (!S.navOpen) wake(false);
  updateTrackBtn(); updateAll(); toast('Трек збережено', 'good');
}
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
function pointForm(p) {
  return `<input class="inp" id="fName" maxlength="40" placeholder="Назва" value="${esc(p.name || '')}">
    <div class="emojis" id="fEmo">${EMOJIS.map((e) => `<button type="button" data-e="${e}" class="${e === p.icon ? 'on' : ''}">${e}</button>`).join('')}</div>
    ${p.coordsInput ? '<input class="inp" id="fCoord" style="margin-top:10px" placeholder="49.839700, 24.029700" inputmode="text">' : ''}
    ${p.showTarget ? `<label class="chk"><input type="checkbox" class="sw" id="fTgt" ${p.tgt ? 'checked' : ''}> Повертатись сюди (ціль)</label>` : ''}`;
}
function bindEmoji(body) {
  body.querySelector('#fEmo').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    body.querySelectorAll('#fEmo button').forEach((x) => x.classList.toggle('on', x === b));
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
    html: pointForm({ name: first ? 'Машина' : 'Точка ' + (S.points.length + 1), icon: first ? '🚗' : '🍄', showTarget: true, tgt: first || !S.targetId, coordsInput: opts.coords }),
    onOpen: (b) => { bindEmoji(b); if (!opts.coords) b.querySelector('#fName').select(); },
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
const appLink = (lat, lon, name) => `${location.origin}${location.pathname}?to=${lat.toFixed(6)},${lon.toFixed(6)}&n=${encodeURIComponent(name)}`;
function shareText(title, lat, lon, extra) {
  return `${title}${extra ? ' ' + extra : ''}\n${fmtCoord(lat, lon)}\n\n🗺 Google Maps: https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}\n🧭 Вести в WayBack: ${appLink(lat, lon, title.replace(/^\S+\s/, ''))}`;
}
function shareDialog(title, lat, lon, text) {
  const link = appLink(lat, lon, title.replace(/^\S+\s/, ''));
  modal({
    title, ok: 'Закрити', cancel: null,
    html: `<div class="qr-box"><canvas id="qrC"></canvas></div>
      <p class="note" style="text-align:center;margin:6px 0 0">Хай друг наведе камеру — точка стане в нього ціллю.<br>Працює без інтернету.</p>
      <div class="row-btns">
        <button class="btn primary" data-a="send">📤 Надіслати</button>
        <button class="btn" data-a="scan">📷 Сканувати</button>
      </div>`,
    onOpen: (b) => {
      try { QR.draw(b.querySelector('#qrC'), link, { scale: 6, quiet: 3 }); }
      catch (e) { b.querySelector('.qr-box').innerHTML = '<p class="note">QR не вміщається</p>'; }
      b.onclick = (e) => {
        const a = e.target.closest('[data-a]'); if (!a) return;
        if (a.dataset.a === 'send') shareSend(title, text);
        else { $('#mOk').click(); setTimeout(scanQr, 60); }
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

/* ---------- navigation / stats ---------- */
function updateAll() {
  const t = target(), here = S.pos ? [S.pos.lat, S.pos.lon] : null;
  let d = null, b = null;
  $('#pTargetName').textContent = t ? `${t.icon} ${t.name}` : 'До точки';
  if (t && here) {
    d = dist(here, [t.lat, t.lon]); b = bearing(here, [t.lat, t.lon]);
    guideLine.setLatLngs([here, [t.lat, t.lon]]);
  } else guideLine.setLatLngs([]);
  S.navDist = d; S.navBearing = b;
  $('#vDist').textContent = t ? fmtDist(d) : 'немає';
  $('#vAcc').textContent = S.pos ? Math.round(S.pos.acc) + ' м' : '—';
  $('#vAcc').className = 'p-val ' + (!S.pos ? '' : S.pos.acc <= 15 ? 'c-green' : S.pos.acc <= 40 ? 'c-yellow' : 'c-red');
  updateTimer();

  // прибуття
  if (d != null) {
    const near = d <= Math.max(15, (S.pos.acc || 0) * 0.8);
    if (near && !S.arrived) { S.arrived = true; vibrate([200, 100, 200]); if (S.navOpen) toast('🎉 Ти на місці!', 'good'); }
    else if (!near && d > 40) S.arrived = false;
  }
  if (S.navOpen) renderNav();
  updateHeadingUi();
}
function updateTimer() {
  if (S.track) {
    $('#vWalk').textContent = fmtDist(S.track.dist);
    $('#vTime').textContent = fmtDur(Date.now() - S.track.start);
  } else { $('#vWalk').textContent = '—'; $('#vTime').textContent = '—'; }
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
}

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
  $('#navSub').textContent = `азимут ${Math.round(S.navBearing)}° · ${dirName(S.navBearing)}`;
  if (hasH) {
    hint.innerHTML = S.headingSrc === 'compass' ? 'Тримай телефон горизонтально. Іди за зеленою стрілкою.' : 'Напрям за рухом GPS — іди рівно, стрілка уточниться.';
  } else if (needsCompassPermission() && !compassBound) {
    hint.innerHTML = 'Компас вимкнено.<br><button class="btn primary" id="cmpBtn">Увімкнути компас</button>';
    $('#cmpBtn').onclick = () => enableCompass();
  } else {
    hint.innerHTML = 'Компас недоступний: стрілка показує напрям відносно <b style="color:var(--red)">N</b> (півночі). Почни йти — напрям візьмемо з GPS.';
  }
}
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

function openNav() {
  if (!target()) { toast('Спочатку познач точку', 'warn'); return; }
  S.navOpen = true; $('#nav').classList.remove('hidden'); $('#navBtn').classList.add('on');
  enableCompass(); wake(true);
  const t = target();
  if (S.pos) { setFollow(false); map.fitBounds(L.latLngBounds([[S.pos.lat, S.pos.lon], [t.lat, t.lon]]).pad(0.25), { paddingBottomRight: [0, 200], maxZoom: 17 }); }
  renderNav(); renderCompass();
}
function closeNav() {
  S.navOpen = false; $('#nav').classList.add('hidden'); $('#navBtn').classList.remove('on');
  if (!S.track) wake(false);
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function wake(on) {
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

/* ---------- tracks history ---------- */
function renderTrackList() {
  const el = $('#trackList');
  let html = '';
  if (S.track) {
    html += `<div class="item tgt"><span class="i-ico">🔴</span><div class="i-main"><b>Поточний запис</b><small>${fmtDist(S.track.dist)} · ${fmtDur(Date.now() - S.track.start)} · ${S.track.pts.length} т.</small></div>
      <div class="i-acts"><button data-cur="gpx" title="GPX">⬇️</button></div></div>`;
  }
  if (!S.tracks.length && !S.track) { el.innerHTML = '<div class="empty">Збережених треків ще немає</div>'; return; }
  html += S.tracks.map((t) => `<div class="item${t.id === S.shownTrackId ? ' tgt' : ''}" data-id="${t.id}">
      <span class="i-ico">🥾</span>
      <div class="i-main" data-a="show"><b>${fmtDate(t.start)}${t.target ? ' · ' + esc(t.target) : ''}</b><small>${fmtDist(t.dist)} · ${fmtDur(t.end - t.start)}</small></div>
      <div class="i-acts">
        <button data-a="show" class="${t.id === S.shownTrackId ? 'on' : ''}" title="Показати">👁️</button>
        <button data-a="gpx" title="GPX">⬇️</button>
        <button data-a="del" title="Видалити">🗑️</button>
      </div></div>`).join('');
  el.innerHTML = html;
}
$('#trackList').onclick = async (e) => {
  if (e.target.closest('[data-cur]')) { downloadGpx(S.track); return; }
  const a = e.target.closest('[data-a]'), it = e.target.closest('[data-id]'); if (!a || !it) return;
  const tr = S.tracks.find((x) => x.id === it.dataset.id); if (!tr) return;
  if (a.dataset.a === 'show') {
    if (S.shownTrackId === tr.id) { S.shownTrackId = null; histLine.setLatLngs([]); renderTrackList(); return; }
    S.shownTrackId = tr.id; histLine.setLatLngs(tr.pts.map((p) => [p[0], p[1]]));
    closeSheet(); setFollow(false); map.fitBounds(histLine.getBounds().pad(0.15));
  } else if (a.dataset.a === 'gpx') downloadGpx(tr);
  else if (a.dataset.a === 'del') {
    if (!(await confirmBox('Видалити трек?', `${fmtDate(tr.start)} · ${fmtDist(tr.dist)}`, 'Видалити'))) return;
    S.tracks = S.tracks.filter((x) => x.id !== tr.id); LS.set('tracks', S.tracks);
    if (S.shownTrackId === tr.id) { S.shownTrackId = null; histLine.setLatLngs([]); }
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
const MAX_TILES = 5000;
function dlPlan() {
  const l = LAYERS[S.settings.layer], c = map.getCenter();
  const zmax = Math.min(S.settings.zmax, l.max);
  return { l, list: tileList(c.lat, c.lng, S.settings.radius, 11, zmax), zmax };
}
function updateDlInfo() {
  if ($('#sheet').classList.contains('hidden')) return;
  const { l, list, zmax } = dlPlan();
  const btn = $('#dlBtn');
  if (!l.dl) { $('#dlInfo').innerHTML = `Шар «${l.name}» (OpenStreetMap) не дозволяє масове завантаження. Обери «Топо» або «Супутник».`; btn.disabled = true; return; }
  const mb = (list.length * (S.settings.layer === 'sat' ? 22 : 14) / 1024).toFixed(0);
  $('#dlInfo').innerHTML = `Шар <b>${l.name}</b>, масштаб 11–${zmax}: <b>${list.length}</b> плиток ≈ ${mb} МБ` + (list.length > MAX_TILES ? `<br><span class="c-red">Забагато (ліміт ${MAX_TILES}) — зменш радіус або деталізацію.</span>` : '');
  btn.disabled = list.length > MAX_TILES || dlState.running;
}
const dlState = { running: false, cancel: false };
async function downloadArea() {
  const { l, list } = dlPlan();
  if (!l.dl || list.length > MAX_TILES || !('caches' in window)) return;
  if (!navigator.onLine) { toast('Немає інтернету', 'warn'); return; }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* */ }
  const cache = await caches.open(TILE_CACHE);
  dlState.running = true; dlState.cancel = false;
  $('#dlProg').classList.remove('hidden'); $('#dlCancel').classList.remove('hidden'); $('#dlBtn').disabled = true;
  let done = 0, fail = 0, skip = 0, i = 0;
  const bar = $('#dlBar');
  const worker = async () => {
    while (i < list.length && !dlState.cancel) {
      const [z, x, y] = list[i++];
      const url = tileUrl(l, z, x, y), key = tileKey(url);
      try {
        if (await cache.match(key)) skip++;
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
  await Promise.all(Array.from({ length: 6 }, worker));
  dlState.running = false;
  $('#dlCancel').classList.add('hidden'); $('#dlBtn').disabled = false;
  toast(dlState.cancel ? 'Завантаження зупинено' : fail ? `Готово, але ${fail} плиток не вдалося` : '✅ Район збережено для офлайну', fail ? 'warn' : 'good');
  updateCacheSize();
}
async function updateCacheSize() {
  try {
    const e = await navigator.storage.estimate();
    $('#cacheSize').textContent = (e.usage / 1048576).toFixed(1) + ' МБ';
  } catch (err) { $('#cacheSize').textContent = '—'; }
}
$('#dlBtn').onclick = downloadArea;
$('#dlCancel').onclick = () => { dlState.cancel = true; };
$('#clearTiles').onclick = async () => {
  if (!(await confirmBox('Очистити кеш карт?', 'Офлайн-карти доведеться завантажити знову. Точки й треки не постраждають.', 'Очистити'))) return;
  await caches.delete(TILE_CACHE); updateCacheSize(); toast('Кеш карт очищено');
};

/* ---------- segments ---------- */
function seg(el, items, cur, onPick) {
  el.innerHTML = items.map(([v, t]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${t}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); onPick(b.dataset.v); };
}
function renderMapTab() {
  seg($('#layerSeg'), Object.entries(LAYERS).map(([k, l]) => [k, l.name]), S.settings.layer, (v) => { setLayer(v); updateDlInfo(); });
  seg($('#radiusSeg'), [[1, '1 км'], [2, '2 км'], [3, '3 км'], [5, '5 км']], S.settings.radius, (v) => { S.settings.radius = +v; saveSettings(); updateDlInfo(); });
  seg($('#zoomSeg'), [[15, 'Базова'], [16, 'Добра'], [17, 'Макс']], S.settings.zmax, (v) => { S.settings.zmax = +v; saveSettings(); updateDlInfo(); });
  updateDlInfo(); updateCacheSize();
}
$('#shareBtn').onclick = shareHere;
$('#fabLayer').onclick = () => {
  const keys = Object.keys(LAYERS), next = keys[(keys.indexOf(S.settings.layer) + 1) % keys.length];
  setLayer(next); toast('Карта: ' + LAYERS[next].name);
};

/* ---------- settings ---------- */
function renderSettings() {
  seg($('#themeSeg'), [['dark', 'Темна'], ['light', 'Світла']], S.settings.theme, (v) => { S.settings.theme = v; saveSettings(); applyTheme(); });
  $('#setWake').checked = S.settings.wake; $('#setVib').checked = S.settings.vibrate; $('#setAuto').checked = S.settings.auto;
  $('#verNote').textContent = `WayBack v${APP_VERSION}`;
}
$('#setWake').onchange = (e) => { S.settings.wake = e.target.checked; saveSettings(); if (!e.target.checked) wake(false); else if (S.track || S.navOpen) wake(true); };
$('#setVib').onchange = (e) => { S.settings.vibrate = e.target.checked; saveSettings(); };
$('#setAuto').onchange = (e) => { S.settings.auto = e.target.checked; saveSettings(); };
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
  let np = 0;
  doc.querySelectorAll('wpt').forEach((w) => {
    const n = w.querySelector('name'); addPoint({ name: n ? n.textContent.slice(0, 40) : 'Точка', icon: '📍', lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon') }); np++;
  });
  const pts = [...doc.querySelectorAll('trkpt, rtept')].map((p, i) => {
    const t = p.querySelector('time'), e = p.querySelector('ele');
    return [+p.getAttribute('lat'), +p.getAttribute('lon'), t ? Date.parse(t.textContent) : Date.now() + i * 1000, 0, e ? Math.round(+e.textContent) : null];
  });
  if (pts.length > 1) {
    let d = 0; for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
    S.tracks.unshift({ id: 't' + Date.now(), start: pts[0][2], end: pts[pts.length - 1][2], pts, dist: d, target: 'імпорт GPX' });
    LS.set('tracks', S.tracks);
  }
  toast(`GPX: ${np} точок, ${pts.length > 1 ? 1 : 0} трек`, 'good');
}
$('#updateBtn').onclick = async () => {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) { toast('Офлайн-режим ще не активний'); return; }
  try { await reg.update(); } catch (e) { toast('Немає звʼязку з сервером', 'warn'); return; }
  if (reg.installing || reg.waiting) { toast('Оновлення знайдено — перезапускаю…', 'good'); setTimeout(() => location.reload(), 1500); }
  else toast('У тебе остання версія ✓', 'good');
};

/* ---------- sheet ---------- */
function openSheet(tab) {
  $('#sheet').classList.remove('hidden');
  showTab(tab || 'points');
}
function closeSheet() { $('#sheet').classList.add('hidden'); }
function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + tab));
  if (tab === 'points') renderPointList();
  if (tab === 'map') renderMapTab();
  if (tab === 'tracks') renderTrackList();
  if (tab === 'settings') renderSettings();
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
$('#sheet').onclick = (e) => { if (e.target.closest('[data-close]')) closeSheet(); };
$('#menuBtn').onclick = () => openSheet();
$('#addHereBtn').onclick = () => { closeSheet(); markHere(); };
$('#scanBtn').onclick = () => { closeSheet(); setTimeout(scanQr, 120); };
$('#addCoordBtn').onclick = () => { closeSheet(); newPointDialog(0, 0, { coords: true }); };

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
  if (S.pos) map.setView([S.pos.lat, S.pos.lon], Math.max(map.getZoom(), 16)); else toast('Шукаю GPS…');
};
$('#fabFit').onclick = () => {
  const ll = S.points.map((p) => [p.lat, p.lon]);
  if (S.pos) ll.push([S.pos.lat, S.pos.lon]);
  if (S.track) S.track.pts.forEach((p) => ll.push([p[0], p[1]]));
  if (!ll.length) return;
  setFollow(false);
  if (ll.length === 1) map.setView(ll[0], 16); else map.fitBounds(L.latLngBounds(ll).pad(0.15), { maxZoom: 17 });
};

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
if (!needsCompassPermission()) bindCompass();

window.addEventListener('online', () => toast('🌐 Інтернет є'));
window.addEventListener('offline', () => toast('📴 Офлайн — працюю з кешованою картою', 'warn'));

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
