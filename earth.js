/**
 * Hi-res 3D Earth
 * 1-finger orbit · 2fs (two-finger slide) pan · pinch zoom · Live/home reset
 */
import * as THREE from "three";

/** Quake / storm pins. Replaced at runtime. */
let SURFACE_SITES = [];

const RADIUS = 1;
const HOME_FILL = 0.9;
const MIN_DIST = 1.02;
const MIN_POLAR = 0.15;
const MAX_POLAR = Math.PI - 0.15;
const MAX_PAN = RADIUS * 20;
const PINCH_POWER = 0.4;
const PINCH_EPS = 0.005;
const WHEEL_DOLLY = 0.0012;
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

const LOD = {
  low: { map: "earth-2k.jpg?v=e9", night: "earth-night-2k.jpg?v=e9", segments: 128 },
  high: { map: "earth-8k.jpg?v=e9", night: "earth-night-8k.jpg?v=e9", segments: 224 },
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

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
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
  let nightMesh = null;
  let nightMat = null;
  let cloudMesh = null;
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
  let faceSun = false;
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

  function makeSurfaceMaterial(map, night) {
    const nightUniform = { value: night };
    const material = new THREE.MeshBasicMaterial({ map, color: 0xffffff });
    material.userData.nightUniform = nightUniform;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = nightUniform;
      shader.uniforms.uSunDir = sunDirUniform;
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
        "#include <common>\nuniform sampler2D uNight;\nuniform vec3 uSunDir;\nvarying vec3 vWorldN;"
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float ndl = dot(normalize(vWorldN), normalize(uSunDir));
        float day = smoothstep(-0.04, 0.20, ndl);
        vec3 dayCol = diffuseColor.rgb;
        float lum = dot(dayCol, vec3(0.2126, 0.7152, 0.0722));
        float blue = dayCol.b - max(dayCol.r, dayCol.g);
        float ocean = smoothstep(0.035, 0.006, lum) * smoothstep(0.0, 0.004, blue);
        dayCol = mix(dayCol, vec3(0.012, 0.11, 0.38), ocean);
        vec3 nightCol = pow(texture2D(uNight, vMapUv).rgb, vec3(2.2));
        diffuseColor.rgb = mix(nightCol * 2.1, dayCol, day);`
      );
    };
    return material;
  }

  function buildMesh(map, night, cfg) {
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

    material = makeSurfaceMaterial(map, night);
    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, cfg.segments, cfg.segments),
      material
    );
    if (cloudMesh) mesh.add(cloudMesh);
    moonGroup.add(mesh);
    attachMissionPins(mesh);
    applyEphemeris();
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

  function loadLow() {
    const cfg = LOD.low;
    const map = loader.load(cfg.map, (tex) => {
      configureColor(tex);
      ready = true;
      if (typeof onReady === "function") onReady();
      if (typeof onQuality === "function") onQuality("2k");
      if (!hqStarted) {
        hqStarted = true;
        setTimeout(() => upgradeHigh(), 400);
      }
    });
    const night = loader.load(cfg.night, configureNight);
    configureColor(map);
    configureNight(night);
    buildMesh(map, night, cfg);
    loadClouds();
  }

  function upgradeHigh() {
    if (disposed) return;
    const cfg = LOD.high;
    let mapDone = null;
    let nightDone = null;

    const tryApply = () => {
      if (disposed || !material || !mapDone) return;
      const oldMap = material.map;
      material.map = mapDone;
      material.needsUpdate = true;
      if (oldMap && oldMap !== mapDone) oldMap.dispose();
      if (nightDone && material.userData.nightUniform) {
        const old = material.userData.nightUniform.value;
        material.userData.nightUniform.value = nightDone;
        if (old && old !== nightDone) old.dispose();
      }
      if (mesh && mesh.geometry.parameters.widthSegments < cfg.segments) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.SphereGeometry(RADIUS, cfg.segments, cfg.segments);
      }
      if (typeof onQuality === "function") onQuality("8k");
    };

    loader.load(cfg.map, (tex) => {
      if (disposed) return;
      configureColor(tex);
      mapDone = tex;
      tryApply();
    });
    loader.load(cfg.night, (tex) => {
      if (disposed) return;
      configureNight(tex);
      nightDone = tex;
      tryApply();
    });
  }

  function loadClouds() {
    const stamp = Math.floor(Date.now() / (3 * 3600 * 1000));
    const url = `https://clouds.matteason.co.uk/images/4096x2048/clouds-alpha.png?t=${stamp}`;
    loader.load(
      url,
      (tex) => {
        if (disposed) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = true;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        tex.needsUpdate = true;
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          color: 0xffffff,
          opacity: 0.92,
        });
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uSunDir = sunDirUniform;
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
            "#include <common>\nuniform vec3 uSunDir;\nvarying vec3 vWorldN;"
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <alphamap_fragment>",
            `#include <alphamap_fragment>
            float ndl = dot(normalize(vWorldN), normalize(uSunDir));
            float lit = smoothstep(-0.2, 0.35, ndl);
            diffuseColor.a *= mix(0.22, 1.0, lit);`
          );
        };
        cloudMesh = new THREE.Mesh(
          new THREE.SphereGeometry(RADIUS * 1.012, 96, 96),
          mat
        );
        cloudMesh.renderOrder = 2;
        if (mesh) mesh.add(cloudMesh);
      },
      undefined,
      () => {}
    );
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

    const placeLat = orientLocked ? frozenLat : observerLat;
    const placeLon = orientLocked ? frozenLon : observerLon;
    const lat = faceSun ? sub.lat : placeLat;
    const lon = faceSun ? sub.lon : placeLon;
    if (mesh) {
      mesh.rotation.order = "XYZ";
      mesh.rotation.x = THREE.MathUtils.degToRad(lat);
      mesh.rotation.y = -Math.PI / 2 - THREE.MathUtils.degToRad(lon);
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
      southern: lat < 0,
      orientLocked,
    };
    if (typeof onPhase === "function") onPhase(lastPhaseInfo);
  }

  function setFaceSun(on) {
    faceSun = !!on;
    applyEphemeris();
    return faceSun;
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
      Math.max(homeDist, MIN_DIST + 0.2)
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
  }

  function camDist() {
    return camera.position.distanceTo(target);
  }

  function syncMoon() {
    moonGroup.position.copy(target);
    key.target.position.copy(target);
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
    writeCamera();
    syncMoon();
    prevCamDist = homeDist;
    applyEphemeris();
  }

  function setCamDist(dist) {
    dist = THREE.MathUtils.clamp(dist, MIN_DIST, Math.max(homeDist, MIN_DIST + 0.2));
    // Full un-zoom (max distance) → starting location + face-on orientation
    if (dist >= homeDist - 1e-4) {
      applyHomeFraming();
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
    resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }

  function resize(cssW, cssH) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (w === width && h === height && bufferW > 0) return;

    const prevHome = homeDist;
    const dist = camDist();
    const atHome = dist >= prevHome * 0.97 && target.lengthSq() < 1e-4;
    const zoomFrac = prevHome > 0 ? dist / prevHome : 1;

    width = w;
    height = h;
    // Base pan buffer for 2fs. Also must cover home CSS lift (moon sits high so
    // bottom of host stays filled — otherwise a black strip clips the moon).
    const homeLift = Math.abs(homeScreenOffsetY());
    panMarginPx = Math.max(
      Math.ceil(Math.max(w, h) * PAN_MARGIN),
      Math.ceil(homeLift + 48)
    );
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

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setSize(bufferW, bufferH, false);
    if (starfield?.material) {
      starfield.material.size = starPointSize();
    }

    canvas.style.position = "absolute";
    canvas.style.width = `${bufferW}px`;
    canvas.style.height = `${bufferH}px`;
    canvas.style.left = `${-panMarginPx}px`;
    canvas.style.top = `${-panMarginPx}px`;
    applyCanvasPanTransform();

    homeDist = computeHomeDistance(w, h);
    if (atHome) {
      if (orbiting) {
        // Keep yaw; iOS viewport resize would otherwise snap face-on
        homeLiftY = homeScreenOffsetY();
        applyCanvasPanTransform();
        readSpherical();
        spherical.radius = homeDist;
        writeCamera();
        syncMoon();
        prevCamDist = homeDist;
      } else {
        applyHomeFraming();
      }
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

  function isFormControl(el) {
    // Also ignore map picker / Leaflet so UI dialogs receive touch
    return !!(
      el &&
      el.closest &&
      el.closest(
        "input,button,select,textarea,a,label,#loc-dialog,.leaflet-container,.loc-dialog,#mission-sheet,#fact-sheet,.cycle,.slider-track,.cycle-controls"
      )
    );
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
    if (e.touches.length === 1 && isFormControl(e.target)) return;
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
    if (e.touches.length === 1 && isFormControl(e.target) && !oneFinger) return;
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
      const speed = THREE.MathUtils.lerp(0.28, 0.55, z * z);
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
    if (isFormControl(e.target)) return;
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
    if (isFormControl(e.target)) return;
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
      readSpherical();
      spherical.theta -= (2 * Math.PI * dx * 0.5) / h;
      spherical.phi -= (2 * Math.PI * dy * 0.5) / h;
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
    if (isFormControl(e.target)) return;
    e.preventDefault();
    setCamDist(camDist() * Math.exp(e.deltaY * WHEEL_DOLLY));
  }

  function onContextMenu(e) {
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
  surface.addEventListener("mousedown", onMouseDown);
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("contextmenu", onContextMenu);
  canvas.style.touchAction = "none";
  surface.style.touchAction = "none";
  document.documentElement.style.touchAction = "none";
  document.body.style.touchAction = "none";

  function setOrbiting(on) {
    orbiting = !!on;
    if (!orbiting) lastOrbitMs = 0;
    return orbiting;
  }

  function isOrbiting() {
    return orbiting;
  }

  function animate(now) {
    if (disposed) return;
    animId = requestAnimationFrame(animate);
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
    updateViewLighting();
    if (missionMode !== "off") updateMissionPinFacing();
    renderer.render(scene, camera);
  }

  applyEphemeris();
  loadLow();
  fitToHost();
  applyHomeFraming();
  animate();

  return {
    resize,
    fitToHost,
    resetView,
    setObserver,
    setFaceSun,
    setTime,
    setOrbiting,
    isOrbiting,
    setMissionsMode,
    setSites,
    getMissionsMode,
    getPhaseInfo,
    getObserver,
    isReady: () => ready,
    dispose() {
      disposed = true;
      orbiting = false;
      missionMode = "off";
      disposeMissionPins();
      cancelAnimationFrame(animId);
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
      surface.removeEventListener("mousedown", onMouseDown);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("contextmenu", onContextMenu);
      if (mesh) {
        mesh.geometry.dispose();
        material?.map?.dispose();
        material?.dispose();
      }
      nightMesh?.geometry?.dispose();
      nightMat?.uniforms?.uNight?.value?.dispose?.();
      nightMat?.dispose();
      if (cloudMesh) {
        cloudMesh.geometry.dispose();
        cloudMesh.material?.alphaMap?.dispose();
        cloudMesh.material?.dispose();
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
