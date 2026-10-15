/**
 * Hi-res 3D Earth
 * 1-finger orbit · 2fs (two-finger slide) pan · pinch zoom · Live/home reset
 */
import * as THREE from "three";
import { loadOvationPrime, makeAuroraColor } from "./ovation.js?v=e54";

/** Quake / storm pins. Replaced at runtime. */
let SURFACE_SITES = [];

const RADIUS = 1;
const HOME_FILL = 0.9;
/**
 * Closest zoom (camera distance to Earth center; Earth radius = 1).
 * Was 1.55 before hi-res zoom tiles; open again so we can pick a new stop.
 */
const MIN_DIST = 1.15;
/**
 * Furthest zoom as a multiple of the opening (home) distance.
 * Opening stays the “start” framing; you can pull further out past it.
 */
const MAX_OUT_FACTOR = 1.85;
const MIN_POLAR = 0.15;
const MAX_POLAR = Math.PI - 0.15;
const MAX_PAN = RADIUS * 20;
const PINCH_POWER = 0.4;
const PINCH_EPS = 0.005;
const WHEEL_DOLLY = 0.0012;

/**
 * Earth air. Same limb shell as Mars, bluer, just outside the clouds.
 * BackSide; ray-altitude fade into space. Brighter on the day side.
 */
const ATMO_HEIGHT = 1.05;
const ATMO_FADE = 0.75;
const ATMO_INTENSITY = 0.55;
const ATMO_COLOR = new THREE.Color(0x4da6ff);
/** OVATION ribbon — above clouds, under the air shell. */
const AURORA_HEIGHT = 1.022;
const AURORA_TEX_W = 360;
const AURORA_TEX_H = 721;
/**
 * NOAA chance is 0…100, but quiet days often peak in the teens and
 * moderate storms around the high 20s. Scaling by 90 left today's oval
 * at ~8% opacity, then the feather pass wiped it. Map ~28% → full.
 */
const AURORA_MIN = 4;
const AURORA_PEAK_REF = 28;

const ATMO_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ATMO_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFadePower;
uniform vec3 uLightDir;
uniform float uSunOn;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uAtmoRadius;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
void main() {
  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec3 oc = cameraPosition - uPlanetCenter;
  float dist = length(oc - rd * dot(oc, rd));
  float span = max(uAtmoRadius - uPlanetRadius, 1e-4);
  float h = clamp((dist - uPlanetRadius) / span, 0.0, 1.0);
  float radial = pow(1.0 - h, uFadePower);
  vec3 nWorld = normalize(vWorldNormal);
  float day = uSunOn * smoothstep(-0.15, 0.5, dot(nWorld, normalize(uLightDir)));
  float glow = radial * mix(0.35, 1.0, day) * uIntensity;
  gl_FragColor = vec4(uColor * glow, 1.0);
}
`;
/** Base vertical FOV (degrees). Buffer render expands FOV so center crop matches this. */
const BASE_FOV = 40;
/**
 * Extra screen fraction for CSS pan buffer.
 * Was 1.0 → ~3× linear size × DPR ≈ Safari tab crash (“A problem repeatedly occurred”).
 */
const PAN_MARGIN = 0.35;

const NEAR_SIDE_Y = -Math.PI / 2;

/** Starfield (ported from satellite-app) — fixed sphere behind the moon */
const STAR_COUNT = 5000;
const STAR_RADIUS = 55;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStarfieldBuffers(count = STAR_COUNT, radius = STAR_RADIUS) {
  const rand = mulberry32(42);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand();
    const v = rand();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.94 + rand() * 0.06);
    const sinPhi = Math.sin(phi);
    positions[i * 3] = r * sinPhi * Math.cos(theta);
    positions[i * 3 + 1] = r * sinPhi * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    const roll = rand();
    const brightness = roll < 0.15 ? 1 : 0.88 + rand() * 0.12;
    const tint = 0.94 + rand() * 0.06;
    colors[i * 3] = brightness * tint;
    colors[i * 3 + 1] = brightness * tint;
    colors[i * 3 + 2] = brightness;
  }
  return { positions, colors };
}

function createStarPointTexture() {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 8, 8);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(3, 3, 2, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** iPad / tablets — including iPadOS “desktop site” (fine pointer, but touch). */
function isTabletDisplay() {
  if (typeof window === "undefined") return false;
  const minSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  if (minSide < 600) return false; // phones
  const touch = (navigator.maxTouchPoints || 0) > 1;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const noHover = window.matchMedia("(hover: none)").matches;
  return touch || coarse || noHover;
}

function starPointSize() {
  return isTabletDisplay() ? 7 : 3;
}

function createStarfield() {
  const { positions, colors } = buildStarfieldBuffers();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const map = createStarPointTexture();
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: starPointSize(),
    sizeAttenuation: false,
    vertexColors: true,
    map: map || undefined,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  points.userData.starTexture = map;
  return points;
}

const TEX_VER = "e123";
const LOD = {
  low: {
    map: `earth-2k.jpg?v=${TEX_VER}`,
    night: `earth-night-2k.jpg?v=${TEX_VER}`,
    normal: `earth-normal-2k.jpg?v=${TEX_VER}`,
    segments: 128,
  },
  high: {
    map: `earth-8k.jpg?v=${TEX_VER}`,
    night: `earth-night-8k.jpg?v=${TEX_VER}`,
    normal: `earth-normal-4k.jpg?v=${TEX_VER}`,
    // Denser mesh so coasts stay smoother when zoomed in
    segments: 320,
  },
};

/**
 * Zoom-in tiles from one Next Gen master (never a full high-k wrap).
 * Day wraps/tiles at JPEG 85. 16 at mid zoom; 32 under 1.5.
 */
const TILE_LEVELS = {
  16: {
    label: "16",
    folder: "tiles-16",
    cols: 8,
    rows: 4,
    onDist: 2.5,
    radius: 1.0018,
  },
  32: {
    label: "32",
    folder: "tiles-32",
    cols: 16,
    rows: 8,
    onDist: 1.5,
    radius: 1.0022,
  },
};

const NIGHT_VERT = `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const NIGHT_FRAG = `
  uniform sampler2D uNight;
  uniform vec3 uSunDir;
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  void main() {
    float ndl = dot(normalize(vWorldNormal), normalize(uSunDir));
    float night = smoothstep(0.28, -0.08, ndl);
    vec3 col = texture2D(uNight, vUv).rgb;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col *= mix(0.72, 1.15, smoothstep(0.0, 0.22, lum));
    gl_FragColor = vec4(col * night * 2.6, night);
  }
`;

const _toSun = new THREE.Vector3();
const _toEarth = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 0, 1);
const _camDir = new THREE.Vector3();
const _eclAxis = new THREE.Vector3();
const _eclOffset = new THREE.Vector3();
const _viewZ = new THREE.Vector3(0, 0, 1);
const _keyColor = new THREE.Color(0xfff2e6);
const _keyEclipse = new THREE.Color(0xff6a3a);

const EARTH_R_KM = 6371;
const SUN_R_KM = 695700;
const MOON_R_KM = 1737.4;

/** Fraction of moon disk covered by a circular shadow (0…1). */
function diskOverlapFraction(rMoon, rShadow, d) {
  if (!(rMoon > 0) || !(rShadow > 0)) return 0;
  if (d >= rMoon + rShadow) return 0;
  if (d <= Math.abs(rShadow - rMoon)) {
    return rShadow >= rMoon ? 1 : (rShadow * rShadow) / (rMoon * rMoon);
  }
  const r = rMoon;
  const R = rShadow;
  const a = (r * r - R * R + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r * r - a * a));
  return (
    (r * r * Math.acos(Math.min(1, Math.max(-1, a / r))) -
      a * h +
      R * R * Math.acos(Math.min(1, Math.max(-1, (d - a) / R))) -
      (d - a) * h) /
    (Math.PI * r * r)
  );
}

/** @type {null | { peakMs: number, kind: string, obscuration: number, sd_penum: number, sd_partial: number, sd_total: number }} */
let _eclipseCatalog = null;

function catalogLunarEclipse(A, when) {
  const t = when.getTime();
  const cat = _eclipseCatalog;
  if (
    cat &&
    Math.abs(t - cat.peakMs) < (cat.sd_penum + 180) * 60e3
  ) {
    return cat;
  }
  try {
    // Search from a day earlier so “now” during an eclipse still finds this event
    let info = A.SearchLunarEclipse(new Date(t - 864e5));
    if (!info || !info.peak) return null;
    let peakMs = info.peak.date.getTime();
    // If this peak is far in the past relative to penumbra, step forward
    if (t - peakMs > (info.sd_penum + 60) * 60e3) {
      info = A.NextLunarEclipse(info.peak.date);
      if (!info || !info.peak) return null;
      peakMs = info.peak.date.getTime();
    }
    _eclipseCatalog = {
      peakMs,
      kind: info.kind,
      obscuration: Number(info.obscuration) || 0,
      sd_penum: Number(info.sd_penum) || 0,
      sd_partial: Number(info.sd_partial) || 0,
      sd_total: Number(info.sd_total) || 0,
    };
    return _eclipseCatalog;
  } catch (_) {
    return null;
  }
}

/**
 * Earth umbra/penumbra on the Moon at `when`.
 * Face axes must match lighting (_xAxis/_yAxis/_zAxis) before skyRoll.
 */
function computeLunarEclipse(A, when, xAxis, yAxis, zAxis) {
  const empty = {
    active: false,
    stage: "none",
    umbralObscuration: 0,
    penumbral: 0,
    ox: 0,
    oy: 0,
    uR: 0,
    pR: 0,
    kind: null,
    peak: null,
    catalogObscuration: 0,
  };
  if (!A) return empty;

  const time = A.MakeTime(when);
  const sun = A.GeoVector(A.Body.Sun, time, false);
  const moon = A.GeoVector(A.Body.Moon, time, false);
  const sLen = Math.hypot(sun.x, sun.y, sun.z);
  const mLen = Math.hypot(moon.x, moon.y, moon.z);
  if (!(sLen > 0) || !(mLen > 0)) return empty;

  // Umbra axis from Earth toward anti-sun
  _eclAxis.set(-sun.x / sLen, -sun.y / sLen, -sun.z / sLen);
  const mhx = moon.x / mLen;
  const mhy = moon.y / mLen;
  const mhz = moon.z / mLen;
  const denom = _eclAxis.x * mhx + _eclAxis.y * mhy + _eclAxis.z * mhz;
  if (Math.abs(denom) < 1e-9) return empty;

  // Intersection of shadow axis with plane through Moon ⊥ Earth–Moon
  const tt = mLen / denom;
  _eclOffset.set(
    _eclAxis.x * tt - moon.x,
    _eclAxis.y * tt - moon.y,
    _eclAxis.z * tt - moon.z
  );
  const offsetKm = _eclOffset.length() * A.KM_PER_AU;
  const D = mLen * A.KM_PER_AU;
  const Ds = sLen * A.KM_PER_AU;
  const fU = (SUN_R_KM - EARTH_R_KM) / Ds;
  const fP = (SUN_R_KM + EARTH_R_KM) / Ds;
  const uR = EARTH_R_KM - D * fU;
  const pR = EARTH_R_KM + D * fP;
  if (!(pR > 0)) return empty;

  const ox =
    ((_eclOffset.x * xAxis.x + _eclOffset.y * xAxis.y + _eclOffset.z * xAxis.z) *
      A.KM_PER_AU) /
    MOON_R_KM;
  const oy =
    ((_eclOffset.x * yAxis.x + _eclOffset.y * yAxis.y + _eclOffset.z * yAxis.z) *
      A.KM_PER_AU) /
    MOON_R_KM;

  const umbralObscuration =
    uR > 0 ? diskOverlapFraction(MOON_R_KM, uR, offsetKm) : 0;
  const penCover = diskOverlapFraction(MOON_R_KM, pR, offsetKm);
  // Soft penumbral amount when not yet in umbra
  const penumbral =
    penCover > 0
      ? Math.min(1, Math.max(0, penCover - umbralObscuration))
      : 0;

  let stage = "none";
  if (umbralObscuration >= 0.995) stage = "total";
  else if (umbralObscuration > 0.012) stage = "partial";
  else if (penCover > 0.04) stage = "penumbral";

  const cat = catalogLunarEclipse(A, when);
  let kind = cat && Math.abs(when.getTime() - cat.peakMs) < (cat.sd_penum + 20) * 60e3
    ? cat.kind
    : null;
  // Prefer geometry stage; fall back to catalog kind near peak for penumbral-only events
  if (stage === "none" && kind === "penumbral" && cat) {
    const dtMin = Math.abs(when.getTime() - cat.peakMs) / 60000;
    if (dtMin <= cat.sd_penum) stage = "penumbral";
  }
  if (stage === "partial" && kind === "total" && umbralObscuration > 0.98) {
    stage = "total";
  }

  return {
    active: stage !== "none",
    stage,
    umbralObscuration,
    penumbral,
    ox,
    oy,
    uR: uR > 0 ? uR / MOON_R_KM : 0,
    pR: pR / MOON_R_KM,
    kind: kind || stage,
    peak: cat ? new Date(cat.peakMs) : null,
    catalogObscuration: cat ? cat.obscuration : 0,
  };
}

