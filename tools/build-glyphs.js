#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP_JS = path.join(ROOT, "js", "app.js");
const FONTS_DIR = path.join(ROOT, "fonts", "source");
const PREVIEW_DIR = path.join(ROOT, "tools", "preview");
const APPLY = process.argv.includes("--apply");

const FONT_FILES = {
  Noia: "OpenFeelings-Noia.otf",
  Tristezza: "OpenFeelings-Tristezza.otf",
  Felicita: "OpenFeelings-Felicita.otf",
  Sorpresa: "OpenFeelings-Sorpresa.otf",
  Ansia: "OpenFeelings-Ansia.otf",
  Rabbia: "OpenFeelings-Rabbia.otf",
};

const DEGEN_AREA = 5;
const CHARS_PER_BAND = 12;
const MIX_T = [0, 0.25, 0.5, 0.75, 1];

const warnings = [];
function warn(msg) {
  warnings.push(msg);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function loadApp() {
  const text = fs.readFileSync(APP_JS, "utf8");
  const lines = text.split("\n");
  const dataLine = lines.find((l) => l.startsWith("const NEO_DATA = "));
  if (!dataLine) throw new Error("riga 'const NEO_DATA' non trovata in js/app.js");
  const bundleLine = lines.find((l) => l.startsWith("!function(") && l.includes("opentype") && l.length > 50000);
  if (!bundleLine) throw new Error("bundle opentype.js non trovato in js/app.js");
  const s = dataLine.indexOf("{");
  const e = dataLine.lastIndexOf("}");
  const data = JSON.parse(dataLine.slice(s, e + 1));
  eval(bundleLine);
  const opentype = module.exports;
  if (typeof opentype.loadSync !== "function") throw new Error("bundle opentype.js non valido");
  return { text, data, opentype };
}

function flattenPath(commands) {
  const out = [];
  let cur = null;
  let px = 0;
  let py = 0;

  function push(x, y) {
    if (!cur) cur = [];
    const last = cur[cur.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-7 && Math.abs(last[1] - y) < 1e-7) return;
    cur.push([x, y]);
  }

  function closeContour() {
    if (cur && cur.length > 2) {
      const first = cur[0];
      const last = cur[cur.length - 1];
      if (Math.abs(first[0] - last[0]) < 1e-7 && Math.abs(first[1] - last[1]) < 1e-7) cur.pop();
      if (cur.length > 2) out.push(cur);
    }
    cur = null;
  }

  for (const c of commands) {
    if (c.type === "M") {
      closeContour();
      cur = [];
      push(c.x, c.y);
      px = c.x;
      py = c.y;
    } else if (c.type === "L") {
      push(c.x, c.y);
      px = c.x;
      py = c.y;
    } else if (c.type === "H") {
      push(c.x, py);
      px = c.x;
    } else if (c.type === "V") {
      push(px, c.y);
      py = c.y;
    } else if (c.type === "Q") {
      const x0 = px;
      const y0 = py;
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        push(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
      }
      px = c.x;
      py = c.y;
    } else if (c.type === "C") {
      const x0 = px;
      const y0 = py;
      const len =
        Math.hypot(c.x1 - x0, c.y1 - y0) +
        Math.hypot(c.x2 - c.x1, c.y2 - c.y1) +
        Math.hypot(c.x - c.x2, c.y - c.y2);
      const n = Math.max(10, Math.min(64, Math.ceil(len / 6)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        push(
          u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y
        );
      }
      px = c.x;
      py = c.y;
    } else if (c.type === "Z" || c.type === "z") {
      closeContour();
    }
  }
  closeContour();
  return out;
}

function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    const r = pts[(i + 1) % pts.length];
    s += (r[0] - q[0]) * (r[1] + q[1]);
  }
  return s / 2;
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

function pairContours(oldCs, newCs) {
  const n = oldCs.length;
  const oc = oldCs.map(centroid);
  const nc = newCs.map(centroid);
  const oa = oldCs.map((c) => Math.max(1, Math.abs(signedArea(c))));
  const na = newCs.map((c) => Math.max(1, Math.abs(signedArea(c))));
  const cost = [];
  for (let i = 0; i < n; i++) {
    cost.push([]);
    for (let j = 0; j < n; j++) {
      const d = Math.hypot(oc[i][0] - nc[j][0], oc[i][1] - nc[j][1]);
      cost[i].push(d + 50 * Math.abs(Math.log(na[j] / oa[i])));
    }
  }
  if (n <= 7) {
    let best = null;
    let bestSum = Infinity;
    const used = new Array(n).fill(false);
    const assign = new Array(n);
    function rec(i, sum) {
      if (sum >= bestSum) return;
      if (i === n) {
        bestSum = sum;
        best = assign.slice();
        return;
      }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        used[j] = true;
        assign[i] = j;
        rec(i + 1, sum + cost[i][j]);
        used[j] = false;
      }
    }
    rec(0, 0);
    return { map: best, cost: bestSum };
  }
  const usedNew = new Array(n).fill(false);
  const map = new Array(n);
  for (let step = 0; step < n; step++) {
    let bi = -1;
    let bj = -1;
    let bv = Infinity;
    for (let i = 0; i < n; i++) {
      if (map[i] !== undefined) continue;
      for (let j = 0; j < n; j++) {
        if (usedNew[j]) continue;
        if (cost[i][j] < bv) {
          bv = cost[i][j];
          bi = i;
          bj = j;
        }
      }
    }
    map[bi] = bj;
    usedNew[bj] = true;
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += cost[i][map[i]];
  return { map, cost: total };
}

function resampleClosed(pts, n) {
  const m = pts.length;
  const seg = new Array(m);
  let total = 0;
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % m];
    seg[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += seg[i];
  }
  if (!(total > 0)) throw new Error("contorno con lunghezza zero");
  const out = new Array(n);
  let si = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (si < m - 1 && acc + seg[si] < target) {
      acc += seg[si];
      si++;
    }
    let t = seg[si] > 0 ? (target - acc) / seg[si] : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const a = pts[si];
    const b = pts[(si + 1) % m];
    out[k] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  return out;
}

