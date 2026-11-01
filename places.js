/**
 * Country / state lookup for SuperEarth border taps.
 * places.json + places-polys.bin (see scripts/bake-places.py).
 */

let ready = null;
let places = [];
let polys = []; // [{ bbox:[minLon,minLat,maxLon,maxLat], rings: Float32Array[] }]

function pointInRing(lon, lat, ring) {
  // Ray cast east; ring is [lon0,lat0, lon1,lat1, ...]
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    const hit =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function pointInPoly(lon, lat, entry) {
  const [minLon, minLat, maxLon, maxLat] = entry.bbox;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
    return false;
  }
  // Even-odd across rings (outer + holes)
  let inside = false;
  for (const ring of entry.rings) {
    if (pointInRing(lon, lat, ring)) inside = !inside;
  }
  return inside;
}

function parsePolys(buf, q) {
  const view = new DataView(buf);
  let o = 0;
  const n = view.getUint32(o, true);
  o += 4;
  const out = [];
  const invQ = 1 / q;
  for (let i = 0; i < n; i++) {
    const nRings = view.getUint32(o, true);
    o += 4;
    const rings = [];
    let minLon = 180;
    let minLat = 90;
    let maxLon = -180;
    let maxLat = -90;
    for (let r = 0; r < nRings; r++) {
      const nPts = view.getUint32(o, true);
      o += 4;
      const ring = new Float32Array(nPts * 2);
      for (let p = 0; p < nPts; p++) {
        const lon = view.getInt16(o, true) * invQ;
        o += 2;
        const lat = view.getInt16(o, true) * invQ;
        o += 2;
        ring[p * 2] = lon;
        ring[p * 2 + 1] = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      rings.push(ring);
    }
    out.push({ bbox: [minLon, minLat, maxLon, maxLat], rings });
  }
  return out;
}

const PLACES_VER = "e229";
const LAND_W = 360;
const LAND_H = 180;
const LAND_SUB = 8;
let landCoarse = null;
let landMixedAt = null;
let landSub = null;

// Water, including just offshore, is not land. Coast cells are checked finely.
export function overLand(lat, lon) {
  if (!landCoarse) return false;
  let L = lon;
  if (L < -180 || L >= 180) {
    L = ((L + 180) % 360 + 360) % 360 - 180;
    if (L === 180) L = -180;
  }
  const x = L < -180 ? 0 : (L + 180) | 0;
  const y = lat <= -90 ? 0 : lat >= 90 ? LAND_H - 1 : (lat + 90) | 0;
  const xi = x > LAND_W - 1 ? LAND_W - 1 : x;
  const c = landCoarse[y * LAND_W + xi];
  if (c === 2) return true;
  if (c !== 1 || !landMixedAt || !landSub) return false;
  const slot = landMixedAt[y * LAND_W + xi];
  if (slot === 65535) return false;
  let sx = ((L + 180 - xi) * LAND_SUB) | 0;
  let sy = ((lat + 90 - y) * LAND_SUB) | 0;
  if (sx < 0) sx = 0;
  else if (sx >= LAND_SUB) sx = LAND_SUB - 1;
  if (sy < 0) sy = 0;
  else if (sy >= LAND_SUB) sy = LAND_SUB - 1;
  return landSub[(slot * LAND_SUB + sy) * LAND_SUB + sx] === 1;
}

function takeLandMask(buf) {
  if (!buf || buf.byteLength < 10) return;
  const view = new DataView(buf);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== "LND1") return;
  if (view.getUint16(4, true) !== LAND_SUB) return;
  if (view.getUint16(6, true) !== LAND_W || view.getUint16(8, true) !== LAND_H) return;
  const n = LAND_W * LAND_H;
  let o = 10;
  if (buf.byteLength < o + n + 4) return;
  const coarse = new Uint8Array(buf, o, n);
  o += n;
  const nMixed = view.getUint32(o, true);
  o += 4;
  if (buf.byteLength < o + nMixed * 4 + nMixed * LAND_SUB * LAND_SUB) return;
  const at = new Uint16Array(n);
  at.fill(65535);
  for (let i = 0; i < nMixed; i++) {
    const id = view.getUint32(o, true);
    o += 4;
    if (id < n) at[id] = i;
  }
  landCoarse = coarse;
  landMixedAt = at;
  landSub = new Uint8Array(buf, o, nMixed * LAND_SUB * LAND_SUB);
}

export function loadPlaces() {
  if (ready) return ready;
  ready = Promise.all([
    fetch(`places.json?v=${PLACES_VER}`).then((r) => {
      if (!r.ok) throw new Error("places.json");
      return r.json();
    }),
    fetch(`places-polys.bin?v=${PLACES_VER}`).then((r) => {
      if (!r.ok) throw new Error("places-polys.bin");
      return r.arrayBuffer();
    }),
    fetch(`land-mask.bin?v=e235`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]).then(([meta, buf, maskBuf]) => {
    places = meta.places || [];
    polys = parsePolys(buf, meta.q || 100);
    if (polys.length !== places.length) {
      console.warn("places poly count mismatch", polys.length, places.length);
    }
    takeLandMask(maskBuf);
    return places.length;
  });
  return ready;
}

/**
 * Prefer state/province, else country. Ocean → null.
 */
export function placeAt(lat, lon) {
  if (!places.length || !polys.length) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Normalize lon to [-180, 180]
  let L = lon;
  while (L < -180) L += 360;
  while (L > 180) L -= 360;

  // States are after countries in the bake.
  let countryIdx = -1;
  for (let i = 0; i < places.length; i++) {
    if (!pointInPoly(L, lat, polys[i])) continue;
    if (places[i].kind === "state") return places[i];
    if (countryIdx < 0) countryIdx = i;
  }
  return countryIdx >= 0 ? places[countryIdx] : null;
}

export function formatPop(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + " billion";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + " million";
  if (n >= 1e3) return Math.round(n).toLocaleString("en-US");
  return String(Math.round(n));
}

export function formatArea(km2) {
  if (km2 == null || !Number.isFinite(km2)) return "—";
  return Math.round(km2).toLocaleString("en-US") + " km²";
}

export function formatDensity(pop, area) {
  if (pop == null || area == null || area <= 0) return "—";
  const d = pop / area;
  if (d >= 100) return Math.round(d).toLocaleString("en-US") + " / km²";
  if (d >= 10) return d.toFixed(1) + " / km²";
  return d.toFixed(2) + " / km²";
}