function phaseName(phase01) {
  if (phase01 < 0.03 || phase01 > 0.97) return "New Moon";
  if (phase01 < 0.22) return "Waxing Crescent";
  if (phase01 < 0.28) return "First Quarter";
  if (phase01 < 0.47) return "Waxing Gibbous";
  if (phase01 < 0.53) return "Full Moon";
  if (phase01 < 0.72) return "Waning Gibbous";
  if (phase01 < 0.78) return "Last Quarter";
  return "Waning Crescent";
}

function eclipsePhaseName(stage, phase01) {
  // Short labels — metric cells are narrow (ellipsis otherwise)
  if (stage === "total") return "Total eclipse";
  if (stage === "partial") return "Partial eclipse";
  if (stage === "penumbral") return "Penumbral eclipse";
  return phaseName(phase01);
}

function skyRollRad(latDeg, lonDeg, date) {
  const A = globalThis.Astronomy;
  if (!A) return 0;
  try {
    const time = A.MakeTime(date);
    const obs = new A.Observer(latDeg, lonDeg, 0);
    const eq = A.Equator(A.Body.Moon, time, obs, true, true);
    const gst = A.SiderealTime(time);
    let haHours = gst + lonDeg / 15 - eq.ra;
    while (haHours < -12) haHours += 24;
    while (haHours > 12) haHours -= 24;
    const ha = haHours * A.HOUR2RAD;
    const lat = latDeg * A.DEG2RAD;
    const dec = eq.dec * A.DEG2RAD;
    return Math.atan2(
      Math.sin(ha),
      Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha)
    );
  } catch (_) {
    return 0;
  }
}

const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 450;

