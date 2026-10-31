/**
 * Globe frame shared with every SuperEarth lat/lon point.
 * lon 0 faces +X, north is +Y, and increasing longitude moves toward -Z.
 * East and north for the wind are steps in this same frame, not a second one.
 */

export function earthPoint(latDeg, lonDeg, r, out) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cl = Math.cos(lat);
  out[0] = r * cl * Math.cos(lon);
  out[1] = r * Math.sin(lat);
  out[2] = -r * cl * Math.sin(lon);
  return out;
}

/** Move a point by an eastward u and a northward v, in meters per second. */
export function stepWind(lat, lon, u, v, dt, timeScale, out) {
  const radius = 6371000;
  const cos = Math.cos((lat * Math.PI) / 180);
  // Keep a polar particle from leaping a whole longitude in one frame.
  const cosSafe = Math.max(0.2, Math.abs(cos));
  let lat2 = lat + ((v * dt * timeScale) / radius) * (180 / Math.PI);
  let lon2 = lon + ((u * dt * timeScale) / (radius * cosSafe)) * (180 / Math.PI);
  if (lat2 > 90) {
    lat2 = 180 - lat2;
    lon2 += 180;
  } else if (lat2 < -90) {
    lat2 = -180 - lat2;
    lon2 += 180;
  }
  if (lat2 > 90) lat2 = 90;
  if (lat2 < -90) lat2 = -90;
  lon2 = (((lon2 + 180) % 360) + 360) % 360 - 180;
  out[0] = lat2;
  out[1] = lon2;
  return out;
}

/**
 * Bilinear sample. Row 0 is 90°N, column 0 is lon 0, spacing 360/nlon and 180/(nlat-1).
 * u and v are flat row-major arrays.
 */
export function sampleUV(u, v, latDeg, lonDeg, nlon, nlat) {
  const dlon = 360 / nlon;
  const dlat = 180 / (nlat - 1);
  let lon = lonDeg % 360;
  if (lon < 0) lon += 360;
  let x = lon / dlon;
  if (x >= nlon) x -= nlon;
  let y = (90 - latDeg) / dlat;
  if (y < 0) y = 0;
  if (y > nlat - 1) y = nlat - 1;
  const x0 = Math.floor(x) % nlon;
  const x1 = (x0 + 1) % nlon;
  const tx = x - Math.floor(x);
  const y0 = Math.floor(y);
  const y1 = Math.min(nlat - 1, y0 + 1);
  const ty = y - y0;
  const i00 = y0 * nlon + x0;
  const i10 = y0 * nlon + x1;
  const i01 = y1 * nlon + x0;
  const i11 = y1 * nlon + x1;
  const uu = (u[i00] * (1 - tx) + u[i10] * tx) * (1 - ty) + (u[i01] * (1 - tx) + u[i11] * tx) * ty;
  const vv = (v[i00] * (1 - tx) + v[i10] * tx) * (1 - ty) + (v[i01] * (1 - tx) + v[i11] * tx) * ty;
  return [uu, vv];
}

const FROM = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

/** Where the wind comes from. u east, v north, both m/s. */
export function windFrom(u, v) {
  const speed = Math.hypot(u, v);
  if (speed < 0.5) return { speed, from: "calm" };
  const going = (Math.atan2(u, v) * 180) / Math.PI;
  const fromDeg = (going + 180 + 360) % 360;
  return { speed, from: FROM[Math.round(fromDeg / 45) % 8] };
}