function phaseAlign(newPts, oldPts) {
  const n = oldPts.length;
  const ncy = centroid(newPts);
  const ocy = centroid(oldPts);
  const th = Math.atan2(oldPts[0][1] - ocy[1], oldPts[0][0] - ocy[0]);
  let k0 = 0;
  let bestA = Infinity;
  for (let k = 0; k < n; k++) {
    const a = Math.atan2(newPts[k][1] - ncy[1], newPts[k][0] - ncy[0]);
    let d = Math.abs(a - th);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < bestA) {
      bestA = d;
      k0 = k;
    }
  }
  const costs = new Array(n);
  let kmin = 0;
  costs[0] = Infinity;
  for (let k = 0; k < n; k++) {
    let cost = 0;
    let broke = false;
    for (let i = 0; i < n; i++) {
      const p = newPts[(k + i) % n];
      const q = oldPts[i];
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      cost += dx * dx + dy * dy;
      if (k > 0 && Number.isFinite(costs[kmin]) && cost > costs[kmin] * 1.05 + n * 4) {
        broke = true;
        break;
      }
    }
    costs[k] = broke ? Infinity : cost;
    if (costs[k] < costs[kmin]) kmin = k;
  }
  const tol = costs[kmin] * 1.05 + n * 4;
  let bestK = kmin;
  let bestDev = Infinity;
  for (let k = 0; k < n; k++) {
    if (costs[k] > tol) continue;
    let dev = Math.abs(k - k0);
    if (dev > n / 2) dev = n - dev;
    if (dev < bestDev) {
      bestDev = dev;
      bestK = k;
    }
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = newPts[(bestK + i) % n];
  return out;
}

function meanPointDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
  return s / a.length;
}

