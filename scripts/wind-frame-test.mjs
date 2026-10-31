/**
 * East and north must match the globe frame, not a second formula.
 * The expected axes are written here as constants. earthPoint's own
 * finite difference has to agree with them, and a pure wind step has to
 * move along that same axis.
 */
import { earthPoint, sampleUV, stepWind, windFrom } from "../wind.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    process.exit(1);
  }
}

function norm(d) {
  const n = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / n, d[1] / n, d[2] / n];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function axis(lat, lon, dLat, dLon) {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  earthPoint(lat, lon, 1, a);
  earthPoint(lat + dLat, lon + dLon, 1, b);
  return norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
}

function moved(lat, lon, u, v) {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const ll = [0, 0];
  earthPoint(lat, lon, 1, a);
  stepWind(lat, lon, u, v, 1, 400, ll);
  earthPoint(ll[0], ll[1], 1, b);
  return norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
}

const east00 = axis(0, 0, 0, 0.05);
const north00 = axis(0, 0, 0.05, 0);
assert(dot(east00, [0, 0, -1]) > 0.99, `east at lon 0 should be -Z, got ${east00}`);
assert(dot(north00, [0, 1, 0]) > 0.99, `north at the equator should be +Y, got ${north00}`);
assert(dot(moved(0, 0, 12, 0), [0, 0, -1]) > 0.99, "east wind at lon 0 moved the wrong way");
assert(dot(moved(0, 0, 0, 12), [0, 1, 0]) > 0.99, "north wind at the equator moved the wrong way");
assert(dot(moved(0, 0, -12, 0), [0, 0, 1]) > 0.99, "west wind at lon 0 moved the wrong way");

const east90 = axis(0, 90, 0, 0.05);
assert(dot(east90, [-1, 0, 0]) > 0.99, `east at lon 90 should be -X, got ${east90}`);
assert(dot(moved(0, 90, 12, 0), [-1, 0, 0]) > 0.99, "east wind at lon 90 moved the wrong way");

const east40 = axis(40, 20, 0, 0.05);
const north40 = axis(40, 20, 0.05, 0);
assert(dot(moved(40, 20, 15, 0), east40) > 0.99, "east wind at 40N 20E left the globe east");
assert(dot(moved(40, 20, 0, 15), north40) > 0.99, "north wind at 40N 20E left the globe north");

const fromWest = windFrom(6, 0);
assert(fromWest.from === "west", `blowing east should be from the west, got ${fromWest.from}`);
const fromNorth = windFrom(0, -4);
assert(fromNorth.from === "north", `blowing south should be from the north, got ${fromNorth.from}`);
assert(windFrom(0.1, 0.1).from === "calm", "a breeze under 0.5 m/s should read calm");

const grid = new Float64Array([5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const zeros = new Float64Array(12);
const hit = sampleUV(grid, zeros, 90, 0, 4, 3);
assert(Math.abs(hit[0] - 5) < 1e-9, `grid point sample got ${hit[0]}`);

console.log("wind frame ok");
