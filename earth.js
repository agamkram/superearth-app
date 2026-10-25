/**
 * Hi-res 3D Earth
 * 1-finger orbit · 2fs (two-finger slide) pan · pinch zoom · Live/home reset
 */
import * as THREE from "three";
import { loadOvationPrime, makeAuroraColor } from "./ovation.js?v=e223";

const RADIUS = 1;
const HOME_FILL = 0.9;
/** Closest zoom (camera distance to Earth center; Earth radius = 1). */
const MIN_DIST = 1.1;
/** Furthest zoom as a multiple of the opening (home) distance. */
const MAX_OUT_FACTOR = 3.7;
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

/** Starfield (ported from satellite-app) — behind the real Moon (~60 Earth radii). */
const STAR_COUNT = 5000;
const STAR_RADIUS = 160;
/** Mean lunar radius in Earth radii. Distance comes from GeoVector.
 *  2× true scale so the crescent reads; distance stays real (~60). */
const MOON_RADIUS = (1737.4 / 6371) * 2;

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

/** Cache-bust + on-screen build mark. Bump when assets or earth.js change. */
export const BUILD = "e281";
const TEX_VER = BUILD;

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
    segments: 320,
  },
};

/**
 * Zoom tiles (Next Gen day + Black Marble night @ JPEG 85). Never a full high-k wrap.
 * Ladder by camera distance: 8k wrap → tiles-16 @≤2.5 → tiles-32 @≤1.75 → floor 1.1.
 * Each level loads a 3×3 under the screen center (plus one keep-ring while loading).
 * The tiles already on screen stay up until the next size covers that center,
 * so the view does not fall back to the soft 8k map in between.
 * A new block decodes one tile at a time, center first, so the zoom doesn't freeze.
 * Day and night tiles share the same grid; patches stay opaque so sharp night covers soft 8k.
 */