function convertChar(ch, oldEntries, fonts) {
  const ref = oldEntries.Noia;
  const targetCounts = ref.c.map((c) => c.length);
  const targetN = targetCounts.length;
  const entries = { Neutro: oldEntries.Neutro };

  for (const emo of Object.keys(FONT_FILES)) {
    const font = fonts[emo];
    const gi = font.charToGlyphIndex(ch);
    if (!gi) return { ok: false, reason: `${emo}: glifo mancante` };
    const glyph = font.glyphs.get(gi);
    if (!glyph || !glyph.path || !glyph.path.commands || !glyph.path.commands.length) {
      return { ok: false, reason: `${emo}: percorso glifo vuoto` };
    }
    let raw;
    try {
      raw = flattenPath(glyph.path.commands);
    } catch (err) {
      return { ok: false, reason: `${emo}: errore flatten (${err.message})` };
    }
    let kept = raw.filter((c) => Math.abs(signedArea(c)) > DEGEN_AREA);
    const droppedDeg = raw.length - kept.length;
    if (droppedDeg > 0) warn(`'${ch}' ${emo}: ${droppedDeg} contorno/i degenere/i scartato/i`);
    while (kept.length > targetN) {
      let mi = 0;
      let ma = Infinity;
      for (let i = 0; i < kept.length; i++) {
        const a = Math.abs(signedArea(kept[i]));
        if (a < ma) {
          ma = a;
          mi = i;
        }
      }
      const drop = kept.splice(mi, 1)[0];
      warn(`'${ch}' ${emo}: contorno extra (area ${Math.round(ma)}) scartato per allineamento a ${targetN} contorni`);
    }
    if (kept.length < targetN) {
      return { ok: false, reason: `${emo}: ${kept.length} contorni validi, attesi ${targetN}` };
    }
    const pairing = pairContours(ref.c, kept);
    if (!pairing.map) return { ok: false, reason: `${emo}: pairing contorni fallito` };
    if (pairing.cost / targetN > 200) {
      warn(`'${ch}' ${emo}: pairing distante (${Math.round(pairing.cost / targetN)} unità media)`);
    }
    const ordered = pairing.map.map((j) => kept[j]);
    const out = [];
    for (let i = 0; i < targetN; i++) {
      const oldC = ref.c[i];
      let nc = ordered[i];
      if (Math.sign(signedArea(nc)) !== Math.sign(signedArea(oldC))) nc = nc.slice().reverse();
      let pts;
      try {
        pts = resampleClosed(nc, oldC.length);
      } catch (err) {
        return { ok: false, reason: `${emo}: resample fallito (${err.message})` };
      }
      pts = phaseAlign(pts, oldC);
      out.push(pts.map((p) => [round2(p[0]), round2(p[1])]));
    }
    entries[emo] = Object.assign({}, oldEntries[emo], {
      c: out,
      a: typeof glyph.advanceWidth === "number" ? glyph.advanceWidth : oldEntries[emo].a,
    });
  }
  return { ok: true, entries };
}

function contourBBox(contours) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return [x0, y0, x1, y1];
}

