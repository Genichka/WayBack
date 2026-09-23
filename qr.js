/* Мінімальний генератор QR-кодів (byte mode, рівень корекції M, версії 1–10).
   Свій, без зовнішніх бібліотек — щоб працювало офлайн. */
'use strict';
const QR = (() => {
  // --- поле Галуа GF(256) ---
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 285; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsEnc(data, n) {
    const g = rsGen(n), res = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ res[0];
      res.shift(); res.push(0);
      if (f) for (let i = 0; i < n; i++) res[i] ^= mul(g[i + 1], f);
    }
    return res;
  }

  // версія: [кодів корекції на блок, [[к-сть блоків, даних у блоці], ...]] — рівень M
  const EC = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]],
    5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  const capacity = (v) => EC[v][1].reduce((s, [n, d]) => s + n * d, 0);

  function utf8(str) {
    const out = [];
    for (const b of new TextEncoder().encode(str)) out.push(b);
    return out;
  }

  function encode(text) {
    const bytes = utf8(text);
    let v = 0;
    for (let i = 1; i <= 10; i++) {
      const cci = i < 10 ? 8 : 16;
      if (capacity(i) >= Math.ceil((4 + cci + bytes.length * 8) / 8)) { v = i; break; }
    }
    if (!v) throw new Error('QR: завеликий текст');

    // потік бітів
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(4, 4);                              // режим "байти"
    push(bytes.length, v < 10 ? 8 : 16);     // довжина
    for (const b of bytes) push(b, 8);
    const total = capacity(v) * 8;
    push(0, Math.min(4, total - bits.length));         // термінатор
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    const PAD = [0xec, 0x11];
    for (let i = 0; data.length < capacity(v); i++) data.push(PAD[i % 2]);

    // блоки + корекція
    const [ecLen, groups] = EC[v];
    const dBlocks = [], eBlocks = [];
    let p = 0;
    for (const [cnt, dLen] of groups) {
      for (let i = 0; i < cnt; i++) {
        const blk = data.slice(p, p + dLen); p += dLen;
        dBlocks.push(blk); eBlocks.push(rsEnc(blk, ecLen));
      }
    }
    const out = [];
    const maxD = Math.max(...dBlocks.map((b) => b.length));
    for (let i = 0; i < maxD; i++) for (const b of dBlocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const b of eBlocks) out.push(b[i]);
    return { v, codewords: out };
  }

  const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0]; // рівень M, маски 0–7
  const VERSION_BITS = {
    7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3,
  };

  function build(text, forceMask) {
    const { v, codewords } = encode(text);
    const n = v * 4 + 17;
    const m = Array.from({ length: n }, () => new Array(n).fill(null)); // null = вільно
    const set = (r, c, val) => { if (r >= 0 && c >= 0 && r < n && c < n) m[r][c] = val; };

    // пошукові квадрати + роздільники
    for (const [br, bc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const inSq = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inSq && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(br + r, bc + c, dark ? 1 : 0);
      }
    }
    // вирівнювальні квадрати
    const al = ALIGN[v];
    for (const r of al) for (const c of al) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
        set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
    }
    // синхродоріжки
    for (let i = 8; i < n - 8; i++) { const b = i % 2 ? 0 : 1; if (m[6][i] === null) m[6][i] = b; if (m[i][6] === null) m[i][6] = b; }
    m[n - 8][8] = 1; // завжди темний

    // місця під службову інформацію (поки резервуємо)
    const reserved = Array.from({ length: n }, () => new Array(n).fill(false));
    for (let i = 0; i < 9; i++) { reserved[8][i] = true; reserved[i][8] = true; }
    for (let i = 0; i < 8; i++) { reserved[8][n - 1 - i] = true; reserved[n - 1 - i][8] = true; }
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i][n - 11 + j] = true; reserved[n - 11 + j][i] = true; }

    const free = (r, c) => m[r][c] === null && !reserved[r][c];

    // розкладання даних змійкою справа наліво
    const bitsOut = [];
    for (const b of codewords) for (let i = 7; i >= 0; i--) bitsOut.push((b >> i) & 1);
    let idx = 0, up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < n; k++) {
        const row = up ? n - 1 - k : k;
        for (const c of [col, col - 1]) if (free(row, c)) m[row][c] = idx < bitsOut.length ? bitsOut[idx++] : 0;
      }
      up = !up;
    }

    // маски
    const MASKS = [
      (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];
    const isData = (r, c) => !reserved[r][c] && dataCells[r][c];
    const dataCells = Array.from({ length: n }, () => new Array(n).fill(false));
    // позначаємо, які клітинки належать даним (вони були null до розкладання)
    // — відтворюємо: усе, що не службове і не резерв
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dataCells[r][c] = true;
    for (const [br, bc] of [[0, 0], [0, n - 7], [n - 7, 0]])
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++)
        if (br + r >= 0 && bc + c >= 0 && br + r < n && bc + c < n) dataCells[br + r][bc + c] = false;
    for (const r of al) for (const c of al) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) dataCells[r + dr][c + dc] = false;
    }
    for (let i = 0; i < n; i++) { dataCells[6][i] = false; dataCells[i][6] = false; }
    dataCells[n - 8][8] = false;

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      if (forceMask != null && mask !== forceMask) continue;
      const t = m.map((row) => row.slice());
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (isData(r, c) && MASKS[mask](r, c)) t[r][c] ^= 1;
      // службові біти
      const fmt = FORMAT_M[mask];
      for (let i = 0; i < 15; i++) {
        const bit = (fmt >> i) & 1;
        // вертикальна копія (стовпець 8)
        if (i < 6) t[i][8] = bit; else if (i < 8) t[i + 1][8] = bit; else t[n - 15 + i][8] = bit;
        // горизонтальна копія (рядок 8)
        if (i < 8) t[8][n - 1 - i] = bit; else if (i === 8) t[8][7] = bit; else t[8][14 - i] = bit;
      }
      if (v >= 7) {
        const vb = VERSION_BITS[v];
        for (let i = 0; i < 18; i++) {
          const bit = (vb >> i) & 1, r = Math.floor(i / 3), c = i % 3;
          t[r][n - 11 + c] = bit; t[n - 11 + c][r] = bit;
        }
      }
      const pen = penalty(t, n);
      if (!best || pen < best.pen) best = { pen, t };
    }
    return best.t;
  }

  function penalty(t, n) {
    let p = 0, dark = 0;
    const run = (get) => {
      for (let a = 0; a < n; a++) {
        let cnt = 1;
        for (let b = 1; b < n; b++) {
          if (get(a, b) === get(a, b - 1)) { cnt++; if (cnt === 5) p += 3; else if (cnt > 5) p += 1; }
          else cnt = 1;
        }
      }
    };
    run((a, b) => t[a][b]); run((a, b) => t[b][a]);
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const s = t[r][c] + t[r][c + 1] + t[r + 1][c] + t[r + 1][c + 1];
      if (s === 0 || s === 4) p += 3;
    }
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += t[r][c];
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  /* Малює QR у <canvas>. scale — розмір клітинки, quiet — поле в клітинках. */
  function draw(canvas, text, { scale = 6, quiet = 4, dark = '#000', light = '#fff' } = {}) {
    const m = build(text), n = m.length, size = (n + quiet * 2) * scale;
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');
    g.fillStyle = light; g.fillRect(0, 0, size, size);
    g.fillStyle = dark;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
      if (m[r][c]) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    return m.length;
  }

  return { build, draw, encode };
})();
if (typeof module !== 'undefined') module.exports = QR;