const TILE_RING = 1;
const TILE_LEVELS = {
  16: {
    label: "16",
    folder: "tiles-16",
    nightFolder: "night-tiles-16",
    cols: 8,
    rows: 4,
    onDist: 2.5,
    radius: 1.0018,
  },
  32: {
    label: "32",
    folder: "tiles-32",
    nightFolder: "night-tiles-32",
    cols: 16,
    rows: 8,
    onDist: 1.75,
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

const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 450;

export function createEarthGlobe(canvas, options = {}) {
  const {
    onReady = null,
    onQuality = null,
    onPhase = null,
    onZoom = null,
    onTap = null,
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

  const earthGroup = new THREE.Group();
  scene.add(earthGroup);
  /** Tips under a fixed sun; mesh under this only carries longitude. */
  const earthTilt = new THREE.Group();
  earthTilt.name = "earth-tilt";
  earthGroup.add(earthTilt);

  const loader = new THREE.TextureLoader();
  let mesh = null;
  let material = null;
  let ready = false;
  let hqStarted = false;
  let disposed = false;
  let animId = 0;
  const sunDir = new THREE.Vector3(1, 0, 0);
  const sunDirUniform = { value: sunDir };
  const sunOnUniform = { value: 1 };
  // Day look (locked): land bright 1.60 · topo relief 2.00
  const uLandGain = { value: 1.6 };
  const uShadeMin = { value: 0.9 };
  const uShadeMax = { value: 1.14 };
  const uReliefStr = { value: 2.0 };
  const uSlope = { value: 1.35 };
  let nightMesh = null;
  let nightMat = null;
  let cloudMesh = null;
  let cloudsOn = false;
  let tileGroup = null;
  const tileLive = new Map();
  const tileLoading = new Set();
  let tileWanted = new Set();
  let tilesEnabled = false;
  /** @type {null | "16" | "32"} */
  let tileLevel = null;
  /** Previous size kept on screen until the new size's center tiles are ready. */
  let holdLevel = null;
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
  let ovationPromise = null;

  function ensureOvationTables() {
    if (ovationTables || ovationPromise) return;
    ovationPromise = loadOvationPrime(new URL("./ovation-prime.bin?v=e54", import.meta.url))
      .then((tables) => {
        ovationTables = tables;
        if (auroraCoords) setAurora(auroraCoords, auroraDrive);
        return tables;
      })
      .catch(() => null);
  }
  let auroraMat = null;
  let auroraTex = null;
  let auroraShown = true;
  let auroraHas = false;
  let moonMesh = null;
  let moonMat = null;
  let moonDist = 60.3;
  const _moonDir = new THREE.Vector3(0, 0, -1);
  const _towardEarth = new THREE.Vector3();
  const _xPlus = new THREE.Vector3(1, 0, 0);
  const _libEuler = new THREE.Euler(0, 0, 0, "YXZ");
  const _libQ = new THREE.Quaternion();
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

  // Camera orbits `target`; Earth is always at `target` (required for 2fs pan).
  const target = new THREE.Vector3(0, 0, 0);
  const spherical = new THREE.Spherical();
  const _offset = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _yUp = new THREE.Vector3(0, 1, 0);
  const _orbitUp = new THREE.Vector3(0, 1, 0);
  const _orbitAlign = new THREE.Quaternion();
  const _orbitAlignInv = new THREE.Quaternion();
  const _tipAxis = new THREE.Vector3();
  const _sunFlat = new THREE.Vector3();
  const _lonQuat = new THREE.Quaternion();
  const _lonEuler = new THREE.Euler(0, 0, 0, "XYZ");
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
  /** Extra Earth spin (drag). Live: turns the planet under a fixed sun. */
  let userSpin = 0;
  /** Day-slider: Earth yaw frozen at scrub start (excludes userSpin). */
  let scrubYaw = 0;

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

  /** Night zoom tiles: linear lights, no mips — same crisp rule as day tiles. */
  function configureTileNight(tex) {
    tex.colorSpace = THREE.NoColorSpace;
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
        float dark = smoothstep(0.016, 0.0035, lum);
        float blu = smoothstep(0.0004, 0.0028, blue);
        float ocean = dark * blu;
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

        vec3 nightCol = pow(max(texture2D(uNight, vMapUv).rgb, vec3(0.0)), vec3(2.6));
        diffuseColor.rgb = mix(nightCol * 1.1, dayCol, day);`
      );
    };
    return material;
  }

  function makeTileMaterial(map, nightUniform, normalUniform) {
    const mat = new THREE.MeshBasicMaterial({
      map,
      color: 0xffffff,
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
        // Sharp night from the matching zoom tile (same UVs as day), not the soft 8k wrap.
        vec3 nightCol = pow(max(texture2D(uNight, vMapUv).rgb, vec3(0.0)), vec3(2.6));
        diffuseColor.rgb = mix(nightCol * 1.1, dayCol, day);
        diffuseColor.a = 1.0;`
      );
    };
    return mat;
  }

  function buildMesh(map, night, normal, cfg) {
    if (mesh) {
      earthGroup.remove(mesh);
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
    if (borderLines) mesh.add(borderLines);
    if (stateLines) mesh.add(stateLines);
    if (lakeMesh) mesh.add(lakeMesh);
    if (riverLines) mesh.add(riverLines);
    if (gridGroup) mesh.add(gridGroup);
    earthTilt.add(mesh);
    ensureAtmosphere();
    attachPoleMarks(mesh);
    attachLocPin(mesh);
    attachCapDot(mesh);
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
    earthGroup.add(atmosphere);
  }

  function updateAtmosphereLight() {
    if (!atmosphereMat || !atmosphere) return;
    atmosphereMat.uniforms.uLightDir.value.copy(sunDir);
    earthGroup.getWorldPosition(_atmoCenter);
    earthGroup.getWorldScale(_atmoScale);
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
  const PIN_GEO_R = 0.012;
  /** Screen px: findable at home, smaller in tight so it does not sit on the city. */
  const PIN_PX_HOME = 4;
  const PIN_PX_CLOSE = 5;
  const _poleOut = new THREE.Vector3();
  const _poleProj = new THREE.Vector3();
  const _poleCam = new THREE.Vector3();
  const _pinOut = new THREE.Vector3();
  const _pinEast = new THREE.Vector3();
  const _pinNorth = new THREE.Vector3();
  const _pinMat = new THREE.Matrix4();
  const _zPlus = new THREE.Vector3(0, 0, 1);
  let locPin = null;
  let locPinGeo = null;
  /** WMM2025.0 magnetic dip poles (where the field is vertical). */
  const MAG_POLES = [
    { letter: "MN", lat: 85.76, lon: 139.3, stroke: "rgba(110, 220, 255, 0.95)" },
    { letter: "MS", lat: -63.85, lon: 135.08, stroke: "rgba(110, 220, 255, 0.95)" },
  ];

  function makePoleBadge(letter, stroke = "rgba(255, 255, 255, 0.95)") {
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
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    const fontPx = letter.length > 1 ? 40 : 52;
    ctx.font = `700 ${fontPx}px system-ui, -apple-system, sans-serif`;
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

  function placePoleMark(mark, lat, lon) {
    const p = latLonToLocal(lat, lon, RADIUS * 1.0036);
    mark.position.copy(p);
    _poleOut.copy(p).normalize();
    mark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _poleOut);
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
    // Magnetic dip poles only — geographic N/S are the grid axis ends
    for (const m of MAG_POLES) {
      const mark = makePoleBadge(m.letter, m.stroke);
      mark.userData.pole = m;
      placePoleMark(mark, m.lat, m.lon);
      poleGroup.add(mark);
      poleMarks.push(mark);
    }
    parentMesh.add(poleGroup);
    updatePoleScale();
  }

  function updatePoleScale() {
    const dist = Math.max(camDist(), MIN_DIST);
    const h = Math.max(height || window.innerHeight || 1, 1);
    const vFov = THREE.MathUtils.degToRad(BASE_FOV);
    const worldPerPx = (dist * 2 * Math.tan(vFov / 2)) / h;
    if (poleMarks.length) {
      const span = Math.max(homeDist - MIN_DIST, 0.01);
      const zoomIn = 1 - THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
      const px = THREE.MathUtils.lerp(POLE_PX_FAR, POLE_PX_NEAR, zoomIn);
      const s = (px * worldPerPx) / (POLE_GEO_R * 2);
      for (const mark of poleMarks) mark.scale.setScalar(s);
    }
    if (axisMesh) {
      const s = (AXIS_PX * worldPerPx) / (AXIS_RADIUS * 2);
      axisMesh.scale.set(s, 1, s);
    }
    if (locPin) {
      const span = Math.max(homeDist - MIN_DIST, 0.01);
      const zoomIn = THREE.MathUtils.clamp((homeDist - dist) / span, 0, 1);
      const px = THREE.MathUtils.lerp(PIN_PX_HOME, PIN_PX_CLOSE, zoomIn);
      locPin.scale.setScalar((px * worldPerPx) / (PIN_GEO_R * 2));
      updateLocPinFacing();
    }
    if (capDot) {
      capDot.scale.setScalar((CAP_PX * worldPerPx) / (CAP_GEO_R * 2));
      updateCapDotFacing();
    }
    updateGridLabels(worldPerPx, dist);
  }

  function makeLocReticle() {
    const size = 128;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    const m = size / 2;
    const inner = 16;
    const outer = 42;
    const drawMark = () => {
      ctx.beginPath();
      ctx.arc(m, m, 54, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(m, m - outer);
      ctx.lineTo(m, m - inner);
      ctx.moveTo(m, m + inner);
      ctx.lineTo(m, m + outer);
      ctx.moveTo(m - outer, m);
      ctx.lineTo(m - inner, m);
      ctx.moveTo(m + inner, m);
      ctx.lineTo(m + outer, m);
      ctx.stroke();
    };
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    ctx.strokeStyle = "rgba(12, 14, 18, 0.92)";
    ctx.lineWidth = 7;
    drawMark();
    ctx.shadowColor = "rgba(255, 32, 24, 0.9)";
    ctx.shadowBlur = 8;
    ctx.strokeStyle = "rgba(255, 24, 16, 1)";
    ctx.lineWidth = 3;
    drawMark();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(12, 14, 18, 0.92)";
    ctx.fillRect(m - 4, m - 4, 8, 8);
    ctx.fillStyle = "rgba(255, 36, 28, 1)";
    ctx.fillRect(m - 2, m - 2, 4, 4);
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
    const mark = new THREE.Mesh(locPinGeo, mat);
    mark.renderOrder = 7;
    mark.userData.pinTex = tex;
    return mark;
  }

  function disposeLocPin() {
    if (!locPin) return;
    locPin.userData.pinTex?.dispose();
    locPin.material?.dispose();
    locPinGeo?.dispose();
    locPinGeo = null;
    if (locPin.parent) locPin.parent.remove(locPin);
    locPin = null;
  }

  function attachLocPin(parentMesh) {
    disposeLocPin();
    if (!parentMesh) return;
    locPinGeo = new THREE.CircleGeometry(PIN_GEO_R, 32);
    locPin = makeLocReticle();
    locPin.name = "loc-pin";
    parentMesh.add(locPin);
    placeLocPin();
  }

  function placeLocPin() {
    if (!locPin) return;
    const p = latLonToLocal(observerLat, observerLon, RADIUS * 1.004);
    locPin.position.copy(p);
    _pinOut.copy(p).normalize();
    // X = east, Y = north, Z = out — ticks are geographic NSEW.
    _pinEast.crossVectors(_yUp, _pinOut);
    if (_pinEast.lengthSq() < 1e-8) {
      locPin.quaternion.setFromUnitVectors(_zPlus, _pinOut);
    } else {
      _pinEast.normalize();
      _pinNorth.crossVectors(_pinOut, _pinEast).normalize();
      locPin.quaternion.setFromRotationMatrix(
        _pinMat.makeBasis(_pinEast, _pinNorth, _pinOut)
      );
    }
    updateLocPinFacing();
  }

  function updateLocPinFacing() {
    if (!locPin) return;
    locPin.getWorldPosition(_pinOut);
    _pinOut.sub(target).normalize();
    _offset.copy(camera.position).sub(target).normalize();
    locPin.visible = _pinOut.dot(_offset) > 0.06;
  }

  const CAP_GEO_R = 0.004;
  const CAP_PX = 3;
  let capDot = null;
  let capDotGeo = null;
  let capLat = null;
  let capLon = null;

  function makeCapDot() {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    const m = size / 2;
    ctx.beginPath();
    ctx.arc(m, m, 18, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(12, 8, 8, 0.9)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(m, m, 14, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 28, 20, 1)";
    ctx.fill();
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
    const mark = new THREE.Mesh(capDotGeo, mat);
    mark.renderOrder = 8;
    mark.userData.capTex = tex;
    mark.visible = false;
    return mark;
  }

  function disposeCapDot() {
    if (!capDot) return;
    capDot.userData.capTex?.dispose();
    capDot.material?.dispose();
    capDotGeo?.dispose();
    capDotGeo = null;
    if (capDot.parent) capDot.parent.remove(capDot);
    capDot = null;
  }

  function attachCapDot(parentMesh) {
    disposeCapDot();
    if (!parentMesh) return;
    capDotGeo = new THREE.CircleGeometry(CAP_GEO_R, 24);
    capDot = makeCapDot();
    capDot.name = "capital-dot";
    parentMesh.add(capDot);
    if (capLat != null && capLon != null) placeCapDot();
    else capDot.visible = false;
  }

  function placeCapDot() {
    if (!capDot || capLat == null || capLon == null) return;
    const p = latLonToLocal(capLat, capLon, RADIUS * 1.0042);
    capDot.position.copy(p);
    _pinOut.copy(p).normalize();
    capDot.quaternion.setFromUnitVectors(_zPlus, _pinOut);
    updateCapDotFacing();
    updatePoleScale();
  }

  function updateCapDotFacing() {
    if (!capDot) return;
    if (capLat == null || capLon == null) {
      capDot.visible = false;
      return;
    }
    capDot.getWorldPosition(_pinOut);
    _pinOut.sub(target).normalize();
    _offset.copy(camera.position).sub(target).normalize();
    capDot.visible = _pinOut.dot(_offset) > 0.06;
  }

  function setCapitalMark(lat, lon) {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      hideCapitalMark();
      return;
    }
    capLat = THREE.MathUtils.clamp(la, -90, 90);
    let L = lo;
    while (L > 180) L -= 360;
    while (L < -180) L += 360;
    capLon = L;
    if (!capDot && mesh) attachCapDot(mesh);
    placeCapDot();
    kick();
  }

  function hideCapitalMark() {
    capLat = null;
    capLon = null;
    if (capDot) capDot.visible = false;
    kick();
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

  /**
   * Just outside the zoom tiles (32 sits at 1.0022). Tiles write depth, so
   * these lines have to be farther out or the tiles hide them.
   */
  const BORDER_R = RADIUS * 1.0028;
  const STATE_R = RADIUS * 1.0030;
  let borderLines = null;
  let stateLines = null;
  let bordersOn = false;

  function disposeLineMesh(obj) {
    if (!obj) return;
    if (obj.parent) obj.parent.remove(obj);
    obj.geometry?.dispose();
    obj.material?.dispose();
  }

  function disposeBorders() {
    disposeLineMesh(borderLines);
    borderLines = null;
    disposeLineMesh(stateLines);
    stateLines = null;
  }

  function positionsFromBorderBin(buf, radius) {
    const view = new DataView(buf);
    let o = 0;
    const nLines = view.getUint32(o, true);
    o += 4;
    const positions = [];
    for (let i = 0; i < nLines; i++) {
      const n = view.getUint32(o, true);
      o += 4;
      let prevLon = NaN;
      let prevLat = NaN;
      for (let j = 0; j < n; j++) {
        const lon = view.getFloat32(o, true);
        o += 4;
        const lat = view.getFloat32(o, true);
        o += 4;
        if (Number.isFinite(prevLon) && Math.abs(lon - prevLon) < 180) {
          const a = latLonToLocal(prevLat, prevLon, radius);
          const b = latLonToLocal(lat, lon, radius);
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
        prevLon = lon;
        prevLat = lat;
      }
    }
    return positions;
  }

  function attachBorderMesh(positions, name, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(positions), 3)
    );
    const mat = new THREE.LineBasicMaterial({
      color: 0xd4deec,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = name;
    lines.renderOrder = 3;
    lines.visible = bordersOn;
    if (mesh) mesh.add(lines);
    return lines;
  }

  function loadBorderBin(file, radius, name, opacity, apply) {
    fetch(new URL(`./${file}?v=${TEX_VER}`, import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error(file + " " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed) return;
        apply(attachBorderMesh(positionsFromBorderBin(buf, radius), name, opacity));
        kick();
      })
      .catch(() => {});
  }

  function loadBorders() {
    loadBorderBin("borders-50m.bin", BORDER_R, "country-borders", 0.8, (lines) => {
      disposeLineMesh(borderLines);
      borderLines = lines;
    });
    loadBorderBin("states-50m.bin", STATE_R, "state-borders", 0.8, (lines) => {
      disposeLineMesh(stateLines);
      stateLines = lines;
    });
  }

  function setBorders(on) {
    bordersOn = !!on;
    if (borderLines) borderLines.visible = bordersOn;
    if (stateLines) stateLines.visible = bordersOn;
    kick();
    return bordersOn;
  }

  /** Just outside zoom tiles so the fill covers the photo, under border lines. */
  const LAKE_R = RADIUS * 1.0024;
  let lakeMesh = null;

  function disposeLakes() {
    disposeLineMesh(lakeMesh);
    lakeMesh = null;
  }

  function makeLakeMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: sunDirUniform,
        uSunOn: sunOnUniform,
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldN;
        void main() {
          vWorldN = normalize(mat3(modelMatrix) * normalize(position));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        uniform vec3 uSunDir;
        uniform float uSunOn;
        varying vec3 vWorldN;
        void main() {
          float ndl = dot(normalize(vWorldN), normalize(uSunDir));
          float day = uSunOn * smoothstep(-0.04, 0.20, ndl);
          vec3 navy = vec3(0.064, 0.17, 0.371);
          gl_FragColor = vec4(mix(navy * 0.08, navy, day), 1.0);
          #include <colorspace_fragment>
        }
      `,
      toneMapped: false,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }

  function attachLakeMesh(buf) {
    const view = new DataView(buf);
    if (view.byteLength < 12) return;
    const mag = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    );
    if (mag !== "LK10") return;
    let o = 4;
    const nVerts = view.getUint32(o, true);
    o += 4;
    const lonlat = new Float32Array(buf, o, nVerts * 2);
    o += nVerts * 8;
    const pos = new Float32Array(nVerts * 3);
    const _p = new THREE.Vector3();
    for (let i = 0; i < nVerts; i++) {
      _p.copy(latLonToLocal(lonlat[i * 2 + 1], lonlat[i * 2], LAKE_R));
      pos[i * 3] = _p.x;
      pos[i * 3 + 1] = _p.y;
      pos[i * 3 + 2] = _p.z;
    }
    const nIdx = view.getUint32(o, true);
    o += 4;
    const idx = new Uint32Array(buf.slice(o, o + nIdx * 4));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const meshLakes = new THREE.Mesh(geo, makeLakeMaterial());
    meshLakes.name = "lakes";
    meshLakes.renderOrder = 2;
    meshLakes.frustumCulled = false;
    if (mesh) mesh.add(meshLakes);
    return meshLakes;
  }

  function loadLakes() {
    fetch(new URL(`./lakes-10m.bin?v=${TEX_VER}`, import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error("lakes " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed) return;
        disposeLakes();
        lakeMesh = attachLakeMesh(buf);
        kick();
      })
      .catch(() => {});
  }

  /** Between lake fill and country lines. */
  const RIVER_R = RADIUS * 1.0026;
  let riverLines = null;
  let riversOn = true;

  function disposeRivers() {
    if (!riverLines) return;
    riverLines.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.dispose();
    });
    if (riverLines.parent) riverLines.parent.remove(riverLines);
    riverLines = null;
  }

  /** All ranks get a strip so creeks can sit under 1px when zoomed out. */
  const RIVER_WIDE_MAX = 12;

  function riverFrag() {
    return /* glsl */ `
      #include <common>
      uniform vec3 uSunDir;
      uniform float uSunOn;
      varying vec3 vWorldN;
      varying float vRank;
      void main() {
        float ndl = dot(normalize(vWorldN), normalize(uSunDir));
        float day = uSunOn * smoothstep(-0.04, 0.20, ndl);
        vec3 navy = vec3(0.064, 0.17, 0.371);
        gl_FragColor = vec4(mix(navy * 0.08, navy, day), 1.0);
        #include <colorspace_fragment>
      }
    `;
  }

  function makeRiverWideMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: sunDirUniform,
        uSunOn: sunOnUniform,
        uPixelToWorld: { value: 0 },
        uZoomIn: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aTan;
        attribute float aSide;
        attribute float aRank;
        uniform float uPixelToWorld;
        uniform float uZoomIn;
        varying vec3 vWorldN;
        varying float vRank;
        void main() {
          vWorldN = normalize(mat3(modelMatrix) * normalize(position));
          vRank = aRank;
          float farPx = 0.3;
          float nearPx = 1.3;
          if (aRank <= 2.5) farPx = 0.8;
          else if (aRank <= 5.5) farPx = 0.6;
          else if (aRank <= 8.5) farPx = 0.4;
          float minPx = mix(farPx, nearPx, clamp(uZoomIn, 0.0, 1.0));
          vec3 n = normalize(position);
          vec3 tan = aTan - n * dot(aTan, n);
          float tanLen = length(tan);
          tan = tanLen > 1e-8 ? tan / tanLen : vec3(0.0, 0.0, 1.0);
          vec3 side = normalize(cross(n, tan));
          vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
          float z = max(abs(viewPos.z), 0.02);
          float pixelWorld = uPixelToWorld * z;
          float halfW = max(minPx * 0.5 * pixelWorld, 0.000008);
          halfW = min(halfW, min(0.0022 * z, 0.001));
          viewPos.xyz += mat3(modelViewMatrix) * (side * aSide * halfW);
          gl_Position = projectionMatrix * viewPos;
        }
      `,
      fragmentShader: riverFrag(),
      toneMapped: false,
      depthWrite: false,
    });
  }

  function makeRiverThinMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: sunDirUniform,
        uSunOn: sunOnUniform,
      },
      vertexShader: /* glsl */ `
        attribute float aRank;
        varying vec3 vWorldN;
        varying float vRank;
        void main() {
          vWorldN = normalize(mat3(modelMatrix) * normalize(position));
          vRank = aRank;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: riverFrag(),
      toneMapped: false,
      depthWrite: false,
    });
  }

  function syncRiverPixels() {
    if (!riverLines) return;
    const h = Math.max(
      renderer.drawingBufferHeight || 0,
      Math.round((height || canvas.clientHeight || 1) * (renderer.getPixelRatio() || 1)),
      1
    );
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    let v = 0;
    if (h >= 64) {
      v = Math.min((2 * Math.tan(fovRad / 2)) / h, 0.002);
    }
    const dist = Math.max(camDist(), MIN_DIST);
    const span = Math.max(homeDist - MIN_DIST, 0.01);
    const zoomIn = 1 - THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
    riverLines.traverse((obj) => {
      const u = obj.material?.uniforms;
      if (!u) return;
      if (u.uPixelToWorld) u.uPixelToWorld.value = v;
      if (u.uZoomIn) u.uZoomIn.value = zoomIn;
    });
  }

  function attachRiverLines(buf) {
    const view = new DataView(buf);
    if (view.byteLength < 8) return null;
    const mag = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    );
    if (mag !== "RV10") return null;

    const xs = [];
    const ys = [];
    const xyz = new Float32Array(8192 * 3);
    const writeXYZ = (latDeg, lonDeg, i) => {
      const lat = THREE.MathUtils.degToRad(latDeg);
      const lon = THREE.MathUtils.degToRad(lonDeg);
      const cl = Math.cos(lat);
      xyz[i * 3] = RIVER_R * cl * Math.cos(lon);
      xyz[i * 3 + 1] = RIVER_R * Math.sin(lat);
      xyz[i * 3 + 2] = -RIVER_R * cl * Math.sin(lon);
    };
    const forEachPart = (fn) => {
      let o = 8;
      const nLines = view.getUint32(4, true);
      const emit = (sr) => {
        if (xs.length >= 2) fn(sr, xs.length);
      };
      for (let li = 0; li < nLines; li++) {
        const sr = Math.max(1, Math.min(12, view.getUint8(o)));
        o += 4;
        const n = view.getUint32(o, true);
        o += 4;
        xs.length = 0;
        ys.length = 0;
        let prevLon = NaN;
        for (let j = 0; j < n; j++) {
          const lon = view.getFloat32(o, true);
          o += 4;
          const lat = view.getFloat32(o, true);
          o += 4;
          if (Number.isFinite(prevLon) && Math.abs(lon - prevLon) >= 180) {
            emit(sr);
            xs.length = 0;
            ys.length = 0;
          }
          xs.push(lon);
          ys.push(lat);
          prevLon = lon;
        }
        emit(sr);
      }
    };

    let wideV = 0;
    let wideI = 0;
    let thinV = 0;
    forEachPart((sr, n) => {
      if (sr <= RIVER_WIDE_MAX) {
        wideV += n * 2;
        wideI += (n - 1) * 6;
      } else thinV += (n - 1) * 2;
    });

    const wPos = new Float32Array(wideV * 3);
    const wTan = new Float32Array(wideV * 3);
    const wSide = new Float32Array(wideV);
    const wRank = new Float32Array(wideV);
    const wIdx = new Uint32Array(wideI);
    const tPos = new Float32Array(thinV * 3);
    const tRank = new Float32Array(thinV);
    let wvi = 0;
    let wii = 0;
    let tvi = 0;

    forEachPart((sr, n) => {
      if (n > 8192) n = 8192;
      for (let i = 0; i < n; i++) writeXYZ(ys[i], xs[i], i);
      if (sr <= RIVER_WIDE_MAX) {
        const base = wvi;
        for (let i = 0; i < n; i++) {
          let tx;
          let ty;
          let tz;
          if (i === 0) {
            tx = xyz[3] - xyz[0];
            ty = xyz[4] - xyz[1];
            tz = xyz[5] - xyz[2];
          } else if (i === n - 1) {
            const k = (n - 2) * 3;
            const j = (n - 1) * 3;
            tx = xyz[j] - xyz[k];
            ty = xyz[j + 1] - xyz[k + 1];
            tz = xyz[j + 2] - xyz[k + 2];
          } else {
            const p = (i - 1) * 3;
            const q = (i + 1) * 3;
            tx = xyz[q] - xyz[p];
            ty = xyz[q + 1] - xyz[p + 1];
            tz = xyz[q + 2] - xyz[p + 2];
          }
          const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
          tx /= tlen;
          ty /= tlen;
          tz /= tlen;
          const x = xyz[i * 3];
          const y = xyz[i * 3 + 1];
          const z = xyz[i * 3 + 2];
          for (let s = 0; s < 2; s++) {
            const vi = wvi * 3;
            wPos[vi] = x;
            wPos[vi + 1] = y;
            wPos[vi + 2] = z;
            wTan[vi] = tx;
            wTan[vi + 1] = ty;
            wTan[vi + 2] = tz;
            wSide[wvi] = s === 0 ? 1 : -1;
            wRank[wvi] = sr;
            wvi += 1;
          }
        }
        for (let i = 0; i < n - 1; i++) {
          const a = base + i * 2;
          wIdx[wii++] = a;
          wIdx[wii++] = a + 1;
          wIdx[wii++] = a + 2;
          wIdx[wii++] = a + 1;
          wIdx[wii++] = a + 3;
          wIdx[wii++] = a + 2;
        }
      } else {
        for (let i = 1; i < n; i++) {
          const a = (i - 1) * 3;
          const b = i * 3;
          tPos[tvi * 3] = xyz[a];
          tPos[tvi * 3 + 1] = xyz[a + 1];
          tPos[tvi * 3 + 2] = xyz[a + 2];
          tRank[tvi] = sr;
          tvi += 1;
          tPos[tvi * 3] = xyz[b];
          tPos[tvi * 3 + 1] = xyz[b + 1];
          tPos[tvi * 3 + 2] = xyz[b + 2];
          tRank[tvi] = sr;
          tvi += 1;
        }
      }
    });

    const group = new THREE.Group();
    group.name = "rivers";
    if (wii > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(wPos, 3));
      geo.setAttribute("aTan", new THREE.BufferAttribute(wTan, 3));
      geo.setAttribute("aSide", new THREE.BufferAttribute(wSide, 1));
      geo.setAttribute("aRank", new THREE.BufferAttribute(wRank, 1));
      geo.setIndex(new THREE.BufferAttribute(wIdx, 1));
      const wide = new THREE.Mesh(geo, makeRiverWideMaterial());
      wide.renderOrder = 2;
      wide.frustumCulled = false;
      group.add(wide);
    }
    if (tvi > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(tPos, 3));
      geo.setAttribute("aRank", new THREE.BufferAttribute(tRank, 1));
      const thin = new THREE.LineSegments(geo, makeRiverThinMaterial());
      thin.renderOrder = 2;
      thin.frustumCulled = false;
      group.add(thin);
    }
    if (!group.children.length) return null;
    if (mesh) mesh.add(group);
    return group;
  }

  function loadRivers() {
    fetch(new URL(`./rivers-10m.bin?v=${TEX_VER}`, import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error("rivers " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed) return;
        disposeRivers();
        try {
          riverLines = attachRiverLines(buf);
        } catch (err) {
          riverLines = null;
        }
        if (riverLines) riverLines.visible = riversOn;
        syncRiverPixels();
        kick();
      })
      .catch(() => {});
  }

  /** Classic globe grid: polar axis, equator, 15° lat/lon lines. */
  const GRID_R = RADIUS * 1.0032;
  /** Natural Earth tropics, polar circles, equator. Just outside the 15° net. */
  const GEO_R = RADIUS * 1.0034;
  /** Visible end past each pole was 0.07R; ×3 → 0.21R. Width 2px (was 1px). */
  const AXIS_EXT = RADIUS * (1 + 0.07 * 3);
  const AXIS_RADIUS = 0.01;
  const AXIS_PX = 1;
  const GRID_SEGS = 96;
  let gridGroup = null;
  let axisMesh = null;
  let grid30 = null;
  let grid15 = null;
  let grid5 = null;
  let geoLineMesh = null;
  let geoLinePos = null;
  let gridLabels = [];
  let gridOn = false;
  const LABEL_R = RADIUS * 1.0042;
  const LABEL_PX_FAR = isTabletDisplay() ? 22 : 13;
  const LABEL_PX_NEAR = isTabletDisplay() ? 14 : 9;
  let labelGeo = null;

  function pushArc(positions, pts) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }

  function makeLineObj(positions, opacity, name) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(positions), 3)
    );
    const mat = new THREE.LineBasicMaterial({
      color: 0xd4deec,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = name;
    lines.renderOrder = 2;
    return lines;
  }

  function collectGridLines(step, skipStep) {
    const pos = [];
    for (let lat = -90 + step; lat <= 90 - step; lat += step) {
      if (skipStep && Math.abs(lat) % skipStep === 0) continue;
      const pts = [];
      for (let i = 0; i <= GRID_SEGS; i++) {
        const lon = (i / GRID_SEGS) * 360 - 180;
        pts.push(latLonToLocal(lat, lon, GRID_R));
      }
      pushArc(pos, pts);
    }
    for (let lon = -180; lon < 180; lon += step) {
      if (skipStep && Math.abs(lon) % skipStep === 0) continue;
      const pts = [];
      for (let i = 0; i <= GRID_SEGS; i++) {
        const lat = (i / GRID_SEGS) * 180 - 90;
        pts.push(latLonToLocal(lat, lon, GRID_R));
      }
      pushArc(pos, pts);
    }
    return pos;
  }

  function buildGrid() {
    disposeGrid();
    // Polar axle: 2px-wide rod; ends stick out 3× the original visible length
    const axisGeo = new THREE.CylinderGeometry(
      AXIS_RADIUS,
      AXIS_RADIUS,
      AXIS_EXT * 2,
      10
    );
    const axisMat = new THREE.MeshBasicMaterial({
      color: 0xd4deec,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      toneMapped: false,
    });
    axisMesh = new THREE.Mesh(axisGeo, axisMat);
    axisMesh.name = "grid-axis";
    axisMesh.renderOrder = 2;
    gridGroup = new THREE.Group();
    gridGroup.name = "globe-grid";
    grid30 = makeLineObj(collectGridLines(30, 0), 0.38, "grid-30");
    grid15 = makeLineObj(collectGridLines(15, 30), 0.28, "grid-15");
    grid5 = makeLineObj(collectGridLines(5, 15), 0.2, "grid-5");
    grid15.visible = false;
    grid5.visible = false;
    gridGroup.add(grid30);
    gridGroup.add(grid15);
    gridGroup.add(grid5);
    gridGroup.add(axisMesh);
    attachGeoLineMesh();
    attachGridLabels();
    gridGroup.visible = gridOn;
    if (mesh) mesh.add(gridGroup);
    updatePoleScale();
  }

  function makeGridLabel(text) {
    const pad = 18;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = "600 36px system-ui, -apple-system, sans-serif";
    const tw = Math.ceil(ctx.measureText(text).width);
    const w = Math.max(72, tw + pad * 2);
    const h = 64;
    c.width = w;
    c.height = h;
    ctx.font = "600 36px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(6, 10, 18, 0.58)";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(4, 10, w - 8, h - 20, 16);
    } else {
      ctx.rect(4, 10, w - 8, h - 20);
    }
    ctx.fill();
    ctx.fillStyle = "#d4deec";
    ctx.fillText(text, w / 2, h / 2 + 1);
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
      side: THREE.DoubleSide,
    });
    if (!labelGeo) labelGeo = new THREE.PlaneGeometry(1, 1);
    const mark = new THREE.Mesh(labelGeo, mat);
    mark.name = "grid-label";
    mark.renderOrder = 7;
    mark.userData.labelTex = tex;
    mark.userData.aspect = w / h;
    mark.userData.sharedGeo = true;
    return mark;
  }

  function placeGridLabel(mark, lat, lon) {
    const p = latLonToLocal(lat, lon, LABEL_R);
    mark.position.copy(p);
    _pinOut.copy(p).normalize();
    _pinEast.crossVectors(_yUp, _pinOut);
    if (_pinEast.lengthSq() < 1e-8) {
      mark.quaternion.setFromUnitVectors(_zPlus, _pinOut);
    } else {
      _pinEast.normalize();
      _pinNorth.crossVectors(_pinOut, _pinEast).normalize();
      mark.quaternion.setFromRotationMatrix(
        _pinMat.makeBasis(_pinEast, _pinNorth, _pinOut)
      );
    }
  }

  function attachGridLabels() {
    gridLabels = [];
    if (!gridGroup) return;
    const latLon = 20;
    const nameLon = -30;
    const spots = [
      [90, latLon, "90°N"],
      [60, latLon, "60°N"],
      [30, latLon, "30°N"],
      [-30, latLon, "30°S"],
      [-60, latLon, "60°S"],
      [-90, latLon, "90°S"],
      [0, 0, "0°"],
      [0, 90, "90°E"],
      [0, 180, "180°"],
      [0, -90, "90°W"],
      [0, nameLon, "Equator"],
      [23.44, nameLon, "Cancer"],
      [-23.44, nameLon, "Capricorn"],
      [66.56, nameLon, "Arctic"],
      [-66.56, nameLon, "Antarctic"],
    ];
    for (const [lat, lon, text] of spots) {
      const spr = makeGridLabel(text);
      placeGridLabel(spr, lat, lon);
      gridGroup.add(spr);
      gridLabels.push(spr);
    }
  }

  function updateGridLabels(worldPerPx, dist) {
    if (worldPerPx == null) {
      dist = Math.max(camDist(), MIN_DIST);
      const h = Math.max(height || window.innerHeight || 1, 1);
      const vFov = THREE.MathUtils.degToRad(BASE_FOV);
      worldPerPx = (dist * 2 * Math.tan(vFov / 2)) / h;
    }
    const span = Math.max(homeDist - MIN_DIST, 0.01);
    const zoomIn = 1 - THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
    if (grid15) grid15.visible = gridOn && zoomIn > 0.22;
    if (grid5) grid5.visible = gridOn && zoomIn > 0.55;
    if (!gridLabels.length) return;
    const px = THREE.MathUtils.lerp(LABEL_PX_FAR, LABEL_PX_NEAR, zoomIn);
    const s = px * worldPerPx;
    _offset.copy(camera.position).sub(target).normalize();
    for (const mark of gridLabels) {
      mark.getWorldPosition(_pinOut);
      _pinOut.sub(target).normalize();
      mark.visible = gridOn && _pinOut.dot(_offset) > 0.08;
      const aspect = mark.userData.aspect || 1;
      mark.scale.set(s * aspect, s, 1);
    }
  }

  function attachGeoLineMesh() {
    geoLineMesh = null;
    if (!gridGroup || !geoLinePos || !geoLinePos.length) return;
    geoLineMesh = makeLineObj(geoLinePos, 0.62, "geo-lines");
    geoLineMesh.renderOrder = 3;
    gridGroup.add(geoLineMesh);
  }

  function loadGeoLines() {
    fetch(new URL(`./geo-lines-10m.bin?v=${TEX_VER}`, import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error("geo-lines " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed) return;
        geoLinePos = positionsFromBorderBin(buf, GEO_R);
        attachGeoLineMesh();
        kick();
      })
      .catch(() => {});
  }

  function disposeGrid() {
    if (!gridGroup) return;
    if (gridGroup.parent) gridGroup.parent.remove(gridGroup);
    gridGroup.traverse((obj) => {
      obj.userData?.labelTex?.dispose();
      if (!obj.userData?.sharedGeo) obj.geometry?.dispose();
      obj.material?.dispose();
    });
    labelGeo?.dispose();
    labelGeo = null;
    gridGroup = null;
    axisMesh = null;
    grid30 = null;
    grid15 = null;
    grid5 = null;
    geoLineMesh = null;
    gridLabels = [];
  }

  /** 0 = upright (poles up); 1 = season in the axle (tip = today's sun declination). */
  let gridTilt = 0;
  let gridTiltFrom = 0;
  let gridTiltTarget = 0;
  let gridTiltAnimStart = 0;
  const GRID_TILT_MS = 1000;
  /** Replay tip from an already-tipped Off: keep season in the axle (no sun jump). */
  let tipHoldSun = false;

  /** Poles-up camera (equator, world +Y). Keep spin (theta) and zoom. */
  function clearFingerTipDown(dist) {
    readSpherical();
    // Home is lat 0. Do not aim phi at observerLat — that stacked ~35° on the
    // 23.4° axle and made Grid look too steep.
    spherical.phi = THREE.MathUtils.clamp(Math.PI / 2, MIN_POLAR, MAX_POLAR);
    if (Number.isFinite(dist)) spherical.radius = dist;
    writeCamera();
    syncEarth();
  }

  function setGrid(on) {
    gridOn = !!on;
    if (gridGroup) gridGroup.visible = gridOn;
    const dist = camDist();
    if (gridOn) {
      // Always ease 0→1 over 1s. Camera stays poles-up so the only lean is
      // today's declination on the axle — do not re-aim spin/theta.
      tipHoldSun = gridTilt > 0.5;
      gridTilt = 0;
      gridTiltFrom = 0;
      gridTiltTarget = 1;
      gridTiltAnimStart = performance.now();
      applyEphemeris({ skipKick: true });
      clearFingerTipDown(dist);
    } else if (gridTilt > 1e-5 || gridTiltTarget > 0) {
      gridTiltFrom = gridTilt;
      gridTiltTarget = 0;
      gridTiltAnimStart = performance.now();
      tipHoldSun = false;
      clearFingerTipDown(dist);
    }
    applyEphemeris();
    kick();
    return gridOn;
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
    // 8192×4096 is about 170 MB on the GPU with mipmaps. Half size is the
    // same 2:1 map, still mipmapped so the opening view does not sparkle.
    const size = "4096x2048";
    const url = `https://clouds.matteason.co.uk/images/${size}/clouds-alpha.png?t=${stamp}`;
    loader.load(
      url,
      (tex) => {
        if (disposed) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = true;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        tex.generateMipmaps = true;
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
  function localLonLatFromHit(mustHit) {
    mesh.worldToLocal(_tileLocal);
    _tileLocal.normalize();
    const lat = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(_tileLocal.y, -1, 1))
    );
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-_tileLocal.z, _tileLocal.x));
    return { lat, lon, hit: !!mustHit };
  }

  /**
   * Lon/lat under a screen point. If the ray misses the globe (space),
   * returns null when requireHit is true; otherwise aims at the nearest
   * surface point (used for tile paging under the view center).
   */
  function lonLatAt(clientX, clientY, requireHit = false) {
    if (!mesh) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    _tileNdc.set(
      ((clientX - rect.left) / w) * 2 - 1,
      -((clientY - rect.top) / h) * 2 + 1
    );
    camera.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(_earthSphere.center);
    _earthSphere.radius = RADIUS;
    _tileRay.setFromCamera(_tileNdc, camera);
    const hit = _tileRay.ray.intersectSphere(_earthSphere, _tileHit);
    if (hit) {
      _tileLocal.copy(hit);
      return localLonLatFromHit(true);
    }
    if (requireHit) return null;
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
    return localLonLatFromHit(false);
  }

  function viewLonLat() {
    const rect = canvas.getBoundingClientRect();
    return lonLatAt(rect.left + rect.width / 2, rect.top + rect.height / 2, false);
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
    const nightTex = piece.material.userData?.nightUniform?.value;
    if (nightTex) disposeMap(nightTex);
    piece.material.dispose();
  }

  function hideTiles() {
    tileWanted = new Set();
    holdLevel = null;
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

  function nightTileUrl(level, c, r) {
    return `${level.nightFolder}/c${c}r${r}.jpg?v=${TEX_VER}`;
  }

  function makeTilePatch(level, c, r, dayTex, nightTex) {
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
    const nightU = { value: nightTex };
    const normalU = material.userData.normalUniform;
    const mat = makeTileMaterial(dayTex, nightU, normalU);
    mat.userData.nightUniform = nightU;
    const piece = new THREE.Mesh(geo, mat);
    // Draw before the soft globe and write depth, so the globe is not shaded
    // again under the sharp patch. 32 is outside 16, so it has to come second.
    piece.renderOrder = level.label === "32" ? -1 : -2;
    piece.userData.tileKey = `${level.label}:${c}:${r}`;
    return piece;
  }

  function loadTile(level, key) {
    if (tileLive.has(key) || tileLoading.has(key) || disposed || !material) return;
    tileLoading.add(key);
    const parts = key.split(":");
    const c = Number(parts[1]);
    const r = Number(parts[2]);
    let dayTex = null;
    let nightTex = null;
    let pending = 2;
    let failed = false;

    const abort = () => {
      if (dayTex) {
        dayTex.dispose();
        dayTex = null;
      }
      if (nightTex) {
        nightTex.dispose();
        nightTex = null;
      }
    };

    const finish = () => {
      pending -= 1;
      if (pending > 0) return;
      tileLoading.delete(key);
      if (
        failed ||
        disposed ||
        !tilesEnabled ||
        !tileGroup ||
        !tileGroup.visible ||
        !tileWanted.has(key) ||
        tileLevel !== level.label ||
        tileLive.has(key) ||
        !dayTex ||
        !nightTex
      ) {
        abort();
        kick();
        return;
      }
      configureTileColor(dayTex);
      configureTileNight(nightTex);
      releaseDecodedImage(dayTex);
      releaseDecodedImage(nightTex);
      ensureTileGroup();
      const piece = makeTilePatch(level, c, r, dayTex, nightTex);
      tileGroup.add(piece);
      tileLive.set(key, piece);
      kick();
    };

    loader.load(
      tileUrl(level, c, r),
      (tex) => {
        dayTex = tex;
        finish();
      },
      undefined,
      () => {
        failed = true;
        finish();
      }
    );
    loader.load(
      nightTileUrl(level, c, r),
      (tex) => {
        nightTex = tex;
        finish();
      },
      undefined,
      () => {
        failed = true;
        finish();
      }
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
    if (tileLevel && tileLevel !== level.label) holdLevel = tileLevel;
    tileLevel = level.label;
    ensureTileGroup();
    tileGroup.visible = true;
    const want = new Set(neededTileKeys(level, at.lon, at.lat, TILE_RING));
    let u = (at.lon + 180) / 360;
    u = ((u % 1) + 1) % 1;
    const v = THREE.MathUtils.clamp((90 - at.lat) / 180, 0, 0.9999);
    const c0 = Math.floor(u * level.cols);
    const r0 = Math.min(level.rows - 1, Math.floor(v * level.rows));
    // Keep one extra ring so a drag doesn't flash soft 8k while neighbors load.
    const keep = new Set(neededTileKeys(level, at.lon, at.lat, TILE_RING + 1));
    tileWanted = want;
    const incomingReady = [...want].every((k) => tileLive.has(k));
    if (incomingReady) holdLevel = null;
    // Only the center of the old size stays up. Keeping its whole drag ring
    // plus the new tiles is enough to make Safari kill the tab.
    const holdKeep =
      holdLevel && TILE_LEVELS[holdLevel]
        ? new Set(neededTileKeys(TILE_LEVELS[holdLevel], at.lon, at.lat, TILE_RING))
        : null;
    for (const key of [...tileLive.keys()]) {
      if (holdKeep && key.split(":")[0] === holdLevel) {
        if (!holdKeep.has(key)) dropTile(key);
        continue;
      }
      if (!keep.has(key)) dropTile(key);
    }
    // One tile at a time. Starting the whole 3×3 at once decodes eighteen
    // pictures on the same turn and the pinch freezes.
    const ordered = [...want].sort((a, b) => {
      const pa = a.split(":");
      const pb = b.split(":");
      const da =
        Math.min(Math.abs(Number(pa[1]) - c0), level.cols - Math.abs(Number(pa[1]) - c0)) +
        Math.abs(Number(pa[2]) - r0);
      const db =
        Math.min(Math.abs(Number(pb[1]) - c0), level.cols - Math.abs(Number(pb[1]) - c0)) +
        Math.abs(Number(pb[2]) - r0);
      return da - db;
    });
    if (tileLoading.size === 0) {
      for (const key of ordered) {
        if (!tileLive.has(key)) {
          loadTile(level, key);
          break;
        }
      }
    }
    if (incomingReady) reportQuality(level.label);
    else if (holdLevel) reportQuality(holdLevel);
  }

  function wrapLonDeg(lon) {
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return lon;
  }

  function subsolarPoint(date) {
    const A = globalThis.Astronomy;
    const time = A.MakeTime(date);
    const sun = A.Equator(A.Body.Sun, time, new A.Observer(0, 0, 0), true, true);
    const gast = A.SiderealTime(time);
    return { lat: sun.dec, lon: wrapLonDeg((sun.ra - gast) * 15) };
  }

  /**
   * Sun + Moon in the same equatorial frame SuperEarth already uses for the sun.
   * Live: sun at lon 0 → +X via latLonToLocal. Moon east of the sun is +(moon.ra − sun.ra)×15°.
   * Full moon (elongation ~180°) ⇒ moonDir · sunDir < 0.
   */
  function skyBodies(date) {
    const A = globalThis.Astronomy;
    const time = A.MakeTime(date);
    const obs = new A.Observer(0, 0, 0);
    const sun = A.Equator(A.Body.Sun, time, obs, true, true);
    const moon = A.Equator(A.Body.Moon, time, obs, true, true);
    const gast = A.SiderealTime(time);
    const moonVec = A.GeoVector(A.Body.Moon, time, false);
    const distKm =
      Math.hypot(moonVec.x, moonVec.y, moonVec.z) * A.KM_PER_AU;
    let elat = 0;
    let elon = 0;
    try {
      const lib = A.Libration(time);
      elat = Number(lib.elat) || 0;
      elon = Number(lib.elon) || 0;
    } catch (_) {}
    return {
      sunLat: sun.dec,
      sunLon: wrapLonDeg((sun.ra - gast) * 15),
      moonLat: moon.dec,
      moonLon: wrapLonDeg((moon.ra - gast) * 15),
      moonDist: THREE.MathUtils.clamp(distKm / 6371, 50, 70),
      elat,
      elon,
    };
  }

  function makeMoonMaterial(map) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uSunDir: sunDirUniform,
        uSunOn: sunOnUniform,
        uHasMap: { value: map ? 1 : 0 },
        uEarthCenter: { value: target },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldN;
        varying vec3 vWorldPos;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 nLocal = normalize(position);
          vWorldN = normalize(mat3(modelMatrix) * nLocal);
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uSunDir;
        uniform float uSunOn;
        uniform float uHasMap;
        uniform vec3 uEarthCenter;
        varying vec3 vWorldN;
        varying vec3 vWorldPos;
        varying vec2 vUv;
        void main() {
          vec3 n = normalize(vWorldN);
          vec3 sunD = normalize(uSunDir);
          float ndl = dot(n, sunD);
          float day = smoothstep(-0.03, 0.16, ndl);
          vec3 albedo = uHasMap > 0.5
            ? texture2D(uMap, vUv).rgb
            : vec3(0.52, 0.50, 0.46);
          vec3 lit = albedo * mix(0.06, 2.35, day);
          vec3 toEarth = normalize(uEarthCenter - vWorldPos);
          float earthLit = max(0.0, dot(n, toEarth));
          lit += albedo * vec3(0.22, 0.32, 0.48) * earthLit * 0.16 * (1.0 - day);
          vec3 dim = albedo * 0.28;
          vec3 col = mix(dim, lit, uSunOn);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      toneMapped: false,
    });
  }

  function loadSkyMoon() {
    if (moonMesh) return;
    moonMat = makeMoonMaterial(null);
    moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(MOON_RADIUS, 48, 32),
      moonMat
    );
    moonMesh.frustumCulled = true;
    moonMesh.renderOrder = -5;
    moonMesh.visible = false;
    scene.add(moonMesh);
    applyEphemeris({ skipKick: true });
    loader.load(
      `moon-2k.jpg?v=${TEX_VER}`,
      (tex) => {
        if (disposed || !moonMat) {
          tex.dispose();
          return;
        }
        configureColor(tex);
        releaseDecodedImage(tex);
        moonMat.uniforms.uMap.value = tex;
        moonMat.uniforms.uHasMap.value = 1;
        kick();
      },
      undefined,
      () => {}
    );
  }

  function placeSkyMoon(sky) {
    if (!moonMesh) return;
    const dLon = wrapLonDeg(sky.moonLon - sky.sunLon);
    if (orientLocked) {
      _moonDir.copy(latLonToLocal(sky.moonLat, sky.moonLon, 1));
      _lonEuler.set(0, scrubYaw, 0);
      _moonDir.applyEuler(_lonEuler);
    } else {
      _moonDir.copy(latLonToLocal(sky.moonLat, dLon, 1));
    }
    if (_moonDir.lengthSq() < 1e-10) _moonDir.set(-1, 0, 0);
    _moonDir.normalize();
    moonDist = sky.moonDist;
    moonMesh.position.copy(target).addScaledVector(_moonDir, moonDist);
    _towardEarth.copy(_moonDir).negate();
    moonMesh.quaternion.setFromUnitVectors(_xPlus, _towardEarth);
    _libEuler.set(
      THREE.MathUtils.degToRad(-sky.elat),
      THREE.MathUtils.degToRad(sky.elon),
      0,
      "YXZ"
    );
    _libQ.setFromEuler(_libEuler);
    moonMesh.quaternion.multiply(_libQ);
    moonMesh.visible = true;
  }

  function applyEphemeris(opts = {}) {
    const A = globalThis.Astronomy;
    if (!A) return;

    let sky = {
      sunLat: 0,
      sunLon: 0,
      moonLat: 0,
      moonLon: 0,
      moonDist: 60.3,
      elat: 0,
      elon: 0,
    };
    try {
      sky = skyBodies(when);
    } catch (_) {
      try {
        const s = subsolarPoint(when);
        sky.sunLat = s.lat;
        sky.sunLon = s.lon;
      } catch (__) {}
    }
    const sub = { lat: sky.sunLat, lon: sky.sunLon };

    // Upright: seasons live in the sun's latitude. Grid on: seasons live in
    // the axle — hand sunLat → 0 as we tip so we don't double the lean.
    // tipHoldSun: replaying tip after Off kept the lean — don't dump season
    // back into the sun for the untilt→tip flash.
    const sunLat = tipHoldSun ? 0 : sub.lat * (1 - gridTilt);
    const dec = THREE.MathUtils.degToRad(sunLat);
    if (orientLocked) {
      // Day slider: Earth pose stays (plus drag); sun walks with scrubbed time.
      // Sun uses scrubYaw only — swipe turns Earth under a fixed sun.
      if (mesh) mesh.rotation.set(0, scrubYaw + userSpin, 0);
      const p = latLonToLocal(sunLat, sub.lon, 1);
      _lonEuler.set(0, scrubYaw, 0);
      p.applyEuler(_lonEuler);
      sunDir.copy(p).normalize();
    } else {
      // Live: fixed sun in world; Earth turns under it.
      sunDir.set(Math.cos(dec), Math.sin(dec), 0).normalize();
      const yLon = -THREE.MathUtils.degToRad(sub.lon) + userSpin;
      if (mesh) mesh.rotation.set(0, yLon, 0);
    }
    if (gridTilt > 1e-5) {
      // Tip axis locked to equator-sun so it does not twist while gridTilt eases.
      if (orientLocked) {
        _offset.copy(latLonToLocal(0, sub.lon, 1));
        _lonEuler.set(0, scrubYaw, 0);
        _offset.applyEuler(_lonEuler);
        _sunFlat.set(_offset.x, 0, _offset.z);
      } else {
        // Live sun sits on +X; tip north toward it.
        _sunFlat.set(1, 0, 0);
      }
      if (_sunFlat.lengthSq() < 1e-8) _sunFlat.set(1, 0, 0);
      _sunFlat.normalize();
      _tipAxis.crossVectors(_yUp, _sunFlat);
      if (_tipAxis.lengthSq() > 1e-8) {
        _tipAxis.normalize();
        // Tip by today's declination, not the full 23.4°. October is ~11°
        // away from the sun; June is +23.4° toward it. Using obliquity every
        // day painted June lighting (north pole in sun) year-round.
        earthTilt.quaternion.setFromAxisAngle(
          _tipAxis,
          THREE.MathUtils.degToRad(sub.lat) * gridTilt
        );
      } else {
        earthTilt.quaternion.identity();
      }
    } else {
      earthTilt.quaternion.identity();
    }
    earthGroup.rotation.set(0, 0, 0);
    earthGroup.position.copy(target);
    placeSkyMoon(sky);

    key.position.copy(target).addScaledVector(sunDir, 12);
    key.target.position.copy(target);
    updateViewLighting();
    if (!opts.skipKick) kick();

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
    if (!opts.quiet && typeof onPhase === "function") onPhase(lastPhaseInfo);
  }

  function setClouds(on) {
    cloudsOn = !!on;
    if (cloudMesh) cloudMesh.visible = cloudsOn;
    kick();
    return cloudsOn;
  }

  function setRivers(on) {
    riversOn = !!on;
    if (riverLines) riverLines.visible = riversOn;
    kick();
    return riversOn;
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
    ensureOvationTables();
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
    auroraMesh.visible = auroraShown && auroraHas;
    kick();
    return any;
  }

  function setAuroraShown(on) {
    auroraShown = !!on;
    if (auroraMesh) auroraMesh.visible = auroraShown && auroraHas;
    kick();
    return auroraShown;
  }

  function setSun(on) {
    sunOnUniform.value = on ? 1 : 0;
    kick();
    return sunOnUniform.value > 0.5;
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
    applyEphemeris();
    placeLocPin();
    frameCameraHome();
    return getPhaseInfo();
  }

  function setTime(date = new Date(), opts = {}) {
    when = date instanceof Date ? date : new Date(date);
    if (opts.lockOrient === false) {
      orientLocked = false;
    } else if (opts.lockOrient === true && !orientLocked) {
      // Freeze the Earth pose now; scrub only moves the sun.
      scrubYaw = (mesh ? mesh.rotation.y : 0) - userSpin;
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

  /** One-finger drag. Close and far stay as they feel; mid follows distance to the ground. */
  function orbitDragSpeed() {
    const near = 0.025;
    const far = 0.55;
    const dClose = Math.max(MIN_DIST - RADIUS, 0.05);
    const dFar = Math.max(homeDist - RADIUS, dClose + 0.01);
    const d = Math.max(camDist() - RADIUS, dClose);
    const t = THREE.MathUtils.clamp((d - dClose) / (dFar - dClose), 0, 1);
    return THREE.MathUtils.lerp(near, far, t);
  }

  // Camera stays world-up so a fixed sun stays fixed on screen.
  // (Following the tipped axle rolls the view and makes the sun look like it moves.)
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
    camera.up.copy(_yUp);
    camera.lookAt(target);
    // Near plane must be *closer* than the front of the sphere (dist − RADIUS).
    // Default near=0.05 clipped Earth when zoomed in → hard L/R edges.
    const dist = spherical.radius;
    const frontGap = dist - RADIUS; // distance camera → front of disk
    camera.near = Math.max(0.001, frontGap * 0.35);
    camera.far = Math.max(STAR_RADIUS + 40, dist + 40);
    camera.updateProjectionMatrix();
    updatePoleScale();
    if (typeof onZoom === "function") {
      const span = Math.max(homeDist - MIN_DIST, 0.01);
      const zoomIn = 1 - THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
      onZoom(dist, zoomIn);
    }
    kick();
  }

  function camDist() {
    return camera.position.distanceTo(target);
  }

  function syncEarth() {
    earthGroup.position.copy(target);
    if (moonMesh) {
      moonMesh.position.copy(target).addScaledVector(_moonDir, moonDist);
    }
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
   * Positive = shift home globe down (CSS translateY).
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
    // Phone Safari tab: nudge Earth down 1/8" at startup / Live home
    if (coarse && minSide <= 500) {
      if (isPhoneSafariBrowser()) return measureCssLength("0.125in", 12);
      return 0;
    }
    // iPad / large tablets
    if (coarse) return measureCssLength("0.125in", 12);
    // MacBook / desktop
    return measureCssLength("0.25in", 24);
  }

  /** CSS Y so home Earth sits in the upper safe band (above bottom info), not mid-screen. */
  function homeScreenOffsetY() {
    const pads = readHomePadsPx();
    // Safe-band center is above the viewport center when bottom pad > top pad.
    // CSS translateY: negative = content moves up. Extra 3/8" on startup.
    return (pads.top - pads.bottom) / 2 - homeExtraUpPx() + homeLowerBiasPx();
  }

  /**
   * Home look: observer longitude, latitude 0.
   * Keeps north up so a near-side Moon sits in the sky, not on the camera's back.
   * The loc pin marks the real place on that meridian.
   */
  function homeWorldDir(out) {
    const p = latLonToLocal(0, observerLon, 1);
    if (mesh) p.applyEuler(mesh.rotation);
    p.applyQuaternion(earthTilt.quaternion);
    return out.copy(p).normalize();
  }

  function frameCameraHome(dist) {
    const r = Number.isFinite(dist) ? dist : Math.max(camDist(), MIN_DIST);
    homeWorldDir(_offset);
    camera.position.copy(target).addScaledVector(_offset, r);
    camera.up.copy(_yUp);
    camera.lookAt(target);
    readSpherical();
    writeCamera();
    syncEarth();
  }

  function applyHomeFraming() {
    target.set(0, 0, 0);
    userSpin = 0;
    gridTilt = 0;
    gridTiltFrom = 0;
    gridTiltTarget = 0;
    tipHoldSun = false;
    earthTilt.quaternion.identity();
    clearScreenPan();
    homeLiftY = homeScreenOffsetY();
    applyCanvasPanTransform();
    applyEphemeris();
    frameCameraHome(homeDist);
    prevCamDist = homeDist;
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
      syncEarth();
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
    syncEarth();
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
    // Base pan buffer for 2fs. Also must cover home CSS lift (Earth sits high so
    // bottom of host stays filled — otherwise a black strip clips the globe).
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
    syncRiverPixels();
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
    // Keep the current aim and zoom fraction. Live / home reset recenters.
    if (centered) {
      homeLiftY = homeScreenOffsetY();
      applyCanvasPanTransform();
      readSpherical();
      spherical.radius = THREE.MathUtils.clamp(
        homeDist * zoomFrac,
        MIN_DIST,
        maxCamDist()
      );
      writeCamera();
      syncEarth();
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
    "input,button,select,textarea,a,label,#loc-dialog,.leaflet-container,.loc-dialog,#fact-sheet,#place-sheet,#pole-sheet,.cycle,.slider-track,.cycle-controls,.m-cell-fact,.vision-btn,.geo-btn,.live-btn,.sun-btn,.fact-sheet-inner,.fact-sheet-scrim";

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
    // Only real controls — not .cycle / .slider-track wrappers (those steal Sun + slider).
    const roots = ["fact-sheet", "place-sheet", "pole-sheet", "loc-dialog", "loc-bar"];
    let best = null;
    let bestArea = Infinity;
    for (const id of roots) {
      const root = document.getElementById(id);
      if (!root || root.hasAttribute("hidden")) continue;
      const ctrls = root.querySelectorAll(
        "button,input,select,textarea,a,.leaflet-container,.fact-sheet-scrim"
      );
      for (const ctrl of ctrls) {
        const r = ctrl.getBoundingClientRect();
        if (
          pt.x < r.left ||
          pt.x > r.right ||
          pt.y < r.top ||
          pt.y > r.bottom
        ) {
          continue;
        }
        const area = Math.max(r.width, 0) * Math.max(r.height, 0);
        if (area > 0 && area < bestArea) {
          bestArea = area;
          best = ctrl;
        }
      }
    }
    return best;
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
    if (!ctrl && !isFormControl(e.target, e)) return false;
    // Range scrub needs native touch — never preventDefault / fake-click it.
    const rangeEl =
      (ctrl && ctrl.type === "range" && ctrl) ||
      (e.target && e.target.type === "range" && e.target) ||
      null;
    if (rangeEl) return true;
    if (!ctrl) return true;
    // iOS PWA often never synthesizes click when html/body are touch-action:none.
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - uiClickAt > 350 && typeof ctrl.click === "function") {
      uiClickAt = now;
      ctrl.click();
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

  /** Finger pad around the MN / MS marks. The drawn badge is only a few pixels. */
  const POLE_TAP_PX = 24;

  function poleUnderTap(clientX, clientY) {
    if (!poleMarks.length || !mesh) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    camera.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(_earthSphere.center);
    let best = null;
    let bestD = Infinity;
    for (const mark of poleMarks) {
      const info = mark.userData.pole;
      if (!info) continue;
      mark.getWorldPosition(_poleOut);
      _poleCam.copy(camera.position).sub(_poleOut);
      if (_tileLocal.copy(_poleOut).sub(_earthSphere.center).dot(_poleCam) <= 0) continue;
      _poleProj.copy(_poleOut).project(camera);
      if (_poleProj.z < -1 || _poleProj.z > 1) continue;
      const sx = (_poleProj.x * 0.5 + 0.5) * w + rect.left;
      const sy = (-_poleProj.y * 0.5 + 0.5) * h + rect.top;
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d <= POLE_TAP_PX && d < bestD) {
        bestD = d;
        best = info;
      }
    }
    return best;
  }

  function fireTapIfAny(gesture) {
    if (!gesture || gesture.moved) return;
    if (Date.now() - gesture.t0 > TAP_MAX_MS) return;
    if (typeof onTap !== "function") return;
    const pole = poleUnderTap(gesture.sx, gesture.sy);
    if (pole) {
      onTap({ lat: pole.lat, lon: pole.lon, pole });
      return;
    }
    const ll = lonLatAt(gesture.sx, gesture.sy, true);
    onTap(ll);
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
      const speed = orbitDragSpeed();
      // Horizontal: spin Earth under the fixed sun. Vertical: tilt the view.
      userSpin += (2 * Math.PI * dx * speed) / h;
      applyEphemeris();
      readSpherical();
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
      const speed = orbitDragSpeed();
      userSpin += (2 * Math.PI * dx * speed) / h;
      applyEphemeris();
      readSpherical();
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

  function kick() {
    if (disposed || animId) return;
    if (typeof document !== "undefined" && document.hidden) return;
    animId = requestAnimationFrame(animate);
  }

  function onVisibility() {
    if (document.hidden) {
      if (animId) cancelAnimationFrame(animId);
      animId = 0;
      return;
    }
    // One fresh frame when returning; Live clock catch-up is tickLive in the page.
    kick();
  }

  function animate(now) {
    if (disposed) return;
    animId = 0;
    if (typeof document !== "undefined" && document.hidden) return;
    const t = typeof now === "number" ? now : performance.now();
    let tilting = false;
    if (gridTilt !== gridTiltTarget) {
      const u = THREE.MathUtils.clamp(
        (t - gridTiltAnimStart) / GRID_TILT_MS,
        0,
        1
      );
      const s = u * u * (3 - 2 * u);
      gridTilt = gridTiltFrom + (gridTiltTarget - gridTiltFrom) * s;
      if (u >= 1) {
        gridTilt = gridTiltTarget;
        tipHoldSun = false;
      }
      // Tip Earth only — leave camera alone so the sun stays put on screen.
      applyEphemeris({ skipKick: true });
      tilting = gridTilt !== gridTiltTarget;
    }
    syncEarth();
    updateTiles();
    syncRiverPixels();
    if (gridOn) updateGridLabels();
    renderer.render(scene, camera);
    // Idle when still. Real Earth spin is invisible frame-to-frame; the page
    // refreshes Live on a timer. Keep looping only while dragging or tipping.
    if (oneFinger || twoFinger || tilting) kick();
  }

  applyEphemeris();
  loadLow();
  loadSkyMoon();
  loadBorders();
  loadLakes();
  loadRivers();
  buildGrid();
  loadGeoLines();
  fitToHost();
  applyHomeFraming();
  kick();

  return {
    resize,
    fitToHost,
    resetView,
    setObserver,
    setClouds,
    setRivers,
    setBorders,
    setGrid,
    setAurora,
    setAuroraShown,
    setSun,
    setCapitalMark,
    hideCapitalMark,
    setTime,
    getPhaseInfo,
    getObserver,
    getCamDist: () => camDist(),
    isReady: () => ready,
    dispose() {
      disposed = true;
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
      disposeCapDot();
      disposeLocPin();
      disposeBorders();
      disposeLakes();
      disposeRivers();
      disposeGrid();
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
        earthGroup.remove(atmosphere);
        atmosphere.geometry.dispose();
        atmosphereMat?.dispose();
        atmosphere = null;
        atmosphereMat = null;
      }
      if (moonMesh) {
        scene.remove(moonMesh);
        moonMesh.geometry.dispose();
        moonMat?.uniforms?.uMap?.value?.dispose?.();
        moonMat?.dispose();
        moonMesh = null;
        moonMat = null;
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