function validate(newMasters, oldMasters, charset, emoKeys, errors, info) {
  for (const ch of charset) {
    const target = oldMasters.Noia[ch].c.map((c) => c.length).join("/");
    const counts = emoKeys.map((e) => (newMasters[e][ch].c || []).map((c) => c.length).join("/"));
    if (new Set(counts).size !== 1) {
      errors.push(`'${ch}': topologia diversa tra emozioni: ${emoKeys.map((e, i) => e + "=" + counts[i]).join(" ")}`);
      continue;
    }
    if (counts[0] !== target) {
      errors.push(`'${ch}': topologia ${counts[0]} diversa dall'originale ${target}`);
      continue;
    }
    for (const e of emoKeys) {
      const entry = newMasters[e][ch];
      if (!entry || !Number.isFinite(entry.a) || entry.a < 60 || entry.a > 1500) {
        errors.push(`'${ch}' ${e}: advance non valida (${entry && entry.a})`);
      }
      if (!entry.c || entry.c.length === 0) continue;
      for (let i = 0; i < entry.c.length; i++) {
        const c = entry.c[i];
        if (c.length !== oldMasters.Noia[ch].c[i].length) {
          errors.push(`'${ch}' ${e} contorno ${i}: ${c.length} punti, attesi ${oldMasters.Noia[ch].c[i].length}`);
        }
        for (const p of c) {
          if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
            errors.push(`'${ch}' ${e} contorno ${i}: coordinata non finita`);
            break;
          }
        }
        const oldSign = Math.sign(signedArea(oldMasters.Noia[ch].c[i]));
        const newSign = Math.sign(signedArea(c));
        if (newSign !== oldSign) errors.push(`'${ch}' ${e} contorno ${i}: winding ${newSign}, atteso ${oldSign}`);
      }
      const bb = contourBBox(entry.c);
      if (bb[0] < -150 || bb[1] < -300 || bb[2] > 950 || bb[3] > 950) {
        errors.push(`'${ch}' ${e}: bbox fuori range [${bb.map((v) => Math.round(v)).join(",")}]`);
      }
    }
    const oldAreas = oldMasters.Noia[ch].c.map((c) => Math.abs(signedArea(c)));
    const areasByEmo = emoKeys.map((e) => {
      const entry = newMasters[e][ch];
      return entry && entry.c ? entry.c.map((c) => Math.abs(signedArea(c))) : [];
    });
    for (let i = 0; i < oldAreas.length; i++) {
      const slot = areasByEmo.map((a) => a[i]).filter((v) => Number.isFinite(v));
      if (slot.length !== emoKeys.length || slot.length === 0) continue;
      const mx = Math.max(...slot);
      const mn = Math.min(...slot);
      if (mn > 0 && mx / mn > 2.5) {
        errors.push(`'${ch}' slot ${i}: aree incoerenti tra emozioni (min ${Math.round(mn)}, max ${Math.round(mx)})`);
      }
    }
    for (let i = 0; i + 1 < oldAreas.length; i++) {
      if (oldAreas[i] <= oldAreas[i + 1] * 1.15) continue;
      for (let ei = 0; ei < emoKeys.length; ei++) {
        const a = areasByEmo[ei];
        if (a && a.length > i + 1 && a[i] < a[i + 1]) {
          errors.push(`'${ch}' ${emoKeys[ei]}: contorni slot ${i}/${i + 1} scambiati (aree ${Math.round(a[i])} < ${Math.round(a[i + 1])})`);
        }
      }
    }
    for (let i = 0; i < oldAreas.length; i++) {
      let maxD = 0;
      let pairDesc = "";
      let baseMax = 0;
      for (let a = 0; a < emoKeys.length; a++) {
        for (let b = a + 1; b < emoKeys.length; b++) {
          const ea = newMasters[emoKeys[a]][ch];
          const eb = newMasters[emoKeys[b]][ch];
          if (!ea || !ea.c || !eb || !eb.c) continue;
          const ca = ea.c[i];
          const cb = eb.c[i];
          if (!ca || !cb || ca.length !== cb.length) continue;
          const d = meanPointDist(ca, cb);
          const oa = oldMasters[emoKeys[a]][ch].c[i];
          const ob = oldMasters[emoKeys[b]][ch].c[i];
          const baseD = oa && ob && oa.length === ob.length ? meanPointDist(oa, ob) : 0;
          if (d > maxD) {
            maxD = d;
            baseMax = baseD;
            pairDesc = `${emoKeys[a]}~${emoKeys[b]}`;
          }
        }
      }
      if (maxD > 0) info.push({ ch, slot: i, pair: pairDesc, d: Math.round(maxD), base: Math.round(baseMax) });
      const thr = Math.max(150, baseMax * 1.2 + 30);
      if (maxD > thr) {
        errors.push(`'${ch}' slot ${i}: corrispondenza scadente (${pairDesc} dist ${Math.round(maxD)}, base vecchia ${Math.round(baseMax)}, soglia ${Math.round(thr)})`);
      }
    }
  }
  if (JSON.stringify(newMasters.Noia[" "]) !== JSON.stringify(oldMasters.Noia[" "])) {
    errors.push("glifo spazio modificato");
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(rgb) {
  return (
    "#" +
    rgb
      .map((v) => {
        const s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
        return s.length === 1 ? "0" + s : s;
      })
      .join("")
  );
}

function lerpHex(a, b, t) {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t]);
}

