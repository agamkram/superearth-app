/**
 * OVATION Prime 2010 electron energy, from the public regression tables
 * (Newell et al., NOAA SWPC). Place and brightness stay on NOAA's
 * visible-chance grid. This module only answers the color: soft electrons
 * are red, a few keV stays green, harder electrons pick up a little blue.
 */

const SEASONS = ["winter", "spring", "summer", "fall"];
const TYPES = ["diff", "mono", "wave"];
const NMLT = 96;
const NMLAT = 160;
const NDF = 12;
const HALF = NMLAT / 2;
const DFSTEP = 4421 / 8;
const DFMAX = DFSTEP * NDF;

const POLE_LAT = (80.7 * Math.PI) / 180;
const POLE_LON = (-72.7 * Math.PI) / 180;

function seasonWeights(doy) {
  const w = { winter: 0, spring: 0, summer: 0, fall: 0 };
  if (doy >= 79 && doy < 171) {
    w.summer = 1 - (171 - doy) / 92;
    w.spring = 1 - w.summer;
  } else if (doy >= 171 && doy < 263) {
    w.fall = 1 - (263 - doy) / 92;
    w.summer = 1 - w.fall;
  } else if (doy >= 263 && doy < 354) {
    w.winter = 1 - (354 - doy) / 91;
    w.fall = 1 - w.winter;
  } else {
    const doy0 = doy >= 354 ? doy - 365 : doy;
    w.spring = 1 - (79 - doy0) / 90;
    w.winter = 1 - w.spring;
  }
  return w;
}

function dayOfYear(when) {
  const d = when instanceof Date ? when : new Date(when);
  const y = d.getUTCFullYear();
  const noon = Date.UTC(y, d.getUTCMonth(), d.getUTCDate());
  return Math.round((noon - Date.UTC(y, 0, 0)) / 86400000);
}

function whichBin(dF) {
  let i = Math.floor(dF / DFSTEP);
  if (i < 0) i = 0;
  if (i > NDF - 1) i = NDF - 1;
  return i;
}

function correctFlux(flux, kind) {
  if (flux < 0) flux = 0;
  if (kind === "energy") {
    if (flux > 10) flux = 0.5;
    else if (flux > 5) flux = 5;
  } else if (flux > 2e9) flux = 1e9;
  else if (flux > 2e10) flux = 0;
  return flux;
}

function at(arr, iMlt, jMlat) {
  return arr[iMlt * NMLAT + jMlat];
}

function probAt(group, dF, iMlt, jMlat) {
  const b1 = at(group.b1p, iMlt, jMlat);
  const b2 = at(group.b2p, iMlt, jMlat);
  let p = b1 + b2 * dF;
  if (p < 0 || p > 1) p = p > 1 ? 1 : 0;
  if (b1 === 0 && b2 === 0) {
    const i = whichBin(dF);
    const base = (iMlt * NMLAT + jMlat) * NDF;
    p = group.prob[base + i];
    if (p === 0) {
      const i1 = i > 0 ? i - 1 : i + 2;
      const i2 = i < NDF - 1 ? i + 1 : i - 2;
      p = 0.5 * (group.prob[base + i1] + group.prob[base + i2]);
    }
  }
  return p;
}

function fluxGrid(group, kind, dF) {
  const b1 = kind === "energy" ? group.b1e : group.b1n;
  const b2 = kind === "energy" ? group.b2e : group.b2n;
  const north = new Float32Array(HALF * NMLT);
  const south = new Float32Array(HALF * NMLT);
  for (let i = 0; i < NMLT; i++) {
    for (let j = 0; j < HALF; j++) {
      const pN = probAt(group, dF, i, HALF + j);
      const pS = probAt(group, dF, i, j);
      north[j * NMLT + i] = correctFlux((at(b1, i, HALF + j) + at(b2, i, HALF + j) * dF) * pN, kind);
      south[j * NMLT + i] = correctFlux((at(b1, i, j) + at(b2, i, j) * dF) * pS, kind);
    }
  }
  return [north, south];
}

function hemiGrids(tables, weights, dF) {
  const out = {};
  for (const atype of TYPES) {
    for (const kind of ["energy", "number"]) {
      const acc = new Float32Array(HALF * NMLT);
      for (const season of SEASONS) {
        const w = weights[season];
        if (!w) continue;
        const [n, s] = fluxGrid(tables[season][atype], kind, dF);
        for (let k = 0; k < acc.length; k++) acc[k] += w * 0.5 * (n[k] + s[k]);
      }
      out[atype + ":" + kind] = acc;
    }
  }
  return out;
}

function sample(grid, mlat, mlt) {
  const a = Math.abs(mlat);
  if (a < 50.1 || a > 89.9) return 0;
  const latI = (a - 50) / (40 / 79);
  const m = ((mlt % 24) + 24) % 24;
  const mltI = (m * 95) / 24;
  const i0 = Math.floor(latI);
  const i1 = Math.min(HALF - 1, i0 + 1);
  const j0 = Math.floor(mltI) % NMLT;
  const j1 = (j0 + 1) % NMLT;
  const ty = Math.min(1, Math.max(0, latI - i0));
  const tx = Math.min(1, Math.max(0, mltI - Math.floor(mltI)));
  const g = (i, j) => grid[i * NMLT + j];
  return (
    (1 - tx) * (1 - ty) * g(i0, j0) +
    tx * (1 - ty) * g(i0, j1) +
    (1 - tx) * ty * g(i1, j0) +
    tx * ty * g(i1, j1)
  );
}