export function createEarthGlobe(canvas, options = {}) {
  const {
    onReady = null,
    onQuality = null,
    onPhase = null,
    onZoom = null,
    onTap = null,
    onMissionTap = null,
  } = options;
  const surface =
    (typeof document !== "undefined" && document.getElementById("touch-plane")) ||
    canvas;

  // DPR = physical pixels per CSS pixel (iPhone ~3, iPad ~2, Retina Mac ~2).
  // Phone/iPad use full device DPR (up to 3); Mac stays capped at 2.5.
  const isTouch =
    (navigator.maxTouchPoints || 0) > 0 ||
    window.matchMedia("(pointer: coarse)").matches;
  const maxPixelRatio = isTouch ? 3 : 2.5;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
  camera.position.set(0, 0, 3.2);

  // Phone DPR is already ~3. Multisampling that framebuffer is another
  // full-screen buffer, and with the 8k maps it is enough to make Safari
  // kill the tab ("A problem repeatedly occurred"). iPad (~2×) and Mac keep it.
  const deviceRatio = window.devicePixelRatio || 1;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !(isTouch && deviceRatio >= 2.5),
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  renderer.setClearColor(0x020308, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const starfield = createStarfield();
  scene.add(starfield);

  const moonGroup = new THREE.Group();
  scene.add(moonGroup);

  const loader = new THREE.TextureLoader();
  let mesh = null;
  let material = null;
  let ready = false;
  let hqStarted = false;
  let disposed = false;
  let animId = 0;
  let orbiting = false;
  let lastOrbitMs = 0;
  /** Slow spin: one full turn about every 100s — cheap (theta += dt). */
  const ORBIT_RAD_PER_SEC = (2 * Math.PI) / 100;
  let missionMode = "off"; // "off" | "famous" | "landings" | "all"
  let missionGroup = null;
  const missionPins = [];
  const sunDir = new THREE.Vector3(1, 0, 0);
  const sunDirUniform = { value: sunDir };
  const sunOnUniform = { value: 1 };
  /** Temp day-look knobs (topo always on). Brighter defaults than the old 1.16 pack. */
  const dayLook = {
    landGain: 1.32,
    shadeMin: 0.9,
    shadeMax: 1.14,
    reliefStr: 1.4,
    slope: 1.35,
  };
  const uLandGain = { value: dayLook.landGain };
  const uShadeMin = { value: dayLook.shadeMin };
  const uShadeMax = { value: dayLook.shadeMax };
  const uReliefStr = { value: dayLook.reliefStr };
  const uSlope = { value: dayLook.slope };
  let nightMesh = null;
  let nightMat = null;
  let cloudMesh = null;
  let cloudsOn = true;
  let tileGroup = null;
  const tileLive = new Map();
  const tileLoading = new Set();
  let tileWanted = new Set();
  let tilesEnabled = false;
  /** @type {null | "16" | "32"} */
  let tileLevel = null;
  let qualityLevel = "";
  const _tileLocal = new THREE.Vector3();
  const _tileHit = new THREE.Vector3();
  const _tileNdc = new THREE.Vector2(0, 0);
  const _tileRay = new THREE.Raycaster();
  const _earthSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), RADIUS);

  function reportQuality(level) {
    if (qualityLevel === level) return;
    qualityLevel = level;
    if (typeof onQuality === "function") onQuality(level);
  }

  function pickTileLevel(dist) {
    if (dist <= TILE_LEVELS[32].onDist) return TILE_LEVELS[32];
    if (dist <= TILE_LEVELS[16].onDist) return TILE_LEVELS[16];
    return null;
  }
  let atmosphere = null;
  let atmosphereMat = null;
  const _atmoCenter = new THREE.Vector3();
  const _atmoScale = new THREE.Vector3();
  let auroraMesh = null;
  let auroraCoords = null;
  let auroraDrive = null;
  let ovationTables = null;
  const ovationReady = loadOvationPrime(new URL("./ovation-prime.bin?v=e54", import.meta.url))
    .then((tables) => {
      ovationTables = tables;
      if (auroraCoords) setAurora(auroraCoords, auroraDrive);
      return tables;
    })
    .catch(() => null);
  let auroraMat = null;
  let auroraTex = null;
  let auroraHas = false;
  let frozenLat = 0;
  let frozenLon = 0;
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _pinWorld = new THREE.Vector3();
  const _camFromMoon = new THREE.Vector3();
  const _pinFromMoon = new THREE.Vector3();
  let width = 0; // CSS viewport width (window)
  let height = 0;
  let bufferW = 0; // drawing buffer / canvas CSS (includes pan margin)
  let bufferH = 0;
  let panMarginPx = 0;
  let homeDist = 3.2;

  const LIGHTING = {
    dualMode: true,
    keyBase: 2.0,
    keyFracGain: 0.85,
    earth: {
      ambient: 0.04,
      earthshineBase: 0.1,
      earthshineNewGain: 0.36,
      emissive: 0.04,
    },
    orbit: {
      ambient: 0.09,
      earthshineBase: 0.18,
      earthshineNewGain: 0.48,
      emissive: 0.12,
    },
  };

  const key = new THREE.DirectionalLight(0xfff2e6, LIGHTING.keyBase + LIGHTING.keyFracGain);
  scene.add(key);
  scene.add(key.target);
  key.target.position.set(0, 0, 0);

  const earthshine = new THREE.DirectionalLight(0x9eb4d4, LIGHTING.orbit.earthshineBase);
  earthshine.position.set(0, 0.1, 10);
  scene.add(earthshine);

  const ambient = new THREE.AmbientLight(0x141820, LIGHTING.orbit.ambient);
  scene.add(ambient);

  let lastFrac = 0.5;
  let lastEclipseUmbra = 0;
  let lastEclipsePen = 0;

  // Camera orbits `target`; moon is always at `target` (required for 2fs pan).
  const target = new THREE.Vector3(0, 0, 0);
  const spherical = new THREE.Spherical();
  const _offset = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  let prevCamDist = homeDist;
  /** @type {null | { x: number, y: number }} */
  let oneFinger = null;
  /** @type {null | { midX: number, midY: number, span: number }} */
  let twoFinger = null;

  let observerLat = 0;
  let observerLon = 0;
  let when = new Date();
  let lastPhaseInfo = null;
  let orientLocked = false;
  let frozenRoll = 0;
  let frozenSouthern = false;

  function configureColor(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  }

  /** Zoom tiles sit large on screen — skip mips so they stay crisp. */
  function configureTileColor(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
  }

  function configureNormal(tex) {
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  }

  function configureNight(tex) {
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  }

  function makeSurfaceMaterial(map, night, normal) {
    const nightUniform = { value: night };
    const normalUniform = { value: normal };
    const material = new THREE.MeshBasicMaterial({ map, color: 0xffffff });
    material.userData.nightUniform = nightUniform;
    material.userData.normalUniform = normalUniform;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = nightUniform;
      shader.uniforms.uNormal = normalUniform;
      shader.uniforms.uSunDir = sunDirUniform;
      shader.uniforms.uSunOn = sunOnUniform;
      shader.uniforms.uLandGain = uLandGain;
      shader.uniforms.uShadeMin = uShadeMin;
      shader.uniforms.uShadeMax = uShadeMax;
      shader.uniforms.uReliefStr = uReliefStr;
      shader.uniforms.uSlope = uSlope;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWorldN;\nvarying vec3 vWorldPos;\nvarying vec3 vWorldT;\nvarying vec3 vWorldB;"
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec3 nLocal = normalize(position);
        vWorldN = normalize(mat3(modelMatrix) * nLocal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 tLocal = normalize(vec3(-nLocal.z, 0.0, nLocal.x));
        if (length(tLocal) < 1e-4) tLocal = vec3(1.0, 0.0, 0.0);
        vec3 bLocal = normalize(cross(nLocal, tLocal));
        vWorldT = normalize(mat3(modelMatrix) * tLocal);
        vWorldB = normalize(mat3(modelMatrix) * bLocal);`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uNight;
        uniform sampler2D uNormal;
        uniform vec3 uSunDir;
        uniform float uSunOn;
        uniform float uLandGain;
        uniform float uShadeMin;
        uniform float uShadeMax;
        uniform float uReliefStr;
        uniform float uSlope;
        varying vec3 vWorldN;
        varying vec3 vWorldPos;
        varying vec3 vWorldT;
        varying vec3 vWorldB;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 nSphere = normalize(vWorldN);
        vec3 sunD = normalize(uSunDir);
        float ndl = dot(nSphere, sunD);
        float day = uSunOn * smoothstep(-0.04, 0.20, ndl);
        vec3 dayCol = diffuseColor.rgb;
        float lum = dot(dayCol, vec3(0.2126, 0.7152, 0.0722));
        float blue = dayCol.b - max(dayCol.r, dayCol.g);
        // Linear-space water mask: catches all deep & coastal water uniformly without amplifying 8x8 JPEG steps
        float dark = smoothstep(0.016, 0.0035, lum);
        float blu = smoothstep(0.0004, 0.0028, blue);
        float ocean = dark * blu;
        // Same deep navy tone as the original open ocean, applied smoothly across all dark water
        dayCol = mix(dayCol, vec3(0.0038, 0.0191, 0.0577), ocean * 0.94);

        // 3D mountain relief on land from NASA elevation normal map (always on)
        vec3 nTex = texture2D(uNormal, vMapUv).xyz * 2.0 - 1.0;
        vec2 slope = nTex.xy * (1.0 - ocean) * uSlope;
        vec3 nPerturbed = normalize(nSphere + normalize(vWorldT) * slope.x + normalize(vWorldB) * slope.y);
        float ndlRelief = max(0.0, dot(nPerturbed, sunD));
        float ndlSmooth = max(0.0, ndl);
        float relief = clamp(1.0 + (ndlRelief - ndlSmooth) * uReliefStr, 0.68, 1.34);

        // Day shading from limb toward noon + land brightness
        float sunShade = mix(uShadeMin, uShadeMax, pow(ndlSmooth, 0.42));
        dayCol *= mix(uLandGain * relief * sunShade, 1.0, ocean);

        // Subtle Rayleigh atmospheric blue haze near the limb on the day side
        vec3 viewD = normalize(cameraPosition - vWorldPos);
        float rim = 1.0 - max(0.0, dot(nSphere, viewD));
        dayCol += vec3(0.03, 0.09, 0.22) * pow(rim, 3.2) * smoothstep(-0.05, 0.35, ndl) * uSunOn * 0.42;

        vec3 nightCol = pow(texture2D(uNight, vMapUv).rgb, vec3(2.2));
        diffuseColor.rgb = mix(nightCol * 2.1, dayCol, day);`
      );
    };
    return material;
  }

  function makeTileMaterial(map, nightUniform, normalUniform) {
    const mat = new THREE.MeshBasicMaterial({
      map,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = nightUniform;
      shader.uniforms.uNormal = normalUniform;
      shader.uniforms.uSunDir = sunDirUniform;
      shader.uniforms.uSunOn = sunOnUniform;
      shader.uniforms.uLandGain = uLandGain;
      shader.uniforms.uShadeMin = uShadeMin;
      shader.uniforms.uShadeMax = uShadeMax;
      shader.uniforms.uReliefStr = uReliefStr;
      shader.uniforms.uSlope = uSlope;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWorldN;\nvarying vec3 vWorldPos;\nvarying vec3 vWorldT;\nvarying vec3 vWorldB;\nvarying vec3 vLocalN;"
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec3 nLocal = normalize(position);
        vLocalN = nLocal;
        vWorldN = normalize(mat3(modelMatrix) * nLocal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 tLocal = normalize(vec3(-nLocal.z, 0.0, nLocal.x));
        if (length(tLocal) < 1e-4) tLocal = vec3(1.0, 0.0, 0.0);
        vec3 bLocal = normalize(cross(nLocal, tLocal));
        vWorldT = normalize(mat3(modelMatrix) * tLocal);
        vWorldB = normalize(mat3(modelMatrix) * bLocal);`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uNight;
        uniform sampler2D uNormal;
        uniform vec3 uSunDir;
        uniform float uSunOn;
        uniform float uLandGain;
        uniform float uShadeMin;
        uniform float uShadeMax;
        uniform float uReliefStr;
        uniform float uSlope;
        varying vec3 vWorldN;
        varying vec3 vWorldPos;
        varying vec3 vWorldT;
        varying vec3 vWorldB;
        varying vec3 vLocalN;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 nSphere = normalize(vWorldN);
        vec3 sunD = normalize(uSunDir);
        float ndl = dot(nSphere, sunD);
        float day = uSunOn * smoothstep(-0.04, 0.20, ndl);
        vec3 dayCol = diffuseColor.rgb;
        float lum = dot(dayCol, vec3(0.2126, 0.7152, 0.0722));
        float blue = dayCol.b - max(dayCol.r, dayCol.g);
        float dark = smoothstep(0.016, 0.0035, lum);
        float blu = smoothstep(0.0004, 0.0028, blue);
        float ocean = dark * blu;
        dayCol = mix(dayCol, vec3(0.0038, 0.0191, 0.0577), ocean * 0.94);
        vec2 planetUv = vec2(
          atan(-vLocalN.z, vLocalN.x) / 6.28318530718 + 0.5,
          asin(clamp(vLocalN.y, -1.0, 1.0)) / 3.14159265359 + 0.5
        );
        vec3 nTex = texture2D(uNormal, planetUv).xyz * 2.0 - 1.0;
        vec2 slope = nTex.xy * (1.0 - ocean) * uSlope;
        vec3 nPerturbed = normalize(nSphere + normalize(vWorldT) * slope.x + normalize(vWorldB) * slope.y);
        float ndlRelief = max(0.0, dot(nPerturbed, sunD));
        float ndlSmooth = max(0.0, ndl);
        float relief = clamp(1.0 + (ndlRelief - ndlSmooth) * uReliefStr, 0.68, 1.34);
        float sunShade = mix(uShadeMin, uShadeMax, pow(ndlSmooth, 0.42));
        dayCol *= mix(uLandGain * relief * sunShade, 1.0, ocean);
        vec3 viewD = normalize(cameraPosition - vWorldPos);
        float rim = 1.0 - max(0.0, dot(nSphere, viewD));
        dayCol += vec3(0.03, 0.09, 0.22) * pow(rim, 3.2) * smoothstep(-0.05, 0.35, ndl) * uSunOn * 0.42;
        vec3 nightCol = pow(texture2D(uNight, planetUv).rgb, vec3(2.2));
        diffuseColor.rgb = mix(nightCol * 2.1, dayCol, day);
        // Opaque on the day side so sharp tiles fully cover the soft 8k under them.
        diffuseColor.a = mix(0.0, 1.0, day);`
      );
    };
    return mat;
  }

  function buildMesh(map, night, normal, cfg) {
    if (mesh) {
      moonGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (material) {
      material.dispose();
      material = null;
    }
    if (nightMat) {
      nightMat.dispose();
      nightMat = null;
    }
    nightMesh = null;

    material = makeSurfaceMaterial(map, night, normal);
    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, cfg.segments, cfg.segments),
      material
    );
    if (cloudMesh) mesh.add(cloudMesh);
    if (auroraMesh) mesh.add(auroraMesh);
    if (tileGroup) mesh.add(tileGroup);
    moonGroup.add(mesh);
    ensureAtmosphere();
    attachMissionPins(mesh);
    attachPoleMarks(mesh);
    applyEphemeris();
  }

  function ensureAtmosphere() {
    if (atmosphere) return;
    atmosphereMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERTEX,
      fragmentShader: ATMO_FRAGMENT,
      uniforms: {
        uLightDir: { value: sunDir.clone() },
        uSunOn: sunOnUniform,
        uColor: { value: ATMO_COLOR.clone() },
        uIntensity: { value: ATMO_INTENSITY },
        uFadePower: { value: ATMO_FADE },
        uPlanetCenter: { value: new THREE.Vector3() },
        uPlanetRadius: { value: RADIUS },
        uAtmoRadius: { value: RADIUS * ATMO_HEIGHT },
      },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 64, 64),
      atmosphereMat
    );
    atmosphere.renderOrder = 10;
    atmosphere.frustumCulled = false;
    atmosphere.scale.setScalar(ATMO_HEIGHT);
    moonGroup.add(atmosphere);
  }

  function updateAtmosphereLight() {
    if (!atmosphereMat || !atmosphere) return;
    atmosphereMat.uniforms.uLightDir.value.copy(sunDir);
    moonGroup.getWorldPosition(_atmoCenter);
    moonGroup.getWorldScale(_atmoScale);
    const g = _atmoScale.x || 1;
    atmosphereMat.uniforms.uPlanetCenter.value.copy(_atmoCenter);
    atmosphereMat.uniforms.uPlanetRadius.value = RADIUS * g;
    atmosphereMat.uniforms.uAtmoRadius.value = RADIUS * ATMO_HEIGHT * g;
  }

  let poleGroup = null;
  let poleGeo = null;
  const poleMarks = [];
  const POLE_GEO_R = 0.006;
  const POLE_PX_FAR = 1;
  const POLE_PX_NEAR = 5;

  function makePoleBadge(letter) {
    const size = 96;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6, 10, 18, 0.82)";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 52px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, size / 2, size / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });
    const mark = new THREE.Mesh(poleGeo, mat);
    mark.renderOrder = 6;
    mark.userData.poleTex = tex;
    return mark;
  }

  function disposePoleMarks() {
    if (!poleGroup) return;
    for (const mark of poleMarks) {
      mark.userData.poleTex?.dispose();
      mark.material?.dispose();
    }
    poleMarks.length = 0;
    poleGeo?.dispose();
    poleGeo = null;
    if (poleGroup.parent) poleGroup.parent.remove(poleGroup);
    poleGroup = null;
  }

  function attachPoleMarks(parentMesh) {
    disposePoleMarks();
    if (!parentMesh) return;
    poleGeo = new THREE.CircleGeometry(POLE_GEO_R, 24);
    poleGroup = new THREE.Group();
    poleGroup.name = "pole-marks";
    const north = makePoleBadge("N");
    north.position.set(0, RADIUS * 1.0008, 0);
    north.rotation.set(-Math.PI / 2, 0, 0);
    const south = makePoleBadge("S");
    south.position.set(0, -RADIUS * 1.0008, 0);
    south.rotation.set(Math.PI / 2, 0, 0);
    poleGroup.add(north, south);
    poleMarks.push(north, south);
    parentMesh.add(poleGroup);
    updatePoleScale();
  }

  function updatePoleScale() {
    if (!poleMarks.length) return;
    const dist = Math.max(camDist(), MIN_DIST);
    const span = Math.max(homeDist - MIN_DIST, 0.01);
    const zoomIn = 1 - THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
    const px = THREE.MathUtils.lerp(POLE_PX_FAR, POLE_PX_NEAR, zoomIn);
    const h = Math.max(height || window.innerHeight || 1, 1);
    const vFov = THREE.MathUtils.degToRad(BASE_FOV);
    const world = (px * dist * 2 * Math.tan(vFov / 2)) / h;
    const s = world / (POLE_GEO_R * 2);
    for (const mark of poleMarks) mark.scale.setScalar(s);
  }

  /**
   * Geographic → mesh-local. Matches SphereGeometry: lon 0 faces +X, north is +Y.
   */
  function latLonToLocal(latDeg, lonDeg, r = RADIUS * 1.014) {
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lon = THREE.MathUtils.degToRad(lonDeg);
    const cl = Math.cos(lat);
    return new THREE.Vector3(
      r * cl * Math.cos(lon),
      r * Math.sin(lat),
      -r * cl * Math.sin(lon)
    );
  }

  function disposeMissionPins() {
    if (!missionGroup) return;
    const geos = new Set();
    missionGroup.traverse((obj) => {
      if (obj.geometry) geos.add(obj.geometry);
      if (obj.material) obj.material.dispose();
    });
    geos.forEach((g) => g.dispose());
    if (missionGroup.parent) missionGroup.parent.remove(missionGroup);
    missionGroup = null;
    missionPins.length = 0;
  }

  function attachMissionPins(parentMesh) {
    disposeMissionPins();
    missionGroup = new THREE.Group();
    missionGroup.name = "mission-pins";
    missionGroup.visible = missionMode !== "off";

    const geo = new THREE.SphereGeometry(0.0125, 10, 10);
    for (const site of SURFACE_SITES) {
      const tier = site.tier || (site.famous ? "quake" : "event");
      const style =
        typeof site.pinColor === "number"
          ? { color: site.pinColor, opacity: 0.98, renderOrder: 5 }
          : tier === "famous"
            ? { color: 0xf0d78c, opacity: 0.98, renderOrder: 5 }
            : tier === "landing"
              ? { color: 0x68bce8, opacity: 0.9, renderOrder: 4 }
              : { color: 0x6bbf8a, opacity: 0.95, renderOrder: 3 };
      const mat = new THREE.MeshBasicMaterial({
        color: style.color,
        transparent: true,
        opacity: style.opacity,
        depthTest: true,
        toneMapped: false,
      });
      const pin = new THREE.Mesh(geo, mat);
      pin.position.copy(latLonToLocal(site.lat, site.lon));
      pin.userData.mission = site;
      pin.userData.tier = tier;
      pin.userData.baseOpacity = style.opacity;
      pin.renderOrder = style.renderOrder;
      missionGroup.add(pin);
      missionPins.push(pin);
    }
    parentMesh.add(missionGroup);
    updateMissionPinFacing();
  }

  function pinInMode(pin) {
    const tier = pin.userData.tier;
    if (missionMode === "all") return true;
    if (missionMode === "famous") return tier === "quake";
    if (missionMode === "landings") return tier === "event";
    return false;
  }

  function setSites(list) {
    SURFACE_SITES = Array.isArray(list) ? list : [];
    if (mesh) attachMissionPins(mesh);
    kick();
    return SURFACE_SITES.length;
  }

  function updateMissionPinFacing() {
    if (missionMode === "off" || !missionPins.length) return;
    _camFromMoon.copy(camera.position).sub(target).normalize();
    for (const pin of missionPins) {
      if (!pinInMode(pin)) {
        pin.visible = false;
        continue;
      }
      pin.getWorldPosition(_pinWorld);
      _pinFromMoon.copy(_pinWorld).sub(target).normalize();
      const facing = _pinFromMoon.dot(_camFromMoon);
      // Hide far side / deep limb; soft-fade near edge
      if (facing < 0.05) {
        pin.visible = false;
      } else {
        pin.visible = true;
        const base = pin.userData.baseOpacity || 0.9;
        pin.material.opacity = THREE.MathUtils.clamp(base * (0.35 + facing * 0.7), base * 0.35, base);
      }
    }
  }

  function clientToNdc(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    _ndc.x = ((clientX - rect.left) / w) * 2 - 1;
    _ndc.y = -((clientY - rect.top) / h) * 2 + 1;
  }

  function pickMissionAt(clientX, clientY) {
    if (missionMode === "off" || !missionPins.length) return null;
    clientToNdc(clientX, clientY);
    raycaster.setFromCamera(_ndc, camera);
    const visiblePins = missionPins.filter((p) => p.visible);
    const hits = raycaster.intersectObjects(visiblePins, false);
    if (hits.length) return hits[0].object.userData.mission || null;
    // Fallback: nearest pin in screen space within ~28px
    let best = null;
    let bestD = 28;
    const rect = canvas.getBoundingClientRect();
    for (const pin of missionPins) {
      if (!pin.visible) continue;
      pin.getWorldPosition(_pinWorld);
      _pinWorld.project(camera);
      if (_pinWorld.z > 1) continue;
      const sx = (_pinWorld.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-_pinWorld.y * 0.5 + 0.5) * rect.height + rect.top;
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d < bestD) {
        bestD = d;
        best = pin.userData.mission;
      }
    }
    return best;
  }

  /** mode: "off" | "famous" | "landings" | "all" */
  function setMissionsMode(mode) {
    missionMode =
      mode === "famous" || mode === "landings" || mode === "all" ? mode : "off";
    if (missionGroup) missionGroup.visible = missionMode !== "off";
    updateMissionPinFacing();
    return missionMode;
  }

  function getMissionsMode() {
    return missionMode;
  }

  function scheduleHigh() {
    if (hqStarted) return;
    hqStarted = true;
    setTimeout(() => upgradeHigh(), 400);
  }

  // Upload now, then drop the decoded bitmap. One 8192×4096 image is ~128 MB
  // in CPU memory and ~170 MB on the GPU with mipmaps. Safari kills the tab
  // when day, night, and clouds are decoded together.
  function releaseDecodedImage(tex) {
    const img = tex && tex.image;
    if (!img || !img.width || !img.height) return;
    const w = img.width;
    const h = img.height;
    try {
      renderer.initTexture(tex);
    } catch (_) {
      return;
    }
    tex.needsUpdate = false;
    // Version stays put, so the GPU copy is what gets drawn.
    tex.image = { width: w, height: h };
    if (typeof img.src === "string") {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    }
  }

  function disposeMap(tex) {
    if (!tex) return;
    const img = tex.image;
    tex.dispose();
    if (img && typeof img.src === "string") {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    }
  }

  function loadLow() {
    const cfg = LOD.low;
    let lowMapReady = false;
    let lowNightReady = false;
    let lowNormalReady = false;
    const maybeSchedule = () => {
      if (lowMapReady && lowNightReady && lowNormalReady) scheduleHigh();
    };
    const map = loader.load(
      cfg.map,
      (tex) => {
        configureColor(tex);
        ready = true;
        if (typeof onReady === "function") onReady();
        reportQuality("2k");
        kick();
        lowMapReady = true;
        maybeSchedule();
      },
      undefined,
      () => {
        lowMapReady = true;
        maybeSchedule();
      }
    );
    const night = loader.load(
      cfg.night,
      (tex) => {
        if (
          !disposed &&
          material &&
          material.userData.nightUniform &&
          material.userData.nightUniform.value === tex
        ) {
          configureNight(tex);
        }
        lowNightReady = true;
        maybeSchedule();
      },
      undefined,
      () => {
        lowNightReady = true;
        maybeSchedule();
      }
    );
    const normal = loader.load(
      cfg.normal,
      (tex) => {
        if (
          !disposed &&
          material &&
          material.userData.normalUniform &&
          material.userData.normalUniform.value === tex
        ) {
          configureNormal(tex);
          kick();
        }
        lowNormalReady = true;
        maybeSchedule();
      },
      undefined,
      () => {
        lowNormalReady = true;
        maybeSchedule();
      }
    );
    configureColor(map);
    configureNight(night);
    configureNormal(normal);
    buildMesh(map, night, normal, cfg);
  }

  function upgradeHigh() {
    if (disposed) return;
    const cfg = LOD.high;
    let dayApplied = false;
    // Let Safari reclaim the previous decode before the next 8k image starts.
    const next = (fn) => setTimeout(fn, 150);

    const loadNormal = () => {
      if (disposed) return;
      loader.load(
        cfg.normal,
        (tex) => {
          if (disposed) return;
          configureNormal(tex);
          releaseDecodedImage(tex);
          if (material && material.userData.normalUniform) {
            const old = material.userData.normalUniform.value;
            material.userData.normalUniform.value = tex;
            if (old && old !== tex) disposeMap(old);
          }
          kick();
          next(loadClouds);
        },
        undefined,
        () => next(loadClouds)
      );
    };

    const loadNight = () => {
      if (disposed) return;
      loader.load(
        cfg.night,
        (tex) => {
          if (disposed) return;
          configureNight(tex);
          releaseDecodedImage(tex);
          if (material && material.userData.nightUniform) {
            const old = material.userData.nightUniform.value;
            material.userData.nightUniform.value = tex;
            if (old && old !== tex) disposeMap(old);
          }
          kick();
          if (dayApplied) reportQuality("8k");
          next(loadNormal);
        },
        undefined,
        () => next(loadNormal)
      );
    };

    loader.load(
      cfg.map,
      (tex) => {
        if (disposed) return;
        if (!material) {
          next(loadNight);
          return;
        }
        configureColor(tex);
        releaseDecodedImage(tex);
        const oldMap = material.map;
        material.map = tex;
        material.needsUpdate = true;
        if (oldMap && oldMap !== tex) disposeMap(oldMap);
        dayApplied = true;
        tilesEnabled = true;
        updateTiles();
        if (mesh && mesh.geometry.parameters.widthSegments < cfg.segments) {
          mesh.geometry.dispose();
          mesh.geometry = new THREE.SphereGeometry(RADIUS, cfg.segments, cfg.segments);
        }
        kick();
        next(loadNight);
      },
      undefined,
      () => next(loadNight)
    );
  }

  let cloudsStarted = false;

  function loadClouds() {
    if (cloudsStarted || disposed) return;
    cloudsStarted = true;
    const stamp = Math.floor(Date.now() / (3 * 3600 * 1000));
    // CDN max is 8192×4096 (~23 MB). 16384 returns HTML, not an image.
    const size = "8192x4096";
    const url = `https://clouds.matteason.co.uk/images/${size}/clouds-alpha.png?t=${stamp}`;
    loader.load(
      url,
      (tex) => {
        if (disposed) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = true;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        tex.needsUpdate = true;
        releaseDecodedImage(tex);
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          color: 0xffffff,
          opacity: 0.92,
        });
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uSunDir = sunDirUniform;
          shader.uniforms.uSunOn = sunOnUniform;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <common>",
            "#include <common>\nvarying vec3 vWorldN;"
          );
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvWorldN = normalize(mat3(modelMatrix) * normalize(position));"
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <common>",
            "#include <common>\nuniform vec3 uSunDir;\nuniform float uSunOn;\nvarying vec3 vWorldN;"
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <alphamap_fragment>",
            `#include <alphamap_fragment>
            float ndl = dot(normalize(vWorldN), normalize(uSunDir));
            float lit = uSunOn * smoothstep(-0.2, 0.35, ndl);
            diffuseColor.a *= mix(0.22, 1.0, lit);`
          );
        };
        cloudMesh = new THREE.Mesh(
          new THREE.SphereGeometry(RADIUS * 1.012, 96, 96),
          mat
        );
        cloudMesh.renderOrder = 2;
        cloudMesh.visible = cloudsOn;
        if (mesh) mesh.add(cloudMesh);
        kick();
      },
      undefined,
      () => {}
    );
  }

  function wrapCol(c, cols) {
    return ((c % cols) + cols) % cols;
  }

  /**
   * Lon/lat under the screen center. The globe mesh rides on the pan
   * target, so the hit sphere must be centered on the mesh in world space
   * — a sphere at the origin misses after any pan and 32 never lands on
   * what you're looking at.
   */
  function viewLonLat() {
    if (!mesh) return null;
    camera.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(_earthSphere.center);
    _earthSphere.radius = RADIUS;
    _tileRay.setFromCamera(_tileNdc, camera);
    const hit = _tileRay.ray.intersectSphere(_earthSphere, _tileHit);
    if (hit) {
      _tileLocal.copy(hit);
    } else {
      _tileRay.ray.closestPointToPoint(_earthSphere.center, _tileHit);
      if (_tileHit.distanceToSquared(_earthSphere.center) < 1e-12) {
        _tileHit.copy(camera.position);
      }
      _tileLocal
        .copy(_tileHit)
        .sub(_earthSphere.center)
        .normalize()
        .multiplyScalar(RADIUS)
        .add(_earthSphere.center);
    }
    mesh.worldToLocal(_tileLocal);
    _tileLocal.normalize();
    const lat = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(_tileLocal.y, -1, 1))
    );
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-_tileLocal.z, _tileLocal.x));
    return { lat, lon };
  }

  /** Neighbor rings to cover the close-up view (keep GPU load in check). */
  function tileRing(level) {
    // 3×3 is enough now that tile edges are opaque; 5×5 thrashed phones.
    return 1;
  }

  function neededTileKeys(level, lon, lat, ring) {
    let u = (lon + 180) / 360;
    u = ((u % 1) + 1) % 1;
    const v = THREE.MathUtils.clamp((90 - lat) / 180, 0, 0.9999);
    const c0 = Math.floor(u * level.cols);
    const r0 = Math.min(level.rows - 1, Math.floor(v * level.rows));
    const cols = new Set();
    const rows = new Set();
    const r = Math.max(0, ring | 0);
    for (let dc = -r; dc <= r; dc++) cols.add(wrapCol(c0 + dc, level.cols));
    for (let dr = -r; dr <= r; dr++) {
      const rr = r0 + dr;
      if (rr >= 0 && rr < level.rows) rows.add(rr);
    }
    const keys = [];
    for (const row of rows) {
      for (const c of cols) keys.push(`${level.label}:${c}:${row}`);
    }
    return keys;
  }

  function ensureTileGroup() {
    if (!tileGroup) {
      tileGroup = new THREE.Group();
      tileGroup.name = "zoom-tiles";
    }
    if (mesh && tileGroup.parent !== mesh) mesh.add(tileGroup);
  }

  function dropTile(key) {
    const piece = tileLive.get(key);
    if (!piece) return;
    tileLive.delete(key);
    if (piece.parent) piece.parent.remove(piece);
    piece.geometry.dispose();
    disposeMap(piece.material.map);
    piece.material.dispose();
  }

  function hideTiles() {
    tileWanted = new Set();
    if (tileGroup) tileGroup.visible = false;
    for (const key of [...tileLive.keys()]) dropTile(key);
    if (tileLevel) {
      tileLevel = null;
      reportQuality("8k");
    }
  }

  function tileUrl(level, c, r) {
    return `${level.folder}/c${c}r${r}.jpg?v=${TEX_VER}`;
  }

  function makeTilePatch(level, c, r, tex) {
    const phiStart = (c / level.cols) * Math.PI * 2;
    const phiLength = (1 / level.cols) * Math.PI * 2;
    const thetaStart = (r / level.rows) * Math.PI;
    const thetaLength = (1 / level.rows) * Math.PI;
    const geo = new THREE.SphereGeometry(
      RADIUS * level.radius,
      48,
      48,
      phiStart,
      phiLength,
      thetaStart,
      thetaLength
    );
    const nightU = material.userData.nightUniform;
    const normalU = material.userData.normalUniform;
    const mat = makeTileMaterial(tex, nightU, normalU);
    const piece = new THREE.Mesh(geo, mat);
    piece.renderOrder = 1;
    piece.userData.tileKey = `${level.label}:${c}:${r}`;
    return piece;
  }

  function loadTile(level, key) {
    if (tileLive.has(key) || tileLoading.has(key) || disposed || !material) return;
    tileLoading.add(key);
    const parts = key.split(":");
    const c = Number(parts[1]);
    const r = Number(parts[2]);
    loader.load(
      tileUrl(level, c, r),
      (tex) => {
        tileLoading.delete(key);
        if (
          disposed ||
          !tilesEnabled ||
          !tileGroup ||
          !tileGroup.visible ||
          !tileWanted.has(key) ||
          tileLevel !== level.label
        ) {
          tex.dispose();
          return;
        }
        if (tileLive.has(key)) {
          tex.dispose();
          return;
        }
        configureTileColor(tex);
        releaseDecodedImage(tex);
        ensureTileGroup();
        const piece = makeTilePatch(level, c, r, tex);
        tileGroup.add(piece);
        tileLive.set(key, piece);
        reportQuality(level.label);
        kick();
      },
      undefined,
      () => tileLoading.delete(key)
    );
  }

  function updateTiles() {
    if (disposed || !tilesEnabled || !mesh || !material) return;
    const dist = camDist();
    const level = pickTileLevel(dist);
    if (!level) {
      hideTiles();
      return;
    }
    const at = viewLonLat();
    if (!at) {
      hideTiles();
      return;
    }
    if (tileLevel && tileLevel !== level.label) {
      for (const key of [...tileLive.keys()]) dropTile(key);
      tileWanted = new Set();
    }
    tileLevel = level.label;
    ensureTileGroup();
    tileGroup.visible = true;
    const ring = tileRing(level);
    const want = new Set(neededTileKeys(level, at.lon, at.lat, ring));
    // Keep one extra ring so a drag doesn't flash soft 8k while neighbors load.
    const keep = new Set(neededTileKeys(level, at.lon, at.lat, ring + 1));
    tileWanted = want;
    for (const key of [...tileLive.keys()]) {
      if (!keep.has(key)) dropTile(key);
    }
    for (const key of want) loadTile(level, key);
  }

  function captureSkyPose() {
    frozenLat = observerLat;
    frozenLon = observerLon;
    frozenSouthern = observerLat < 0;
  }

  function subsolarPoint(date) {
    const A = globalThis.Astronomy;
    const time = A.MakeTime(date);
    const sun = A.Equator(A.Body.Sun, time, new A.Observer(0, 0, 0), true, true);
    const gast = A.SiderealTime(time);
    let lon = (sun.ra - gast) * 15;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return { lat: sun.dec, lon };
  }

  function applyEphemeris() {
    const A = globalThis.Astronomy;
    if (!A) return;

    let sub = { lat: 0, lon: 0 };
    try {
      sub = subsolarPoint(when);
    } catch (_) {}

    const placeLon = orientLocked ? frozenLon : observerLon;
    if (mesh) {
      // Polar axis stays straight up. Longitude only. The camera, not the
      // planet, is what sits on the user's latitude — otherwise a spin that
      // keeps the US upright rolls Africa onto its side.
      mesh.rotation.order = "XYZ";
      mesh.rotation.x = 0;
      mesh.rotation.y = -Math.PI / 2 - THREE.MathUtils.degToRad(placeLon);
      mesh.rotation.z = 0;
    }
    moonGroup.rotation.set(0, 0, 0);
    moonGroup.position.copy(target);

    const sunLocal = latLonToLocal(sub.lat, sub.lon, 12);
    if (mesh) sunLocal.applyEuler(mesh.rotation);
    key.position.copy(target).add(sunLocal);
    key.target.position.copy(target);
    sunDir.copy(sunLocal).normalize();
    updateViewLighting();
    kick();

    const hours =
      when.getHours() + when.getMinutes() / 60 + when.getSeconds() / 3600;
    lastPhaseInfo = {
      phase01: hours / 24,
      fraction: 0.5,
      illuminated: 0.5,
      name: "Earth",
      lat: observerLat,
      lon: observerLon,
      when: new Date(when.getTime()),
      subLat: sub.lat,
      subLon: sub.lon,
      southern: observerLat < 0,
      orientLocked,
    };
    if (typeof onPhase === "function") onPhase(lastPhaseInfo);
  }

  function setClouds(on) {
    cloudsOn = !!on;
    if (cloudMesh) cloudMesh.visible = cloudsOn;
    kick();
    return cloudsOn;
  }

  /** Contiguous oval on one longitude. Stops at a gap or the equator. */
  function auroraBand(col, southern) {
    let peakLat = 0;
    let peakA = -1;
    for (const [lat, cell] of col) {
      if ((lat < 0) !== southern) continue;
      if (cell.a > peakA) {
        peakA = cell.a;
        peakLat = lat;
      }
    }
    if (peakA < AURORA_MIN) return null;
    const latMin = southern ? -90 : 0;
    const latMax = southern ? -1 : 90;
    let lo = peakLat;
    let hi = peakLat;
    while (lo > latMin && col.has(lo - 1)) lo--;
    while (hi < latMax && col.has(hi + 1)) hi++;
    return { lo, hi };
  }

  /** Chance at a fractional latitude, blended between the two NOAA samples. */
  function chanceAt(col, lo, hi, lat) {
    if (lat < lo || lat > hi) return null;
    const a0 = Math.floor(lat);
    const a1 = Math.ceil(lat);
    if (a0 === a1) return col.has(a0) ? col.get(a0).a : null;
    const c0 = col.get(a0);
    const c1 = col.get(a1);
    if (!c0 && !c1) return null;
    if (!c0) return Math.abs(lat - a1) <= 0.5 ? c1.a : null;
    if (!c1) return Math.abs(lat - a0) <= 0.5 ? c0.a : null;
    const f = lat - a0;
    return c0.a * (1 - f) + c1.a * f;
  }

  /**
   * NOAA chance sets where the oval is and how bright. Color, when the
   * tables have loaded, is the electron energy at that geographic point.
   * Until then the oval stays the green that reads cleanly.
   */
  function paintAuroraColumn(data, w, h, x, col, southern, colorAt) {
    const raw = auroraBand(col, southern);
    if (!raw) return;
    const sub = (h - 1) / 180;
    const steps = Math.round((raw.hi - raw.lo) * sub);
    const lon = (((x - 180) % 360) + 360) % 360;
    for (let i = 0; i <= steps; i++) {
      const lat = raw.lo + i / sub;
      const a = chanceAt(col, raw.lo, raw.hi, lat);
      if (!(a >= AURORA_MIN)) continue;
      // Quiet peaks (~15) must still read as a ribbon; storms clamp at 1.
      const t = Math.min(1, Math.pow(a / AURORA_PEAK_REF, 0.85));
      const rgb = colorAt ? colorAt(lat, lon) : [36, 200, 34];
      const alpha = Math.min(255, Math.floor(255 * Math.min(1, t * 1.25)));
      const y = Math.round((90 - lat) * sub);
      if (y < 0 || y >= h) continue;
      const o = (y * w + x) * 4;
      if (alpha >= data[o + 3]) {
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = alpha;
      }
    }
  }

  function blurKernel(sigma) {
    const radius = Math.max(1, Math.ceil(sigma * 2.5));
    const k = new Float32Array(radius * 2 + 1);
    let sum = 0;
    const inv = 1 / (sigma * sigma);
    for (let i = -radius; i <= radius; i++) {
      const wgt = Math.exp(-0.5 * i * i * inv);
      k[i + radius] = wgt;
      sum += wgt;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return { k, radius };
  }

  /**
   * Feather the 1° NOAA steps and the red/green handoff.
   * About one degree of latitude, and 1.3° of arc along a parallel.
   */
  function smoothAurora(src, w, h) {
    const n = w * h;
    const pr = new Float32Array(n);
    const pg = new Float32Array(n);
    const pb = new Float32Array(n);
    const pa = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = src[i * 4 + 3] / 255;
      pr[i] = src[i * 4] * a;
      pg[i] = src[i * 4 + 1] * a;
      pb[i] = src[i * 4 + 2] * a;
      pa[i] = a;
    }
    // ~0.6° of latitude on the 721-tall map — enough to hide 1° steps,
    // not enough to erase a quiet-day ribbon after the alpha dilutes.
    const ky = blurKernel(2.5);
    const vr = new Float32Array(n);
    const vg = new Float32Array(n);
    const vb = new Float32Array(n);
    const va = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - ky.radius);
      const y1 = Math.min(h - 1, y + ky.radius);
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let ws = 0;
        for (let yy = y0; yy <= y1; yy++) {
          const wgt = ky.k[yy - y + ky.radius];
          const i = yy * w + x;
          r += pr[i] * wgt;
          g += pg[i] * wgt;
          b += pb[i] * wgt;
          a += pa[i] * wgt;
          ws += wgt;
        }
        const o = y * w + x;
        const inv = ws > 0 ? 1 / ws : 0;
        vr[o] = r * inv;
        vg[o] = g * inv;
        vb[o] = b * inv;
        va[o] = a * inv;
      }
    }
    const pyPerDeg = (h - 1) / 180;
    for (let y = 0; y < h; y++) {
      const lat = 90 - y / pyPerDeg;
      const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      const kx = blurKernel(Math.max(0.6, (1.0 / cos) * (w / 360)));
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let t = -kx.radius; t <= kx.radius; t++) {
          const xx = (x + t + w) % w;
          const wgt = kx.k[t + kx.radius];
          const i = y * w + xx;
          r += vr[i] * wgt;
          g += vg[i] * wgt;
          b += vb[i] * wgt;
          a += va[i] * wgt;
        }
        const o = (y * w + x) * 4;
        if (a < 2 / 255) {
          src[o] = 0;
          src[o + 1] = 0;
          src[o + 2] = 0;
          src[o + 3] = 0;
          continue;
        }
        const inv = 1 / a;
        src[o] = Math.max(0, Math.min(255, Math.round(r * inv)));
        src[o + 1] = Math.max(0, Math.min(255, Math.round(g * inv)));
        src[o + 2] = Math.max(0, Math.min(255, Math.round(b * inv)));
        src[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
      }
    }
  }

  function buildAuroraTexture(coords, colorAt) {
    const w = AURORA_TEX_W;
    const h = AURORA_TEX_H;
    const data = new Uint8Array(w * h * 4);
    if (!Array.isArray(coords)) {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
      // Additive glow — keep authored values, do not sRGB-decode.
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = true;
      tex.needsUpdate = true;
      return tex;
    }
    // One column per longitude. Each entry is the brightest cell at that latitude.
    const cols = new Array(w);
    for (let x = 0; x < w; x++) cols[x] = new Map();
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (!c || c.length < 3) continue;
      const lon = Number(c[0]);
      const lat = Number(c[1]);
      const a = Number(c[2]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !(a >= AURORA_MIN)) continue;
      // Greenwich sits at texture u=0.5, so lon 0 → column 180.
      const x = (((Math.round(lon) + 180) % 360) + 360) % 360;
      const latR = Math.round(lat);
      if (x < 0 || x >= w || latR < -90 || latR > 90) continue;
      const prev = cols[x].get(latR);
      if (!prev || a > prev.a) cols[x].set(latR, { a });
    }
    for (let x = 0; x < w; x++) {
      const col = cols[x];
      if (!col.size) continue;
      paintAuroraColumn(data, w, h, x, col, false, colorAt);
      paintAuroraColumn(data, w, h, x, col, true, colorAt);
    }
    smoothAurora(data, w, h);
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  function ensureAuroraMesh() {
    if (auroraMesh) return;
    auroraMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldN;
        void main() {
          vUv = uv;
          vWorldN = normalize(mat3(modelMatrix) * normalize(position));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uSunDir;
        varying vec2 vUv;
        varying vec3 vWorldN;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          if (tex.a < 0.02) discard;
          float ndl = dot(normalize(vWorldN), normalize(uSunDir));
          // Full strength on the night side; keep a readable ribbon in daylight.
          float wash = mix(0.4, 1.35, smoothstep(0.55, -0.45, ndl));
          float glow = tex.a * wash;
          if (glow < 0.02) discard;
          gl_FragColor = vec4(tex.rgb * glow, 1.0);
        }
      `,
      uniforms: {
        uMap: { value: null },
        uSunDir: sunDirUniform,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    auroraMesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS * AURORA_HEIGHT, 96, 64),
      auroraMat
    );
    auroraMesh.renderOrder = 4;
    auroraMesh.visible = false;
    if (mesh) mesh.add(auroraMesh);
  }

  function setAurora(coords, drive) {
    ensureAuroraMesh();
    auroraCoords = coords;
    if (drive && Number.isFinite(drive.dF)) auroraDrive = drive;
    let colorAt = null;
    if (ovationTables && auroraDrive && Number.isFinite(auroraDrive.dF)) {
      try {
        colorAt = makeAuroraColor(ovationTables, auroraDrive.dF, auroraDrive.when || new Date());
      } catch (_) {
        colorAt = null;
      }
    }
    const next = buildAuroraTexture(coords, colorAt);
    const prev = auroraTex;
    auroraTex = next;
    auroraMat.uniforms.uMap.value = next;
    if (prev && prev !== next) prev.dispose();
    let any = false;
    if (Array.isArray(coords)) {
      for (let i = 0; i < coords.length; i++) {
        const a = Number(coords[i] && coords[i][2]);
        if (a >= AURORA_MIN) {
          any = true;
          break;
        }
      }
    }
    auroraHas = any;
    auroraMesh.visible = auroraHas;
    kick();
    return any;
  }

  function setSun(on) {
    sunOnUniform.value = on ? 1 : 0;
    kick();
    return sunOnUniform.value > 0.5;
  }

  function getDayLook() {
    return { ...dayLook };
  }

  function setDayLook(partial = {}) {
    if (Number.isFinite(partial.landGain)) dayLook.landGain = partial.landGain;
    if (Number.isFinite(partial.shadeMin)) dayLook.shadeMin = partial.shadeMin;
    if (Number.isFinite(partial.shadeMax)) dayLook.shadeMax = partial.shadeMax;
    if (Number.isFinite(partial.reliefStr)) dayLook.reliefStr = partial.reliefStr;
    if (Number.isFinite(partial.slope)) dayLook.slope = partial.slope;
    uLandGain.value = dayLook.landGain;
    uShadeMin.value = dayLook.shadeMin;
    uShadeMax.value = dayLook.shadeMax;
    uReliefStr.value = dayLook.reliefStr;
    uSlope.value = dayLook.slope;
    kick();
    return getDayLook();
  }

  function setObserver(lat, lon) {
    let la = Number(lat);
    let lo = Number(lon);
    if (!Number.isFinite(la)) la = 0;
    if (!Number.isFinite(lo)) lo = 0;
    observerLat = THREE.MathUtils.clamp(la, -90, 90);
    while (lo > 180) lo -= 360;
    while (lo < -180) lo += 360;
    observerLon = lo;
    if (orientLocked) captureSkyPose(new Date());
    applyEphemeris();
    return getPhaseInfo();
  }

  function setTime(date = new Date(), opts = {}) {
    when = date instanceof Date ? date : new Date(date);
    if (opts.lockOrient === false) {
      orientLocked = false;
    } else if (opts.lockOrient === true && !orientLocked) {
      captureSkyPose(opts.orientDate || new Date());
      orientLocked = true;
    }
    applyEphemeris();
    return getPhaseInfo();
  }

  function getPhaseInfo() {
    return lastPhaseInfo;
  }

  function getObserver() {
    return { lat: observerLat, lon: observerLon };
  }

  function earthViewAmount() {
    _camDir.copy(camera.position).sub(target).normalize();
    return THREE.MathUtils.smoothstep(0.38, 0.88, _camDir.z);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function updateViewLighting() {
    ambient.intensity = 0.22;
    earthshine.intensity = 0.08;
    key.color.setHex(0xfff8f0);
    key.intensity = 3.4;
    if (material && material.emissive) {
      material.emissiveIntensity = 0.06;
      if (material.emissive) material.emissive.setHex(0x0a1020);
      if (material.color) material.color.setRGB(1, 1, 1);
    }
  }

  function readHomePadsPx() {
    let top = 48;
    let bottom = 248;
    if (typeof document !== "undefined") {
      const bar = document.getElementById("loc-bar");
      const chrome = document.querySelector(".chrome");
      if (chrome) {
        const h = chrome.getBoundingClientRect().height;
        if (h > 0) top = Math.ceil(h);
      } else {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:absolute;visibility:hidden;pointer-events:none;width:0";
        document.body.appendChild(probe);
        probe.style.height = "calc(2rem + env(safe-area-inset-top, 0px))";
        top = probe.offsetHeight || top;
        probe.remove();
      }
      if (bar) {
        const h = bar.getBoundingClientRect().height;
        if (h > 0) bottom = Math.ceil(h);
      } else {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:absolute;visibility:hidden;pointer-events:none;width:0";
        document.body.appendChild(probe);
        probe.style.height = "15.5rem";
        bottom = probe.offsetHeight || bottom;
        probe.remove();
      }
    }
    return { top, bottom };
  }

  /**
   * Home distance for full-window canvas: disk sized to the band above the
   * bottom info area. Zoom can still go closer and fill the whole screen.
   */
  function computeHomeDistance(w, h) {
    const pads = readHomePadsPx();
    const availH = Math.max(160, h - pads.top - pads.bottom);
    const availW = Math.max(160, w - 24);
    // Always size home against the *viewport* FOV (BASE_FOV), not the buffer FOV
    const vFov = THREE.MathUtils.degToRad(BASE_FOV);
    const aspect = Math.max(w, 1) / Math.max(h, 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fit = HOME_FILL;
    const distV = (RADIUS * h) / (fit * availH * Math.tan(vFov / 2));
    const distH = (RADIUS * w) / (fit * availW * Math.tan(hFov / 2));
    return Math.max(distV, distH, MIN_DIST + 0.2);
  }

  /** Furthest camera distance (past opening zoom). */
  function maxCamDist() {
    return Math.max(homeDist * MAX_OUT_FACTOR, homeDist + 0.5, MIN_DIST + 0.2);
  }

  /** Pan only when closer than the opening zoom. */
  function canPan() {
    return camDist() < homeDist - 1e-3;
  }

  function readSpherical() {
    _offset.copy(camera.position).sub(target);
    if (_offset.lengthSq() < 1e-12) _offset.set(0, 0, homeDist || 3);
    spherical.setFromVector3(_offset);
  }

  function writeCamera() {
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, MIN_POLAR, MAX_POLAR);
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius,
      MIN_DIST,
      maxCamDist()
    );
    spherical.makeSafe();
    _offset.setFromSpherical(spherical);
    camera.position.copy(target).add(_offset);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    // Near plane must be *closer* than the front of the sphere (dist − RADIUS).
    // Default near=0.05 clipped the moon when zoomed in → hard L/R edges.
    const dist = spherical.radius;
    const frontGap = dist - RADIUS; // distance camera → front of disk
    camera.near = Math.max(0.001, frontGap * 0.35);
    camera.far = Math.max(200, dist + 40);
    camera.updateProjectionMatrix();
    updatePoleScale();
    if (typeof onZoom === "function") onZoom(spherical.radius);
    kick();
  }

  function camDist() {
    return camera.position.distanceTo(target);
  }

  function syncMoon() {
    moonGroup.position.copy(target);
    key.target.position.copy(target);
    updateAtmosphereLight();
  }

  /** Extra home lift above safe-band center (CSS px for 0.375in = 1/4" + 1/8"). */
  function homeExtraUpPx() {
    let px = 36; // 0.375in @ 96dpi fallback
    if (typeof document !== "undefined") {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;pointer-events:none;width:0;height:0.375in";
      document.body.appendChild(probe);
      px = probe.offsetHeight || px;
      probe.remove();
    }
    return px;
  }

  function measureCssLength(cssLen, fallbackPx) {
    if (typeof document === "undefined") return fallbackPx;
    const probe = document.createElement("div");
    probe.style.cssText =
      `position:absolute;visibility:hidden;pointer-events:none;width:0;height:${cssLen}`;
    document.body.appendChild(probe);
    const px = probe.offsetHeight || fallbackPx;
    probe.remove();
    return px;
  }

  /**
   * Positive = shift home moon down (CSS translateY).
   * Phone Safari (browser tab only): +1/8". Phone PWA / Chrome: unchanged.
   * iPad: +1/8". Mac / desktop: +1/4".
   */
  function isPhoneSafariBrowser() {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return false;
    }
    const ua = navigator.userAgent || "";
    if (!/iPhone|iPod/.test(ua)) return false;
    // Home-screen / standalone PWA keeps original framing
    if (
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches
    ) {
      return false;
    }
    // Chrome / Firefox / Edge on iOS — not Safari
    if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua)) return false;
    return /Safari/i.test(ua);
  }

  function homeLowerBiasPx() {
    if (typeof window === "undefined") return 0;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const minSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
    // Phone Safari tab: nudge moon down 1/8" at startup / Live home
    if (coarse && minSide <= 500) {
      if (isPhoneSafariBrowser()) return measureCssLength("0.125in", 12);
      return 0;
    }
    // iPad / large tablets
    if (coarse) return measureCssLength("0.125in", 12);
    // MacBook / desktop
    return measureCssLength("0.25in", 24);
  }

  /** CSS Y so home moon sits in the upper safe band (above bottom info), not mid-screen. */
  function homeScreenOffsetY() {
    const pads = readHomePadsPx();
    // Safe-band center is above the viewport center when bottom pad > top pad.
    // CSS translateY: negative = content moves up. Extra 3/8" on startup.
    return (pads.top - pads.bottom) / 2 - homeExtraUpPx() + homeLowerBiasPx();
  }

  function applyHomeFraming() {
    target.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, homeDist);
    clearScreenPan();
    // Phone home: lift into top band (fades out as you zoom — see applyCanvasPanTransform)
    homeLiftY = homeScreenOffsetY();
    applyCanvasPanTransform();
    readSpherical();
    spherical.theta = 0;
    spherical.phi = Math.PI / 2 - THREE.MathUtils.degToRad(observerLat);
    writeCamera();
    syncMoon();
    prevCamDist = homeDist;
    applyEphemeris();
  }

  function setCamDist(dist) {
    dist = THREE.MathUtils.clamp(dist, MIN_DIST, maxCamDist());
    // Opening → full out: stay centered (no pan). Keep orbit angles.
    if (dist >= homeDist - 1e-4) {
      target.set(0, 0, 0);
      clearScreenPan();
      homeLiftY = homeScreenOffsetY();
      readSpherical();
      spherical.radius = dist;
      writeCamera();
      syncMoon();
      prevCamDist = camDist();
      applyCanvasPanTransform();
      return;
    }
    readSpherical();
    spherical.radius = dist;
    writeCamera();
    prevCamDist = camDist();
    // Re-apply pan so home lift eases out toward full-bleed zoom
    applyCanvasPanTransform();
  }

  /**
   * 2fs pan — CSS translate (works on phone) within a larger GL buffer so
   * sliding never reveals empty L/R “edges”.
   */
  let screenPanX = 0;
  let screenPanY = 0;
  /** Home-only vertical lift; faded to 0 as camera dollies in (full-bleed zoom). */
  let homeLiftY = 0;

  function homeLiftFade() {
    const dist = camDist();
    const span = Math.max(homeDist - MIN_DIST, 0.01);
    // 1 at home distance, 0 at max zoom
    const t = THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
    return t * t;
  }

  function applyCanvasPanTransform() {
    // Canvas is already offset by -panMarginPx so viewport shows the center.
    // User pan is added on top; clamp so we stay inside the buffer.
    const lift = homeLiftY * homeLiftFade();
    const x = THREE.MathUtils.clamp(screenPanX, -panMarginPx, panMarginPx);
    const y = THREE.MathUtils.clamp(screenPanY + lift, -panMarginPx, panMarginPx);
    screenPanX = x;
    // Keep user pan separate from home lift in stored screenPanY
    screenPanY = THREE.MathUtils.clamp(screenPanY, -panMarginPx, panMarginPx);
    canvas.style.transform = `translate(${x}px, ${y}px)`;
  }

  function panCamera(dxPx, dyPx) {
    if (!canPan()) return;
    if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return;

    screenPanX += dxPx;
    screenPanY += dyPx;
    applyCanvasPanTransform();

    // Keep 3D pivot in sync with the slide
    camera.updateMatrixWorld(true);
    const dist = Math.max(camDist(), MIN_DIST);
    const vFov = THREE.MathUtils.degToRad(BASE_FOV);
    const h = Math.max(height || window.innerHeight || 1, 1);
    const worldPerPx = (2.2 * dist * Math.tan(vFov / 2)) / h;
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    const sx = -dxPx * worldPerPx;
    const sy = dyPx * worldPerPx;
    target.addScaledVector(_right, sx);
    target.addScaledVector(_up, sy);
    camera.position.addScaledVector(_right, sx);
    camera.position.addScaledVector(_up, sy);
    if (target.length() > MAX_PAN) {
      const s = MAX_PAN / target.length();
      const nt = target.clone().multiplyScalar(s);
      camera.position.add(nt.clone().sub(target));
      target.copy(nt);
    }
    syncMoon();
    readSpherical();
  }

  function clearScreenPan() {
    screenPanX = 0;
    screenPanY = 0;
    applyCanvasPanTransform();
  }

  function fitToHost() {
    // Size to the real clip host so the canvas always fills edge-to-edge
    // (window.innerHeight can be short of the fixed host on iOS).
    const host = canvas.parentElement;
    let w = window.innerWidth || document.documentElement.clientWidth || 1;
    let h = window.innerHeight || document.documentElement.clientHeight || 1;
    if (host) {
      const rect = host.getBoundingClientRect();
      if (rect.width > 0) w = Math.max(w, rect.width);
      if (rect.height > 0) h = Math.max(h, rect.height);
      // If host stopped above the visual bottom (home-indicator band), extend
      const gap = Math.max(0, (window.innerHeight || 0) - rect.bottom);
      if (gap > 0 && gap < 80) h += gap;
    }
    const vv = window.visualViewport;
    if (vv) {
      w = Math.max(w, vv.width || 0);
      h = Math.max(h, vv.height || 0, (vv.offsetTop || 0) + (vv.height || 0));
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    // Share sheet and the keyboard cover the page while iOS snapshots it.
    // Rebuilding the GL buffer then keeps two copies and kills the tab.
    const covered =
      vv && (vv.height || 0) > 0 && (vv.height || 0) < (window.innerHeight || h) - 48;
    if (width > 0 && Math.abs(w - width) < 80 && (h < height - 48 || covered)) return;
    resize(w, h);
  }

  function drawingRatio(bufW, bufH) {
    let ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    // iOS copies this whole buffer for the share preview. Past 4096 on a side,
    // that copy is what shows "A problem repeatedly occurred."
    const longSide = Math.max(bufW, bufH);
    if (isTouch && longSide * ratio > 4096) ratio = 4096 / longSide;
    return ratio;
  }

  function resize(cssW, cssH) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (w === width && h === height && bufferW > 0) return;

    const prevHome = homeDist;
    const dist = camDist();
    const centered = target.lengthSq() < 1e-4;
    const atOpening = centered && Math.abs(dist - prevHome) / Math.max(prevHome, 0.01) < 0.03;
    const zoomFrac = prevHome > 0 ? dist / prevHome : 1;

    width = w;
    height = h;
    // Base pan buffer for 2fs. Also must cover home CSS lift (moon sits high so
    // bottom of host stays filled — otherwise a black strip clips the moon).
    const homeLift = Math.abs(homeScreenOffsetY());
    const liftRoom = Math.ceil(homeLift + 48);
    panMarginPx = Math.max(Math.ceil(Math.max(w, h) * PAN_MARGIN), liftRoom);
    // Trim only the spare pan margin so a phone can stay at full device pixels
    // and still keep the share-sheet copy at or under 4096 on a side.
    if (isTouch) {
      const ratioCap = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
      const room = Math.floor((Math.floor(4096 / ratioCap) - Math.max(w, h)) / 2);
      if (room >= liftRoom) panMarginPx = Math.min(panMarginPx, room);
    }
    bufferW = w + 2 * panMarginPx;
    bufferH = h + 2 * panMarginPx;

    // Wider FOV on the large buffer so the *center* w×h crop matches BASE_FOV
    const baseFovRad = THREE.MathUtils.degToRad(BASE_FOV);
    camera.fov =
      (2 *
        Math.atan(Math.tan(baseFovRad / 2) * (bufferH / h)) *
        180) /
      Math.PI;
    camera.aspect = bufferW / bufferH;
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(drawingRatio(bufferW, bufferH));
    renderer.setSize(bufferW, bufferH, false);
    if (starfield?.material) {
      starfield.material.size = starPointSize();
    }

    canvas.style.position = "absolute";
    canvas.style.width = `${bufferW}px`;
    canvas.style.height = `${bufferH}px`;
    canvas.style.left = `${-panMarginPx}px`;
    canvas.style.top = `${-panMarginPx}px`;
    if (camera.view && camera.view.enabled) camera.clearViewOffset();
    applyCanvasPanTransform();

    homeDist = computeHomeDistance(w, h);
    if (atOpening && !orbiting) {
      applyHomeFraming();
    } else if (centered) {
      // Keep outer / opening zoom fraction; stay centered
      homeLiftY = homeScreenOffsetY();
      applyCanvasPanTransform();
      readSpherical();
      spherical.radius = THREE.MathUtils.clamp(
        homeDist * zoomFrac,
        MIN_DIST,
        maxCamDist()
      );
      writeCamera();
      syncMoon();
      prevCamDist = camDist();
    } else setCamDist(homeDist * zoomFrac);
  }

  function resetView() {
    camera.far = 200;
    homeDist = computeHomeDistance(
      width || window.innerWidth,
      height || window.innerHeight
    );
    applyHomeFraming();
  }

  // —— Touch + pointer: 2fs pans the canvas (CSS) so movement is always visible ——

  const UI_HIT =
    "input,button,select,textarea,a,label,#loc-dialog,.leaflet-container,.loc-dialog,#mission-sheet,#fact-sheet,.cycle,.slider-track,.cycle-controls,.m-cell-fact,.vision-btn,.geo-btn,.live-btn,.sun-btn,.day-look,#day-look,.fact-sheet-inner,.fact-sheet-scrim";

  function eventPoint(e) {
    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      return { x: e.clientX, y: e.clientY };
    }
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (t) return { x: t.clientX, y: t.clientY };
    return null;
  }

  function nodeIsUi(el) {
    return !!(el && el.closest && el.closest(UI_HIT));
  }

  function uiControlAt(pt) {
    if (!pt) return null;
    const roots = ["fact-sheet", "loc-dialog", "mission-sheet", "loc-bar"];
    for (const id of roots) {
      const root = document.getElementById(id);
      if (!root || root.hasAttribute("hidden")) continue;
      const ctrls = root.querySelectorAll(
        "button,input,select,textarea,a,.cycle,.slider-track,.cycle-controls,.leaflet-container,.fact-sheet-scrim"
      );
      for (const ctrl of ctrls) {
        const r = ctrl.getBoundingClientRect();
        if (pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom) {
          return ctrl;
        }
      }
    }
    return null;
  }

  function isFormControl(el, e) {
    if (nodeIsUi(el)) return true;
    if (e && typeof e.composedPath === "function") {
      for (const n of e.composedPath()) {
        if (nodeIsUi(n)) return true;
      }
    }
    return !!uiControlAt(e && eventPoint(e));
  }

  let uiClickAt = 0;

  function passToUi(e) {
    const ctrl = uiControlAt(eventPoint(e));
    if (!isFormControl(e.target, e) && !ctrl) return false;
    if (ctrl && e.target !== ctrl && !(typeof ctrl.contains === "function" && ctrl.contains(e.target))) {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - uiClickAt > 400 && typeof ctrl.click === "function" && ctrl.type !== "range") {
        uiClickAt = now;
        ctrl.click();
      }
    }
    return true;
  }

  function touchPair(list) {
    if (!list || list.length < 2) return null;
    const a = list[0];
    const b = list[1];
    return {
      midX: (a.clientX + b.clientX) / 2,
      midY: (a.clientY + b.clientY) / 2,
      span: Math.max(
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        1
      ),
    };
  }

  function fireTapIfAny(gesture) {
    if (!gesture || gesture.moved) return;
    if (Date.now() - gesture.t0 > TAP_MAX_MS) return;
    const x = Number.isFinite(gesture.sx) ? gesture.sx : gesture.x;
    const y = Number.isFinite(gesture.sy) ? gesture.sy : gesture.y;
    if (missionMode !== "off" && Number.isFinite(x) && Number.isFinite(y)) {
      const site = pickMissionAt(x, y);
      if (site && typeof onMissionTap === "function") {
        onMissionTap(site);
        return;
      }
    }
    if (typeof onTap === "function") onTap();
  }

  function onTouchStart(e) {
    if (e.touches.length === 1 && passToUi(e)) return;
    e.preventDefault();
    if (e.touches.length >= 2) {
      twoFinger = touchPair(e.touches);
      oneFinger = null;
    } else if (e.touches.length === 1) {
      twoFinger = null;
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      oneFinger = { x, y, sx: x, sy: y, t0: Date.now(), moved: false };
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 0) return;
    if (e.touches.length === 1 && isFormControl(e.target, e) && !oneFinger) return;
    e.preventDefault();

    if (e.touches.length >= 2) {
      const now = touchPair(e.touches);
      if (!now) return;
      if (!twoFinger) {
        twoFinger = now;
        return;
      }
      // 2fs = pan
      panCamera(now.midX - twoFinger.midX, now.midY - twoFinger.midY);
      // Pinch = zoom (full-screen canvas, no L/R letterbox from CSS)
      const ratio = now.span / twoFinger.span;
      if (Math.abs(Math.log(ratio)) > PINCH_EPS) {
        setCamDist(camDist() / Math.pow(Math.max(ratio, 0.05), PINCH_POWER));
      }
      twoFinger = now;
      return;
    }

    if (oneFinger && e.touches.length === 1) {
      const t = e.touches[0];
      const fromStart = Math.hypot(t.clientX - oneFinger.sx, t.clientY - oneFinger.sy);
      if (fromStart > TAP_SLOP_PX) oneFinger.moved = true;
      // Don't orbit until past tap slop (keeps tap clean)
      if (!oneFinger.moved) return;
      const dx = t.clientX - oneFinger.x;
      const dy = t.clientY - oneFinger.y;
      const h = Math.max(height, 1);
      const dist = camDist();
      const z = THREE.MathUtils.clamp(
        (dist - MIN_DIST) / Math.max(homeDist - MIN_DIST, 0.01),
        0,
        1
      );
      // Close zoom: slow orbit so a drag doesn't whip the surface away.
      const speed = THREE.MathUtils.lerp(0.07, 0.55, z * z);
      readSpherical();
      spherical.theta -= (2 * Math.PI * dx * speed) / h;
      spherical.phi -= (2 * Math.PI * dy * speed) / h;
      writeCamera();
      oneFinger.x = t.clientX;
      oneFinger.y = t.clientY;
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length >= 2) {
      twoFinger = touchPair(e.touches);
      oneFinger = null;
    } else if (e.touches.length === 1) {
      twoFinger = null;
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      oneFinger = { x, y, sx: x, sy: y, t0: Date.now(), moved: false };
    } else {
      fireTapIfAny(oneFinger);
      twoFinger = null;
      oneFinger = null;
    }
  }

  // Pointer multi-touch (same path as touch)
  const ptrs = new Map();
  let ptrTwo = null;

  function ptrPair() {
    if (ptrs.size < 2) return null;
    const pts = [...ptrs.values()];
    const a = pts[0];
    const b = pts[1];
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      span: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
    };
  }

  function onPtrDown(e) {
    if (e.pointerType === "mouse") return;
    if (passToUi(e)) return;
    e.preventDefault();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) {
      ptrTwo = ptrPair();
      oneFinger = null;
    }
  }

  function onPtrMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    e.preventDefault();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) {
      const now = ptrPair();
      if (!now) return;
      if (!ptrTwo) {
        ptrTwo = now;
        return;
      }
      panCamera(now.midX - ptrTwo.midX, now.midY - ptrTwo.midY);
      const ratio = now.span / ptrTwo.span;
      if (Math.abs(Math.log(ratio)) > PINCH_EPS) {
        setCamDist(camDist() / Math.pow(Math.max(ratio, 0.05), PINCH_POWER));
      }
      ptrTwo = now;
    }
  }

  function onPtrUp(e) {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) ptrTwo = null;
  }

  let mouseMode = null;
  let mouseLast = null;
  let mouseGesture = null;

  function onMouseDown(e) {
    if (isFormControl(e.target, e) || uiControlAt(eventPoint(e))) return;
    if (e.button === 0 && !e.shiftKey) mouseMode = "orbit";
    else if (e.button === 0 && e.shiftKey) mouseMode = "pan";
    else if (e.button === 2) {
      mouseMode = "pan";
      e.preventDefault();
    } else return;
    mouseLast = { x: e.clientX, y: e.clientY };
    mouseGesture = {
      sx: e.clientX,
      sy: e.clientY,
      t0: Date.now(),
      moved: false,
    };
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    if (!mouseLast || !mouseMode) return;
    e.preventDefault();
    if (mouseGesture) {
      const fromStart = Math.hypot(
        e.clientX - mouseGesture.sx,
        e.clientY - mouseGesture.sy
      );
      if (fromStart > TAP_SLOP_PX) mouseGesture.moved = true;
      if (!mouseGesture.moved) return;
    }
    const dx = e.clientX - mouseLast.x;
    const dy = e.clientY - mouseLast.y;
    mouseLast = { x: e.clientX, y: e.clientY };
    if (mouseMode === "pan") {
      panCamera(dx, dy);
    } else {
      const h = Math.max(height, 1);
      const dist = camDist();
      const z = THREE.MathUtils.clamp(
        (dist - MIN_DIST) / Math.max(homeDist - MIN_DIST, 0.01),
        0,
        1
      );
      const speed = THREE.MathUtils.lerp(0.07, 0.55, z * z);
      readSpherical();
      spherical.theta -= (2 * Math.PI * dx * speed) / h;
      spherical.phi -= (2 * Math.PI * dy * speed) / h;
      writeCamera();
    }
  }

  function onMouseUp() {
    fireTapIfAny(mouseGesture);
    mouseMode = null;
    mouseLast = null;
    mouseGesture = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  function onWheel(e) {
    if (isFormControl(e.target, e) || uiControlAt(eventPoint(e))) return;
    e.preventDefault();
    setCamDist(camDist() * Math.exp(e.deltaY * WHEEL_DOLLY));
  }

  function onContextMenu(e) {
    if (isFormControl(e.target, e) || uiControlAt(eventPoint(e))) return;
    e.preventDefault();
  }

  const cap = { passive: false, capture: true };
  window.addEventListener("touchstart", onTouchStart, cap);
  window.addEventListener("touchmove", onTouchMove, cap);
  window.addEventListener("touchend", onTouchEnd, { capture: true });
  window.addEventListener("touchcancel", onTouchEnd, { capture: true });
  window.addEventListener("pointerdown", onPtrDown, cap);
  window.addEventListener("pointermove", onPtrMove, cap);
  window.addEventListener("pointerup", onPtrUp, { capture: true });
  window.addEventListener("pointercancel", onPtrUp, { capture: true });
  window.addEventListener("mousedown", onMouseDown, cap);
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  window.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("visibilitychange", onVisibility);
  canvas.style.touchAction = "none";
  surface.style.touchAction = "none";
  document.documentElement.style.touchAction = "none";
  document.body.style.touchAction = "none";

  function setOrbiting(on) {
    orbiting = !!on;
    if (!orbiting) lastOrbitMs = 0;
    kick();
    return orbiting;
  }

  function isOrbiting() {
    return orbiting;
  }

  function kick() {
    if (disposed || animId) return;
    if (typeof document !== "undefined" && document.hidden) return;
    animId = requestAnimationFrame(animate);
  }

  function onVisibility() {
    if (document.hidden) {
      if (animId) cancelAnimationFrame(animId);
      animId = 0;
      lastOrbitMs = 0;
      return;
    }
    kick();
  }

  function animate(now) {
    if (disposed) return;
    animId = 0;
    if (typeof document !== "undefined" && document.hidden) return;
    if (orbiting) {
      const t = typeof now === "number" ? now : performance.now();
      if (!lastOrbitMs) lastOrbitMs = t;
      const dt = Math.min(0.05, (t - lastOrbitMs) / 1000);
      lastOrbitMs = t;
      if (dt > 0) {
        readSpherical();
        spherical.theta -= ORBIT_RAD_PER_SEC * dt;
        writeCamera();
      }
    }
    syncMoon();
    if (missionMode !== "off") updateMissionPinFacing();
    updateTiles();
    renderer.render(scene, camera);
    if (orbiting || oneFinger || twoFinger) kick();
  }

  applyEphemeris();
  loadLow();
  fitToHost();
  applyHomeFraming();
  kick();

  return {
    resize,
    fitToHost,
    resetView,
    setObserver,
    setClouds,
    setAurora,
    setSun,
    getDayLook,
    setDayLook,
    setTime,
    setOrbiting,
    isOrbiting,
    setMissionsMode,
    setSites,
    getMissionsMode,
    getPhaseInfo,
    getObserver,
    getCamDist: () => camDist(),
    isReady: () => ready,
    dispose() {
      disposed = true;
      orbiting = false;
      missionMode = "off";
      disposeMissionPins();
      cancelAnimationFrame(animId);
      animId = 0;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("touchstart", onTouchStart, true);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchEnd, true);
      window.removeEventListener("pointerdown", onPtrDown, true);
      window.removeEventListener("pointermove", onPtrMove, true);
      window.removeEventListener("pointerup", onPtrUp, true);
      window.removeEventListener("pointercancel", onPtrUp, true);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      hideTiles();
      disposePoleMarks();
      if (mesh) {
        mesh.geometry.dispose();
        material?.map?.dispose();
        material?.userData?.nightUniform?.value?.dispose?.();
        material?.userData?.normalUniform?.value?.dispose?.();
        material?.dispose();
      }
      nightMesh?.geometry?.dispose();
      nightMat?.uniforms?.uNight?.value?.dispose?.();
      nightMat?.dispose();
      if (cloudMesh) {
        cloudMesh.geometry.dispose();
        cloudMesh.material?.map?.dispose();
        cloudMesh.material?.dispose();
      }
      if (auroraMesh) {
        if (auroraMesh.parent) auroraMesh.parent.remove(auroraMesh);
        auroraMesh.geometry.dispose();
        auroraMat?.dispose();
        auroraTex?.dispose();
        auroraMesh = null;
        auroraMat = null;
        auroraTex = null;
      }
      if (atmosphere) {
        moonGroup.remove(atmosphere);
        atmosphere.geometry.dispose();
        atmosphereMat?.dispose();
        atmosphere = null;
        atmosphereMat = null;
      }
      if (starfield) {
        starfield.geometry?.dispose();
        starfield.material?.map?.dispose();
        starfield.material?.dispose();
        starfield.userData.starTexture?.dispose();
      }
      renderer.dispose();
    },
  };
}