function glyphPathD(contours) {
  let d = "";
  for (const c of contours) {
    d += "M" + c.map((p) => `${round2(p[0])} ${round2(p[1])}`).join(" L ") + " Z ";
  }
  return d;
}

function svgSheet({ title, rows, cols, cellFor, colsPerBand }) {
  const labelW = 110;
  const cellW = 140;
  const cellH = 168;
  const headH = 34;
  const titleH = 34;
  const bandGap = 14;
  const bandCols = colsPerBand && colsPerBand > 0 ? colsPerBand : cols.length;
  const bands = [];
  for (let i = 0; i < cols.length; i += bandCols) bands.push(cols.slice(i, i + bandCols));
  const maxBand = Math.max(...bands.map((b) => b.length), 1);
  const W = labelW + maxBand * cellW + 20;
  const bandH = headH + rows.length * cellH;
  const H = titleH + bands.length * (bandH + bandGap) + 16;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n`;
  s += `<rect width="${W}" height="${H}" fill="#ffffff"/>\n`;
  s += `<text x="${labelW}" y="22" font-family="Segoe UI, sans-serif" font-size="15" font-weight="600" fill="#1a1a1a">${esc(title)}</text>\n`;
  bands.forEach((band, bi) => {
    const bandTop = titleH + bi * (bandH + bandGap);
    band.forEach((c, ci) => {
      const x = labelW + ci * cellW + cellW / 2;
      s += `<text x="${x}" y="${bandTop + headH - 6}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="13" fill="#6b6b6b">${esc(c)}</text>\n`;
    });
    rows.forEach((row, ri) => {
      const yTop = bandTop + headH + ri * cellH;
      s += `<rect x="10" y="${yTop + 4}" width="${W - 20}" height="${cellH - 8}" fill="none" stroke="#eee"/>\n`;
      s += `<circle cx="24" cy="${yTop + 26}" r="6" fill="${row.color}"/>\n`;
      s += `<text x="36" y="${yTop + 30}" font-family="Segoe UI, sans-serif" font-size="12" fill="#1a1a1a">${esc(row.label)}</text>\n`;
      band.forEach((c, ci) => {
        const cell = cellFor(row, c, ri, ci);
        if (!cell) return;
        const tx = labelW + ci * cellW + 8;
        const ty = yTop + 118;
        s += `<g transform="translate(${tx},${ty}) scale(0.105,-0.105)">`;
        s += `<path d="${glyphPathD(cell.contours)}" fill="${cell.color}" fill-rule="evenodd"/></g>\n`;
        s += `<text x="${labelW + ci * cellW + cellW / 2}" y="${yTop + cellH - 14}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="11" fill="#999">${esc(c)}</text>\n`;
      });
    });
  });
  s += `</svg>\n`;
  return s;
}

function mixContours(ea, eb, t) {
  return ea.c.map((ca, i) =>
    ca.map((p, k) => [p[0] + (eb.c[i][k][0] - p[0]) * t, p[1] + (eb.c[i][k][1] - p[1]) * t])
  );
}