function authored(e) {
  if (e < 0.2) return [36, 200, 34];
  const ratio = 6 * Math.exp(-e / 0.85);
  let wr = ratio;
  let wg = 1;
  const wb0 = 0.45 * Math.max(0, Math.min(1, (e - 5) / 8));
  if (wr > wg) wg *= 0.35;
  const s = wr + wg + wb0;
  wr /= s;
  wg /= s;
  const wb = wb0 / s;
  return [
    36 * wg + 220 * wr + 48 * wb,
    200 * wg + 16 * wr + 36 * wb,
    34 * wg + 26 * wr + 170 * wb,
  ];
}

function colorFromGrids(grids, mlat, mlt) {
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let etot = 0;
  for (const t of TYPES) {
    const ef = sample(grids[t + ":energy"], mlat, mlt);
    const nf = sample(grids[t + ":number"], mlat, mlt);
    if (nf < 5e7 || ef <= 0) continue;
    let e = ef / 1.6e-12 / nf / 1000;
    if (e < 0.2) continue;
    if (e > 30) e = 30;
    const [r, g, b] = authored(e);
    wr += r * ef;
    wg += g * ef;
    wb += b * ef;
    etot += ef;
  }
  if (etot <= 0) return [36, 200, 34];
  return [wr / etot, wg / etot, wb / etot];
}

function subsolar(when) {
  const d = when instanceof Date ? when : new Date(when);
  const doy = dayOfYear(d);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (hour - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const eqmin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const lon = ((720 - (hour * 60 + eqmin)) / 4) * (Math.PI / 180);
  return { decl, lon };
}

function toMag(lat, lon) {
  const cl = Math.cos(lat);
  const v0 = cl * Math.cos(lon);
  const v1 = cl * Math.sin(lon);
  const v2 = Math.sin(lat);
  const cz = Math.cos(-POLE_LON);
  const sz = Math.sin(-POLE_LON);
  const x = cz * v0 - sz * v1;
  const y = sz * v0 + cz * v1;
  const z = v2;
  const ang = POLE_LAT - Math.PI / 2;
  const cy = Math.cos(ang);
  const sy = Math.sin(ang);
  return [cy * x + sy * z, y, -sy * x + cy * z];
}

function geoToMlt(latDeg, lonDeg, sun) {
  const [x, y, z] = toMag((latDeg * Math.PI) / 180, (lonDeg * Math.PI) / 180);
  const mlat = (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI;
  const [sx, sy] = toMag(sun.decl, sun.lon);
  const sunMlon = Math.atan2(sy, sx);
  const mlon = Math.atan2(y, x);
  const mlt = ((((mlon - sunMlon) * 180) / Math.PI / 15 + 12) % 24 + 24) % 24;
  return { mlat, mlt };
}

export async function loadOvationPrime(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("ovation tables " + res.status);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "OP12") throw new Error("ovation tables");
  let o = 16;
  // b1 + b2*dF cancels. Energy, number, and the probability slopes stay float32
  // so that sum does not cross the model's flux caps. The probability cube is 0..1.
  function readF32(n) {
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      arr[i] = view.getFloat32(o, true);
      o += 4;
    }
    return arr;
  }
  function readF16(n) {
    const scale = view.getFloat32(o, true);
    o += 4;
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      arr[i] = view.getFloat16(o, true) * scale;
      o += 2;
    }
    return arr;
  }
  const tables = {};
  const nBin = NMLT * NMLAT;
  for (const season of SEASONS) {
    tables[season] = {};
    for (const atype of TYPES) {
      tables[season][atype] = {
        b1e: readF32(nBin),
        b2e: readF32(nBin),
        b1n: readF32(nBin),
        b2n: readF32(nBin),
        b1p: readF32(nBin),
        b2p: readF32(nBin),
        prob: readF16(nBin * NDF),
      };
    }
  }
  if (o !== buf.byteLength) throw new Error("ovation tables");
  return tables;
}

/** Color lookup for one solar-wind coupling and one moment. */
export function makeAuroraColor(tables, dF, when) {
  const used = Math.min(Math.max(dF, 0), DFMAX);
  const whenDate = when instanceof Date ? when : new Date(when);
  const doy = dayOfYear(whenDate);
  const north = hemiGrids(tables, seasonWeights(doy), used);
  const south = hemiGrids(tables, seasonWeights(365 - doy), used);
  const sun = subsolar(whenDate);
  return function colorAt(latDeg, lonDeg) {
    const { mlat, mlt } = geoToMlt(latDeg, lonDeg, sun);
    const grids = mlat < 0 ? south : north;
    const [r, g, b] = colorFromGrids(grids, mlat, mlt);
    return [Math.round(r), Math.round(g), Math.round(b)];
  };
}

export function sampleMlatColor(tables, dF, doy, mlat, mlt) {
  const used = Math.min(Math.max(dF, 0), DFMAX);
  const north = hemiGrids(tables, seasonWeights(doy), used);
  const south = hemiGrids(tables, seasonWeights(365 - doy), used);
  const grids = mlat < 0 ? south : north;
  return colorFromGrids(grids, mlat, mlt).map((v) => Math.round(v));
}