function buildPreviews(newMasters, data) {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const emotions = data.meta.emotions;
  const colorOf = {};
  for (const e of emotions) colorOf[e.id] = e.color;
  const chars = data.meta.charset.filter((c) => c !== " ");
  const band = CHARS_PER_BAND;

  const rows = emotions.map((e) => ({ id: e.id, label: e.id, color: e.color }));
  const emozioni = svgSheet({
    title: "Stili per emozione — tutte le lettere (dati convertiti — Neutro = originale)",
    rows,
    cols: chars,
    colsPerBand: band,
    cellFor: (row, ch) => {
      const entry = newMasters[row.id][ch];
      if (!entry || !entry.c.length) return null;
      return { contours: entry.c, color: row.color };
    },
  });
  fs.writeFileSync(path.join(PREVIEW_DIR, "emozioni.svg"), emozioni, "utf8");

  const fontEmos = Object.keys(FONT_FILES);
  const neuRows = [];
  for (const emo of fontEmos) {
    for (const t of MIX_T) {
      neuRows.push({
        b: emo,
        t,
        label: `Neutro × ${emo} — ${Math.round(t * 100)}%`,
        color: lerpHex(colorOf.Neutro, colorOf[emo], t),
      });
    }
  }
  const misceliNeutro = svgSheet({
    title: "Gradienti Neutro × stile (0% = Neutro puro, 100% = stile puro)",
    rows: neuRows,
    cols: chars,
    colsPerBand: band,
    cellFor: (row, ch) => {
      const ea = newMasters.Neutro[ch];
      const eb = newMasters[row.b][ch];
      if (!ea || !eb || !ea.c.length || ea.c.length !== eb.c.length) return null;
      return { contours: mixContours(ea, eb, row.t), color: row.color };
    },
  });
  fs.writeFileSync(path.join(PREVIEW_DIR, "misceli-neutro.svg"), misceliNeutro, "utf8");

  const pairs = [];
  for (let i = 0; i < fontEmos.length; i++) {
    for (let j = i + 1; j < fontEmos.length; j++) pairs.push([fontEmos[i], fontEmos[j]]);
  }
  const mixRows = pairs.map(([a, b]) => ({
    a,
    b,
    label: `${a} × ${b} — 50%`,
    color: lerpHex(colorOf[a], colorOf[b], 0.5),
  }));
  const misceli = svgSheet({
    title: "Miscela 50% tra stili nuovi (tutte le lettere)",
    rows: mixRows,
    cols: chars,
    colsPerBand: band,
    cellFor: (row, ch) => {
      const ea = newMasters[row.a][ch];
      const eb = newMasters[row.b][ch];
      if (!ea || !eb || !ea.c.length || ea.c.length !== eb.c.length) return null;
      return { contours: mixContours(ea, eb, 0.5), color: row.color };
    },
  });
  fs.writeFileSync(path.join(PREVIEW_DIR, "misceli.svg"), misceli, "utf8");

  const index = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Anteprime conversione glifi</title>
<style>body{font-family:Segoe UI,sans-serif;margin:24px;color:#1a1a1a}img{max-width:100%;border:1px solid #e8e8e8;margin:12px 0}h2{font-size:16px;margin-top:28px}</style>
</head><body>
<h1>Anteprime conversione glifi</h1>
<p>Tutte le lettere, disposte a bande da ${band} caratteri. Controlla che le lettere siano dritte e le miscel pulite (soprattutto con Neutro). Se va tutto bene, applica con <code>node tools/build-glyphs.js --apply</code>.</p>
<h2>Stili per emozione — tutte le lettere</h2><img src="emozioni.svg" alt="Stili per emozione" />
<h2>Gradienti Neutro × stile (0–100%)</h2><img src="misceli-neutro.svg" alt="Gradienti con Neutro" />
<h2>Miscel 50% tra stili nuovi</h2><img src="misceli.svg" alt="Miscel 50%" />
</body></html>
`;
  fs.writeFileSync(path.join(PREVIEW_DIR, "index.html"), index, "utf8");
}

function rewriteApp(text, data2) {
  const marker = "const NEO_DATA = ";
  const s = text.indexOf(marker);
  if (s < 0) throw new Error("marcatore NEO_DATA non trovato");
  const nl = text.indexOf("\n", s);
  if (nl < 0) throw new Error("fine riga NEO_DATA non trovata");
  const cr = text.slice(nl - 1, nl) === "\r";
  const line = marker + JSON.stringify(data2) + ";" + (cr ? "\r" : "");
  return text.slice(0, s) + line + text.slice(nl);
}

function main() {
  console.log("build-glyphs: lettura js/app.js ...");
  const { text, data, opentype } = loadApp();
  const fonts = {};
  for (const emo of Object.keys(FONT_FILES)) {
    const file = path.join(FONTS_DIR, FONT_FILES[emo]);
    if (!fs.existsSync(file)) throw new Error("font sorgente mancante: " + file);
    fonts[emo] = opentype.loadSync(file);
    console.log(`  caricato ${FONT_FILES[emo]}`);
  }

  const charset = data.meta.charset;
  const emoKeys = Object.keys(data.masters);
  const results = {};
  const converted = [];
  const fallbacks = [];

  for (const ch of charset) {
    const oldEntries = {};
    let complete = true;
    for (const e of emoKeys) {
      oldEntries[e] = data.masters[e][ch];
      if (!oldEntries[e]) complete = false;
    }
    if (ch === " " || !complete) {
      results[ch] = oldEntries;
      if (ch !== " ") fallbacks.push(`'${ch}' non convertibile (dati mancanti)`);
      continue;
    }
    const conv = convertChar(ch, oldEntries, fonts);
    if (conv.ok) {
      results[ch] = conv.entries;
      converted.push(ch);
    } else {
      results[ch] = oldEntries;
      fallbacks.push(`'${ch}': ${conv.reason}`);
    }
  }

  const newMasters = {};
  for (const e of emoKeys) {
    newMasters[e] = {};
    for (const ch of Object.keys(data.masters[e])) {
      newMasters[e][ch] = (results[ch] && results[ch][e]) || data.masters[e][ch];
    }
  }

  const errors = [];
  const info = [];
  console.log("validazione ...");
  validate(newMasters, data.masters, charset, emoKeys, errors, info);

  console.log("generazione anteprime ...");
  buildPreviews(newMasters, data);

  const data2 = Object.assign({}, data, { masters: newMasters });
  const newLen = JSON.stringify(data2).length;
  const oldLen = text.split("\n")[1].length;

  info.sort((a, b) => b.d - a.d);

  console.log("");
  console.log("=== report ===");
  console.log(`caratteri: ${charset.length} (escluso spazio: ${charset.length - 1})`);
  console.log(`convertiti ai nuovi stili: ${converted.length}`);
  console.log(`in fallback (stile originale conservato): ${fallbacks.length}`);
  for (const f of fallbacks) console.log(`  - ${f}`);
  console.log(`avvisi: ${warnings.length}`);
  for (const w of warnings.slice(0, 40)) console.log(`  - ${w}`);
  if (warnings.length > 40) console.log(`  ... e altri ${warnings.length - 40}`);
  console.log(`errori validazione: ${errors.length}`);
  for (const e of errors) console.log(`  ! ${e}`);
  console.log("corrispondenza punto-punto peggiore (vs baseline dati vecchi):");
  for (const it of info.slice(0, 5)) {
    console.log(`  ${it.ch} slot${it.slot}: ${it.pair} dist ${it.d} (vecchio ${it.base}, soglia ${Math.round(Math.max(150, it.base * 1.2 + 30))})`);
  }
  console.log(`dimensione dati: ${Math.round(oldLen / 1024)} KB -> ${Math.round(newLen / 1024)} KB`);
  console.log(`anteprime: ${path.relative(ROOT, PREVIEW_DIR)}${path.sep}index.html`);

  if (errors.length) {
    console.log("");
    console.log("VALIDAZIONE FALLITA — nessuna modifica applicata.");
    process.exit(1);
  }

  if (APPLY) {
    const out = rewriteApp(text, data2);
    fs.writeFileSync(APP_JS, out, "utf8");
    console.log("");
    console.log("APPLICATO: riga NEO_DATA di js/app.js riscritta (nessun altro file toccato).");
    console.log("Verifica con: node --check js/app.js  e  git diff --stat");
  } else {
    console.log("");
    console.log("DRY-RUN: nessun file sorgente modificato.");
    console.log("Apri tools/preview/index.html, controlla le anteprime, poi applica con:");
    console.log("  node tools/build-glyphs.js --apply");
  }
}

main();
