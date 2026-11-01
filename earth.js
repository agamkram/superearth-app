/**
 * Hi-res 3D Earth
 * 1-finger orbit · 2fs (two-finger slide) pan · pinch zoom · Live/home reset
 */
import * as THREE from "three";
import { loadOvationPrime, makeAuroraColor } from "./ovation.js?v=e223";
import { earthPoint, sampleUV, stepWind, windFrom } from "./wind.mjs?v=e351";
import { overLand } from "./places.js?v=e236";

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

/** Cache-bust for textures and earth.js. Bump when those change. */
export const BUILD = "e380";
const TEX_VER = BUILD;

const NORMAL_URL = `earth-normal-4k.jpg?v=${TEX_VER}`;
const SPHERE_SEGMENTS = 320;

/**
 * Squares, never one giant photo.
 * 8 is what you see zoomed out, and it stays around the edge when you zoom in.
 * 16 turns on at distance 2.5, 32 at 1.75, 86 at 1.50.
 * The on-screen squares and the ones that touch them stay loaded.
 * The next closer set starts loading before the current one would look soft.
 * One square decodes at a time. A daylight square loads the day photo.
 * A dark square loads the night photo. A square the day-night line is about
 * to cross loads both.
 */
const TILE_RING = 1;
const TILE_LEVELS = {
  8: {
    label: "8",
    folder: "tiles-8",
    nightFolder: "night-tiles-8",
    cols: 4,
    rows: 2,
    onDist: 99,
    radius: 1.001,
  },
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
  86: {
    label: "86",
    folder: "tiles-86",
    nightFolder: "night-tiles-86",
    cols: 40,
    rows: 20,
    onDist: 1.5,
    radius: 1.0023,
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
    onPhase = null,
    onTap = null,
    onWind = null,
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
  let disposed = false;
  let animId = 0;
  let orbiting = false;
  let lastOrbitMs = 0;
  /** Slow visible spin: one full turn about every 100s. */
  const ORBIT_RAD_PER_SEC = (2 * Math.PI) / 100;
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
  let photosOn = true;
  /** Stamp of the set being painted. Empty until a published set is chosen. */
  let cloudShown = "";
  /** Published set the job has finished. Null until ready.json answers. */
  let cloudInfo = null;
  let cloudReadyAt = 0;
  let cloudReadyFlight = null;
  const cloudLive = new Map();
  const cloudStage = new Map();
  let cloudStageStamp = "";
  const cloudLoading = new Set();
  const cloudAbort = new Map();
  const cloudSkip = new Set();
  const cloudFails = new Map();
  let cloudRetryAt = 0;
  /** Next square's file, still compressed. One decoded picture at a time. */
  const cloudBlob = new Map();
  // One cloud picture, eight pieces, at every zoom. The finished set stays
  // up until the next eight are ready, then the whole sky changes together.
  const CLOUDS = { label: "cfar", cols: 4, rows: 2 };
  let tileGroup = null;
  const tileLive = new Map();
  const tileLoading = new Set();
  let tileWanted = new Set();
  let tilesEnabled = false;
  /** @type {null | "16" | "32" | "86"} */
  let tileLevel = null;
  /** Previous size kept on screen until the new size's center tiles are ready. */
  let holdLevel = null;
  const _tileLocal = new THREE.Vector3();
  const _tileHit = new THREE.Vector3();
  const _tileNdc = new THREE.Vector2(0, 0);
  const _tileRay = new THREE.Raycaster();
  const _earthSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), RADIUS);

  function pickTileLevel(dist) {
    if (dist <= TILE_LEVELS[86].onDist) return TILE_LEVELS[86];
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
    material.colorWrite = photosOn;
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
    if (windLines) mesh.add(windLines);
    if (tileGroup) mesh.add(tileGroup);
    if (borderLines) mesh.add(borderLines);
    if (usStateLines) mesh.add(usStateLines);
    if (otherStateLines) mesh.add(otherStateLines);
    if (lakeMesh) mesh.add(lakeMesh);
    if (riverLines) mesh.add(riverLines);
    if (riverGroup) mesh.add(riverGroup);
    if (gridGroup) mesh.add(gridGroup);
    mesh.renderOrder = photosOn ? 0 : -6;
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
  /** Phone screen px. iPad multiplies by screen size so the mark stays the same share of the globe. */
  const POLE_PX_FAR = 3;
  const POLE_PX_NEAR = 7;
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
  /** Geographic poles. pair is the magnetic pole on the same side of Earth. */
  const GEO_POLES = [
    { letter: "N", lat: 90, lon: 0, pair: "MN", stroke: "rgba(212, 222, 236, 0.95)" },
    { letter: "S", lat: -90, lon: 0, pair: "MS", stroke: "rgba(212, 222, 236, 0.95)" },
  ];

  function surfaceKm(a, b) {
    const rad = Math.PI / 180;
    const p1 = a.lat * rad;
    const p2 = b.lat * rad;
    const dp = (b.lat - a.lat) * rad;
    const dl = (b.lon - a.lon) * rad;
    const h =
      Math.sin(dp / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

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
    const poles = MAG_POLES.concat(GEO_POLES);
    for (const m of poles) {
      const mark = makePoleBadge(m.letter, m.stroke);
      const info = { letter: m.letter, lat: m.lat, lon: m.lon };
      if (m.pair) {
        const pair = MAG_POLES.find((p) => p.letter === m.pair);
        if (pair) info.pairKm = surfaceKm(m, pair);
      }
      mark.userData.pole = info;
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
      let far = POLE_PX_FAR;
      let near = POLE_PX_NEAR;
      if (isTabletDisplay()) {
        const minSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
        const scale = THREE.MathUtils.clamp(minSide / 390, 1, 3);
        far *= scale;
        near *= scale;
      }
      const px = THREE.MathUtils.lerp(far, near, zoomIn);
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
    if (tapDot && tapLat != null) {
      tapDot.getWorldPosition(_pinOut);
      const tapDist = Math.max(camera.position.distanceTo(_pinOut), 0.05);
      const tapWorldPerPx = (tapDist * 2 * Math.tan(vFov / 2)) / h;
      tapDot.scale.setScalar((TAP_PX * tapWorldPerPx) / (TAP_GEO_R * 2));
      updateTapDotFacing();
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

  const TAP_GEO_R = 0.004;
  const TAP_PX = 6;
  let tapDot = null;
  let tapDotGeo = null;
  let tapLat = null;
  let tapLon = null;

  function makeTapDot() {
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
    const mark = new THREE.Mesh(tapDotGeo, mat);
    mark.renderOrder = 9;
    mark.userData.tapTex = tex;
    mark.visible = false;
    return mark;
  }

  function disposeTapDot() {
    if (!tapDot) return;
    tapDot.userData.tapTex?.dispose();
    tapDot.material?.dispose();
    tapDotGeo?.dispose();
    tapDotGeo = null;
    if (tapDot.parent) tapDot.parent.remove(tapDot);
    tapDot = null;
  }

  function attachTapDot(parentMesh) {
    disposeTapDot();
    if (!parentMesh) return;
    tapDotGeo = new THREE.CircleGeometry(TAP_GEO_R, 24);
    tapDot = makeTapDot();
    tapDot.name = "tap-dot";
    parentMesh.add(tapDot);
  }

  function placeTapDot() {
    if (!tapDot || tapLat == null || tapLon == null) return;
    const p = latLonToLocal(tapLat, tapLon, RADIUS * 1.0044);
    tapDot.position.copy(p);
    _pinOut.copy(p).normalize();
    tapDot.quaternion.setFromUnitVectors(_zPlus, _pinOut);
    updateTapDotFacing();
    updatePoleScale();
  }

  function updateTapDotFacing() {
    if (!tapDot) return;
    if (tapLat == null || tapLon == null) {
      tapDot.visible = false;
      return;
    }
    tapDot.getWorldPosition(_pinOut);
    _pinOut.sub(target).normalize();
    _offset.copy(camera.position).sub(target).normalize();
    tapDot.visible = _pinOut.dot(_offset) > 0.06;
  }

  function setTapMark(lat, lon) {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      hideTapMark();
      return;
    }
    tapLat = THREE.MathUtils.clamp(la, -90, 90);
    let L = lo;
    while (L > 180) L -= 360;
    while (L < -180) L += 360;
    tapLon = L;
    if (!tapDot && mesh) attachTapDot(mesh);
    placeTapDot();
    kick();
  }

  function hideTapMark() {
    tapLat = null;
    tapLon = null;
    if (tapDot) tapDot.visible = false;
    kick();
  }

  /**
   * Geographic → mesh-local. Matches SphereGeometry: lon 0 faces +X, north is +Y.
   * The formula lives in wind.mjs so the wind step uses this same frame.
   */
  const _earthOut = [0, 0, 0];
  function latLonToLocal(latDeg, lonDeg, r = RADIUS * 1.014) {
    earthPoint(latDeg, lonDeg, r, _earthOut);
    return new THREE.Vector3(_earthOut[0], _earthOut[1], _earthOut[2]);
  }

  /**
   * Just outside the zoom tiles (32 sits at 1.0022). Tiles write depth, so
   * these lines have to be farther out or the tiles hide them.
   */
  const BORDER_R = RADIUS * 1.0028;
  const STATE_R = RADIUS * 1.0030;
  let borderLines = null;
  let usStateLines = null;
  let otherStateLines = null;
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
    disposeLineMesh(usStateLines);
    usStateLines = null;
    disposeLineMesh(otherStateLines);
    otherStateLines = null;
  }

  function borderXYZ(latDeg, lonDeg, radius, out, i) {
    const lat = latDeg * (Math.PI / 180);
    const lon = lonDeg * (Math.PI / 180);
    const cl = Math.cos(lat);
    out[i] = radius * cl * Math.cos(lon);
    out[i + 1] = radius * Math.sin(lat);
    out[i + 2] = -radius * cl * Math.sin(lon);
  }

  function positionsFromBorderBin(buf, radius) {
    const view = new DataView(buf);
    const nLines = view.getUint32(0, true);
    let segs = 0;
    let o = 4;
    for (let i = 0; i < nLines; i++) {
      const n = view.getUint32(o, true);
      o += 4;
      let prevLon = NaN;
      for (let j = 0; j < n; j++) {
        const lon = view.getFloat32(o, true);
        o += 8;
        if (Number.isFinite(prevLon) && Math.abs(lon - prevLon) < 180) segs += 1;
        prevLon = lon;
      }
    }
    const positions = new Float32Array(segs * 6);
    let w = 0;
    o = 4;
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
          borderXYZ(prevLat, prevLon, radius, positions, w);
          borderXYZ(lat, lon, radius, positions, w + 3);
          w += 6;
        }
        prevLon = lon;
        prevLat = lat;
      }
    }
    return positions;
  }

  function attachBorderMesh(positions, name, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
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
    loadBorderBin("borders-10m.bin", BORDER_R, "country-borders", 0.95, (lines) => {
      disposeLineMesh(borderLines);
      borderLines = lines;
    });
    loadBorderBin("states-us-10m.bin", STATE_R, "us-state-borders", 0.9, (lines) => {
      disposeLineMesh(usStateLines);
      usStateLines = lines;
    });
    loadBorderBin("states-other-10m.bin", STATE_R, "other-state-borders", 0.25, (lines) => {
      disposeLineMesh(otherStateLines);
      otherStateLines = lines;
    });
  }

  function setBorders(on) {
    bordersOn = !!on;
    if (borderLines) borderLines.visible = bordersOn;
    if (usStateLines) usStateLines.visible = bordersOn;
    if (otherStateLines) otherStateLines.visible = bordersOn;
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
          vec3 dayWater = vec3(0.064, 0.17, 0.371);
          // Quiet slate so a lake reads on the black side without glowing.
          vec3 nightWater = vec3(0.06, 0.11, 0.18);
          gl_FragColor = vec4(mix(nightWater, dayWater, day), 1.0);
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
  /**
   * Rivers of 1000 m3/s and up stay on for the whole Earth.
   * Rivers of 100 cfs (2.83 m3/s) and up load for the face in view first,
   * then the rest, and stay loaded when you turn. Smaller rivers are not drawn.
   */
  const RIVER_MID = { label: "mid", folder: "rivers-mid", cols: 8, rows: 4 };
  let riverLines = null;
  let riverGroup = null;
  const riverLive = new Map();
  const riverLoading = new Set();
  const riverSkip = new Set();
  let riverWanted = new Set();
  let riverRetryAt = 0;
  let riversOn = false;

  function disposeRiverObject(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
    if (obj.parent) obj.parent.remove(obj);
  }

  function disposeRivers() {
    disposeRiverObject(riverLines);
    riverLines = null;
    for (const key of [...riverLive.keys()]) dropRiverSquare(key);
    riverLive.clear();
    riverLoading.clear();
    riverSkip.clear();
    riverWanted = new Set();
    if (riverGroup && riverGroup.parent) riverGroup.parent.remove(riverGroup);
    riverGroup = null;
  }

  /** Rank 1 grows as you zoom in. Every smaller river stays a 1 pixel line. */
  const RIVER_WIDE_MAX = 1;

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
        vec3 dayWater = vec3(0.064, 0.17, 0.371);
        // Bright enough that a one-pixel river reads on Black Marble.
        vec3 nightWater = vec3(0.24, 0.42, 0.60);
        gl_FragColor = vec4(mix(nightWater, dayWater, day), 1.0);
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
    let xyz = new Float32Array(4096 * 3);
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
      if (n * 3 > xyz.length) xyz = new Float32Array(n * 3);
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

    // The graphics chip keeps its own copy. Once that copy exists, the lists
    // in the page can be thrown away. They are only needed again if the phone
    // resets the chip, and then the rivers are loaded from the file again.
    const dropListsAfterSend = (attr) => {
      if (!attr || !attr.array || attr.array.length === 0) return;
      const Ctor = attr.array.constructor;
      attr.onUpload(() => {
        queueMicrotask(() => {
          attr.array = new Ctor(0);
        });
      });
    };
    const dropGeometryLists = (geo) => {
      for (const name in geo.attributes) dropListsAfterSend(geo.attributes[name]);
      if (geo.index) dropListsAfterSend(geo.index);
    };

    const group = new THREE.Group();
    group.name = "rivers";
    if (wii > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(wPos, 3));
      geo.setAttribute("aTan", new THREE.BufferAttribute(wTan, 3));
      geo.setAttribute("aSide", new THREE.BufferAttribute(wSide, 1));
      geo.setAttribute("aRank", new THREE.BufferAttribute(wRank, 1));
      geo.setIndex(new THREE.BufferAttribute(wIdx, 1));
      dropGeometryLists(geo);
      geo.computeBoundingSphere();
      const wide = new THREE.Mesh(geo, makeRiverWideMaterial());
      wide.renderOrder = 2;
      wide.frustumCulled = true;
      group.add(wide);
    }
    if (tvi > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(tPos, 3));
      geo.setAttribute("aRank", new THREE.BufferAttribute(tRank, 1));
      dropGeometryLists(geo);
      geo.computeBoundingSphere();
      const thin = new THREE.LineSegments(geo, makeRiverThinMaterial());
      thin.renderOrder = 2;
      thin.frustumCulled = true;
      group.add(thin);
    }
    if (!group.children.length) return null;
    return group;
  }

  function ensureRiverGroup() {
    if (!riverGroup) {
      riverGroup = new THREE.Group();
      riverGroup.name = "river-squares";
    }
    if (mesh && riverGroup.parent !== mesh) mesh.add(riverGroup);
    riverGroup.visible = riversOn;
  }

  function dropRiverSquare(key) {
    const piece = riverLive.get(key);
    if (!piece) return;
    riverLive.delete(key);
    disposeRiverObject(piece);
  }

  function riverKeyDist(key, level, at) {
    const parts = key.split(":");
    const { c0, r0 } = levelColRow(level, at.lon, at.lat);
    const c = Number(parts[1]);
    const r = Number(parts[2]);
    const dc = Math.min(Math.abs(c - c0), level.cols - Math.abs(c - c0));
    return dc + Math.abs(r - r0);
  }

  function loadRiverSquare(level, key) {
    if (riverLive.has(key) || riverLoading.has(key) || riverSkip.has(key)) return;
    const parts = key.split(":");
    const c = Number(parts[1]);
    const r = Number(parts[2]);
    riverLoading.add(key);
    fetch(new URL(`./${level.folder}/c${c}r${r}.bin?v=${TEX_VER}`, import.meta.url))
      .then((res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("rivers " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        riverLoading.delete(key);
        if (disposed || !riversOn || !riverWanted.has(key)) {
          kick();
          return;
        }
        if (!buf) {
          riverSkip.add(key);
          kick();
          return;
        }
        let group = null;
        try {
          group = attachRiverLines(buf);
        } catch (err) {
          group = null;
        }
        if (!group) {
          riverSkip.add(key);
          kick();
          return;
        }
        group.name = key;
        ensureRiverGroup();
        riverGroup.add(group);
        riverLive.set(key, group);
        syncRiverPixels();
        kick();
      })
      .catch(() => {
        riverLoading.delete(key);
        riverRetryAt = performance.now() + 4000;
        kick();
      });
  }

  function visibleCapKeys(level, at, dist) {
    const alpha = Math.acos(
      THREE.MathUtils.clamp(RADIUS / Math.max(dist, 1.001), -1, 1)
    );
    const dLat = 180 / level.rows;
    const dLon = 360 / level.cols;
    const lat0 = THREE.MathUtils.degToRad(at.lat);
    const keys = [];
    const seen = new Set();
    for (let r = 0; r < level.rows; r++) {
      const midLat = 90 - (r + 0.5) * dLat;
      const along = Math.abs(at.lat - midLat) * Math.PI / 180;
      const pad = (dLat * Math.PI) / 180 * 0.6;
      if (along > alpha + pad) continue;
      const p = THREE.MathUtils.degToRad(midLat);
      const denom = Math.cos(lat0) * Math.cos(p);
      let halfCols;
      if (Math.abs(denom) < 1e-6) {
        halfCols = level.cols;
      } else {
        const cosD =
          (Math.cos(Math.min(Math.PI, alpha + pad)) - Math.sin(lat0) * Math.sin(p)) / denom;
        if (cosD <= -1) halfCols = level.cols;
        else if (cosD >= 1) halfCols = 0;
        else halfCols = Math.ceil(Math.acos(THREE.MathUtils.clamp(cosD, -1, 1)) / THREE.MathUtils.degToRad(dLon));
      }
      const c0 = levelColRow(level, at.lon, midLat).c0;
      const push = (c) => {
        const key = `${level.label}:${c}:${r}`;
        if (seen.has(key)) return;
        seen.add(key);
        keys.push(key);
      };
      if (halfCols * 2 + 1 >= level.cols) {
        for (let c = 0; c < level.cols; c++) push(c);
      } else {
        for (let dc = -halfCols; dc <= halfCols; dc++) push(wrapCol(c0 + dc, level.cols));
      }
    }
    return keys;
  }

  function allRiverKeys() {
    const keys = [];
    for (let r = 0; r < RIVER_MID.rows; r++) {
      for (let c = 0; c < RIVER_MID.cols; c++) keys.push(`${RIVER_MID.label}:${c}:${r}`);
    }
    return keys;
  }

  function updateRiverSquares() {
    if (disposed || !mesh || !riversOn) return;
    const at = viewLonLat();
    if (!at) return;
    const dist = camDist();
    const face = new Set(visibleCapKeys(RIVER_MID, at, dist));
    const byDist = (a, b) => riverKeyDist(a, RIVER_MID, at) - riverKeyDist(b, RIVER_MID, at);
    const pending = allRiverKeys().filter((k) => !riverLive.has(k) && !riverSkip.has(k));
    riverWanted = new Set(allRiverKeys());
    // A piece that has loaded stays, including after it goes around the back.
    if (riverLoading.size > 0 || performance.now() < riverRetryAt) return;
    pending.sort((a, b) => {
      const af = face.has(a) ? 0 : 1;
      const bf = face.has(b) ? 0 : 1;
      if (af !== bf) return af - bf;
      return byDist(a, b);
    });
    if (pending.length) loadRiverSquare(RIVER_MID, pending[0]);
  }

  function loadBigRivers() {
    fetch(new URL(`./rivers-big.bin?v=${TEX_VER}`, import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error("rivers " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed) return;
        disposeRiverObject(riverLines);
        riverLines = null;
        try {
          riverLines = attachRiverLines(buf);
        } catch (err) {
          riverLines = null;
        }
        if (riverLines && mesh) mesh.add(riverLines);
        if (riverLines) riverLines.visible = riversOn;
        syncRiverPixels();
        kick();
      })
      .catch(() => {});
  }

  renderer.domElement.addEventListener("webglcontextlost", () => {
    if (riverLines) riverLines.visible = false;
    if (riverGroup) riverGroup.visible = false;
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    riverSkip.clear();
    for (const key of [...riverLive.keys()]) dropRiverSquare(key);
    loadBigRivers();
  });

  /** Classic globe grid: polar axis, lat/lon lines. Equator is the Natural Earth line. */
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
  let grid1 = null;
  let geoLineMesh = null;
  let geoLinePos = null;
  let gridLabels = [];
  let gridOn = false;
  const LABEL_R = RADIUS * 1.0042;
  /** One screen size. Maps do this — not a new height at every zoom. */
  const LABEL_PX = isTabletDisplay() ? 8 : 6;
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
      if (Math.abs(lat) < 1e-9) continue;
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

  function ensureFineGrid() {
    if (!gridGroup || grid1) return;
    grid1 = makeLineObj(collectGridLines(1, 5), 0.12, "grid-1");
    grid1.visible = false;
    gridGroup.add(grid1);
  }

  function makeGridLabel(text) {
    const fontPx = 32;
    const padX = 6;
    const padY = 5;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = `500 ${fontPx}px system-ui, -apple-system, sans-serif`;
    const tw = Math.ceil(ctx.measureText(text).width);
    const w = Math.max(8, tw + padX * 2);
    const h = fontPx + padY * 2;
    c.width = w;
    c.height = h;
    ctx.font = `500 ${fontPx}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(6, 10, 18, 0.82)";
    ctx.fillStyle = "#d4deec";
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillText(text, w / 2, h / 2);
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
      const lonR = THREE.MathUtils.degToRad(lon);
      _pinEast.set(-Math.sin(lonR), 0, -Math.cos(lonR));
    }
    _pinEast.normalize();
    _pinNorth.crossVectors(_pinOut, _pinEast).normalize();
    _pinEast.crossVectors(_pinNorth, _pinOut).normalize();
    mark.quaternion.setFromRotationMatrix(
      _pinMat.makeBasis(_pinEast, _pinNorth, _pinOut)
    );
  }

  function attachGridLabels() {
    gridLabels = [];
    if (!gridGroup) return;
    const nameLon = -30;
    const spots = [
      [60, nameLon, "60°N"],
      [30, nameLon, "30°N"],
      [-30, nameLon, "30°S"],
      [-60, nameLon, "60°S"],
      [0, 90, "90°E"],
      [0, 180, "180°"],
      [0, -90, "90°W"],
      [0, nameLon, "Equator", "equator"],
      [23.44, nameLon, "Cancer", "cancer"],
      [-23.44, nameLon, "Capricorn", "capricorn"],
      [66.56, nameLon, "Arctic", "arctic"],
      [-66.56, nameLon, "Antarctic", "antarctic"],
    ];
    for (const [lat, lon, text, lineId] of spots) {
      const spr = makeGridLabel(text);
      placeGridLabel(spr, lat, lon);
      if (lineId) spr.userData.line = { id: lineId, lat, lon };
      gridGroup.add(spr);
      gridLabels.push(spr);
    }
  }

  function updateGridLabels(worldPerPx, dist) {
    dist = dist == null ? Math.max(camDist(), MIN_DIST) : dist;
    const span = Math.max(homeDist - MIN_DIST, 0.01);
    const zoomIn = 1 - THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
    if (gridOn && zoomIn > 0.72) ensureFineGrid();
    if (grid15) grid15.visible = gridOn;
    if (grid5) grid5.visible = gridOn && zoomIn > 0.52;
    if (grid1) grid1.visible = gridOn && zoomIn > 0.78;
    if (!gridLabels.length) return;
    const h = Math.max(height || window.innerHeight || 1, 1);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const tanHalf = Math.tan(vFov / 2);
    _offset.copy(camera.position).sub(target).normalize();
    for (const mark of gridLabels) {
      mark.getWorldPosition(_pinOut);
      const labelDist = Math.max(camera.position.distanceTo(_pinOut), 0.05);
      const s = (LABEL_PX * (labelDist * 2 * tanHalf)) / h;
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
    grid1 = null;
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
    if (gridOn) updateGridLabels();
    kick();
    return gridOn;
  }

  function setTilt(on) {
    const dist = camDist();
    if (on) {
      tipHoldSun = gridTilt > 0.5;
      gridTiltFrom = gridTilt;
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
    return !!on;
  }

  // Upload now, then drop the decoded bitmap. A decoded photo is much
  // larger than the file, and Safari kills the tab when several sit in memory.
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
    if (typeof img.close === "function") img.close();
    else if (typeof img.src === "string") {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    }
  }

  function disposeMap(tex) {
    if (!tex) return;
    const img = tex.image;
    tex.dispose();
    if (img && typeof img.close === "function") img.close();
    else if (img && typeof img.src === "string") {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    }
  }

  function flatTex(r, g, b) {
    const data = new Uint8Array([r, g, b, 255]);
    const tex = new THREE.DataTexture(data, 1, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  function flatNormal() {
    const data = new Uint8Array([128, 128, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1);
    tex.colorSpace = THREE.NoColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** The globe appears when the front squares are up, not when a small photo arrives. */
  function loadBase() {
    const day = flatTex(10, 30, 62);
    const night = flatTex(0, 0, 0);
    buildMesh(day, night, flatNormal(), { segments: SPHERE_SEGMENTS });
    tilesEnabled = true;
    kick();
    loader.load(
      NORMAL_URL,
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
      },
      undefined,
      () => {}
    );
  }

  function dropCloudPiece(key) {
    const piece = cloudLive.get(key);
    if (!piece) return;
    cloudLive.delete(key);
    if (piece.parent) piece.parent.remove(piece);
    piece.geometry.dispose();
    if (piece.material.map) disposeMap(piece.material.map);
    piece.material.dispose();
  }

  function stopCloudLoads() {
    for (const ctrl of cloudAbort.values()) {
      try { ctrl.abort(); } catch (_) {}
    }
    cloudAbort.clear();
    cloudLoading.clear();
    cloudBlob.clear();
  }

  function disposeClouds() {
    stopCloudLoads();
    cloudSkip.clear();
    cloudFails.clear();
    cloudRetryAt = 0;
    for (const key of [...cloudLive.keys()]) dropCloudPiece(key);
    if (cloudMesh && cloudMesh.parent) cloudMesh.parent.remove(cloudMesh);
    cloudMesh = null;
    cloudShown = "";
    cloudStageStamp = "";
    for (const piece of cloudStage.values()) disposeCloudMesh(piece);
    cloudStage.clear();
  }

  function cloudMaterial(tex) {
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
    return mat;
  }

  function makeCloudPatch(level, c, r, tex) {
    const cols = level.cols;
    const rows = level.rows;
    const geo = new THREE.SphereGeometry(
      RADIUS * 1.012,
      48,
      48,
      (c / cols) * Math.PI * 2,
      (1 / cols) * Math.PI * 2,
      (r / rows) * Math.PI,
      (1 / rows) * Math.PI
    );
    const piece = new THREE.Mesh(geo, cloudMaterial(tex));
    piece.renderOrder = 2;
    return piece;
  }

  function cloudSquareUrl(c, r, info) {
    return `https://cdn.jsdelivr.net/gh/agamkram/superearth-app@${info.sha}/${info.stamp}-c${c}r${r}.png`;
  }

  function fetchCloudBlob(key, info, ctrl) {
    const parts = key.split(":");
    return fetch(cloudSquareUrl(Number(parts[1]), Number(parts[2]), info), {
      signal: ctrl.signal,
    }).then((res) => {
      if (!res.ok) throw new Error("cloud");
      return res.blob();
    });
  }

  function prefetchCloud(key, info, have) {
    if (!key || have.has(key) || cloudLoading.has(key) || cloudSkip.has(info.stamp + ":" + key)) return;
    const hit = cloudBlob.get(key);
    if (hit && hit.stamp === info.stamp) return;
    const ctrl = new AbortController();
    cloudAbort.set("pre:" + key, ctrl);
    const promise = fetchCloudBlob(key, info, ctrl);
    promise.catch(() => {
      const cur = cloudBlob.get(key);
      if (cur && cur.promise === promise) cloudBlob.delete(key);
      if (cloudAbort.get("pre:" + key) === ctrl) cloudAbort.delete("pre:" + key);
    });
    cloudBlob.set(key, { stamp: info.stamp, promise });
  }

  function loadCloudSquare(level, key, info, nextKey, staged) {
    const have = staged ? cloudStage : cloudLive;
    if (have.has(key) || cloudLoading.has(key) || cloudSkip.has(info.stamp + ":" + key)) return;
    const parts = key.split(":");
    const c = Number(parts[1]);
    const r = Number(parts[2]);
    cloudLoading.add(key);
    const pre = cloudBlob.get(key);
    let ctrl;
    let blobPromise;
    if (pre && pre.stamp === info.stamp) {
      cloudBlob.delete(key);
      blobPromise = pre.promise;
      ctrl = cloudAbort.get("pre:" + key) || new AbortController();
      cloudAbort.delete("pre:" + key);
      cloudAbort.set(key, ctrl);
    } else {
      ctrl = new AbortController();
      cloudAbort.set(key, ctrl);
      blobPromise = fetchCloudBlob(key, info, ctrl);
    }
    // The next file downloads while this picture is decoded. The decoded
    // bitmap is closed before another one is opened.
    prefetchCloud(nextKey, info, have);
    blobPromise
      .then((blob) => createImageBitmap(blob, { imageOrientation: "flipY" }))
      .then((bitmap) => {
        cloudLoading.delete(key);
        cloudAbort.delete(key);
        const still = staged ? cloudStageStamp === info.stamp : cloudShown === info.stamp;
        if (disposed || !cloudsOn || !still || !cloudMesh) {
          bitmap.close();
          kick();
          return;
        }
        const tex = new THREE.Texture(bitmap);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        releaseDecodedImage(tex);
        if (tex.image === bitmap) {
          bitmap.close();
          throw new Error("upload");
        }
        const piece = makeCloudPatch(level, c, r, tex);
        if (staged) {
          if (cloudStageStamp !== info.stamp) {
            disposeCloudMesh(piece);
            kick();
            return;
          }
          cloudStage.set(key, piece);
          if (cloudStage.size === 8) swapCloudSet(info.stamp);
        } else {
          cloudMesh.add(piece);
          cloudLive.set(key, piece);
        }
        kick();
      })
      .catch(() => {
        cloudLoading.delete(key);
        cloudAbort.delete(key);
        if (ctrl.signal.aborted || disposed || !cloudsOn) {
          kick();
          return;
        }
        const n = (cloudFails.get(key) || 0) + 1;
        cloudFails.set(key, n);
        if (n >= 3) cloudSkip.add(info.stamp + ":" + key);
        else cloudRetryAt = performance.now() + 4000;
        kick();
      });
  }

  function allCloudKeys() {
    const keys = [];
    for (let r = 0; r < CLOUDS.rows; r++) {
      for (let c = 0; c < CLOUDS.cols; c++) keys.push(`${CLOUDS.label}:${c}:${r}`);
    }
    return keys;
  }

  function disposeCloudMesh(piece) {
    if (!piece) return;
    if (piece.parent) piece.parent.remove(piece);
    piece.geometry.dispose();
    if (piece.material.map) disposeMap(piece.material.map);
    piece.material.dispose();
  }

  function clearCloudStage() {
    for (const piece of cloudStage.values()) disposeCloudMesh(piece);
    cloudStage.clear();
    cloudStageStamp = "";
  }

  function swapCloudSet(stamp) {
    for (const key of [...cloudLive.keys()]) dropCloudPiece(key);
    if (!cloudMesh) return;
    for (const [key, piece] of cloudStage) {
      cloudMesh.add(piece);
      cloudLive.set(key, piece);
    }
    cloudStage.clear();
    cloudStageStamp = "";
    cloudShown = stamp;
    kick();
  }

  function pullCloudReady() {
    if (cloudReadyFlight) return;
    cloudReadyAt = performance.now() + 10 * 60 * 1000;
    const ctrl = new AbortController();
    cloudAbort.set("ready", ctrl);
    // The minute keeps a stale "not there yet" answer from sticking.
    const readyUrl =
      "https://raw.githubusercontent.com/agamkram/superearth-app/cloud-tiles/ready.json?t=" +
      Math.floor(Date.now() / 60000);
    cloudReadyFlight = fetch(readyUrl, { cache: "no-store", signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const stamp = String((data && data.stamp) || "");
        const sha = String((data && data.sha) || "");
        if (/^\d+$/.test(stamp) && /^[0-9a-f]{40}$/.test(sha)) cloudInfo = { stamp, sha };
      })
      .catch(() => {})
      .finally(() => {
        cloudReadyFlight = null;
        cloudAbort.delete("ready");
        kick();
      });
  }

  function nextCloudKey(info, have, at) {
    const face = new Set(visibleCapKeys(CLOUDS, at, camDist()));
    const { c0, r0 } = levelColRow(CLOUDS, at.lon, at.lat);
    const distOf = (key) => {
      const p = key.split(":");
      return (
        Math.min(Math.abs(Number(p[1]) - c0), CLOUDS.cols - Math.abs(Number(p[1]) - c0)) +
        Math.abs(Number(p[2]) - r0)
      );
    };
    const pending = allCloudKeys().filter(
      (k) => !have.has(k) && !cloudSkip.has(info.stamp + ":" + k)
    );
    pending.sort((a, b) => {
      const af = face.has(a) ? 0 : 1;
      const bf = face.has(b) ? 0 : 1;
      if (af !== bf) return af - bf;
      return distOf(a) - distOf(b);
    });
    if (!pending.length) return null;
    return { key: pending[0], after: pending[1] };
  }

  function updateClouds() {
    if (!cloudsOn || disposed || !mesh) return;
    if (!cloudInfo || performance.now() >= cloudReadyAt) pullCloudReady();
    if (!cloudInfo) return;
    const info = cloudInfo;
    const at = viewLonLat();
    if (!at) return;
    if (!cloudMesh) {
      cloudMesh = new THREE.Group();
      cloudMesh.name = "clouds";
      mesh.add(cloudMesh);
    }
    // One decoded picture at a time. A finished set stays until the next is whole.
    if (cloudLoading.size > 0 || performance.now() < cloudRetryAt) return;
    if (cloudShown === info.stamp && cloudLive.size === 8) return;
    if (cloudShown && cloudShown !== info.stamp && cloudLive.size === 8) {
      if (cloudStageStamp !== info.stamp) {
        clearCloudStage();
        cloudStageStamp = info.stamp;
        cloudFails.clear();
        cloudRetryAt = 0;
      }
      if (cloudStage.size === 8) {
        swapCloudSet(info.stamp);
        return;
      }
      const next = nextCloudKey(info, cloudStage, at);
      if (next) loadCloudSquare(CLOUDS, next.key, info, next.after, true);
      return;
    }
    if (cloudShown !== info.stamp) {
      stopCloudLoads();
      for (const key of [...cloudLive.keys()]) dropCloudPiece(key);
      clearCloudStage();
      cloudShown = info.stamp;
      cloudSkip.clear();
      cloudFails.clear();
    }
    const next = nextCloudKey(info, cloudLive, at);
    if (next) loadCloudSquare(CLOUDS, next.key, info, next.after, false);
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
    // The squares meet at a pole. From above it you see every side, so the
    // one we were leaving out is a missing wedge. The closer photos stay a
    // small patch; these zoomed-out squares fill that wedge.
    if (level.cols <= 4) {
      const dist = camDist();
      const beta = Math.acos(THREE.MathUtils.clamp(RADIUS / Math.max(dist, 1.001), -1, 1));
      const wholeCircle = (latDeg) => {
        const L = THREE.MathUtils.degToRad(lat);
        const p = THREE.MathUtils.degToRad(latDeg);
        const far = Math.acos(
          THREE.MathUtils.clamp(Math.sin(L) * Math.sin(p) - Math.cos(L) * Math.cos(p), -1, 1)
        );
        return far < beta - 0.03;
      };
      for (let row = 0; row < level.rows; row++) {
        const latN = 90 - (row / level.rows) * 180;
        const latS = 90 - ((row + 1) / level.rows) * 180;
        if (!wholeCircle(latN) && !wholeCircle(latS) && !wholeCircle((latN + latS) / 2)) continue;
        for (let c = 0; c < level.cols; c++) keys.push(`${level.label}:${c}:${row}`);
      }
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

  let blankTex = null;
  /** 1×1 black photo used when a square does not need day or night. */
  function sharedBlank() {
    if (blankTex) return blankTex;
    const data = new Uint8Array([0, 0, 0, 255]);
    blankTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    blankTex.colorSpace = THREE.NoColorSpace;
    blankTex.magFilter = THREE.LinearFilter;
    blankTex.minFilter = THREE.LinearFilter;
    blankTex.generateMipmaps = false;
    blankTex.needsUpdate = true;
    return blankTex;
  }

  function disposeOwnMap(tex) {
    if (tex && tex !== blankTex) disposeMap(tex);
  }

  /**
   * Day, night, or both. A square entirely in daylight does not load city
   * lights. A square entirely in the dark does not load the day photo.
   * The line between them loads both, before either side would be missing.
   */
  function tileLight(level, c, r) {
    if (sunOnUniform.value < 0.5) return "night";
    const lat = 90 - ((r + 0.5) / level.rows) * 180;
    const lon = ((c + 0.5) / level.cols) * 360 - 180;
    const n = latLonToLocal(lat, lon, 1);
    if (mesh) {
      mesh.updateMatrix();
      n.applyQuaternion(mesh.quaternion);
      n.applyQuaternion(earthTilt.quaternion);
    }
    const lit = n.dot(sunDir);
    const span = (Math.PI * 2) / level.cols;
    const half = span * 0.5 * Math.SQRT2;
    // A small square also loads the other photo one square before the line arrives.
    const extra = span < Math.PI / 6 ? span : 0;
    const soon = Math.sin(Math.min(1.2, half + extra));
    if (lit > soon) return "day";
    if (lit < -soon) return "night";
    return "both";
  }

  function dropTile(key) {
    const piece = tileLive.get(key);
    if (!piece) return;
    tileLive.delete(key);
    if (piece.parent) piece.parent.remove(piece);
    piece.geometry.dispose();
    disposeOwnMap(piece.material.map);
    disposeOwnMap(piece.material.userData?.nightUniform?.value);
    piece.material.dispose();
  }

  function hideTiles() {
    tileWanted = new Set();
    holdLevel = null;
    if (tileGroup) tileGroup.visible = false;
    for (const key of [...tileLive.keys()]) dropTile(key);
    tileLevel = null;
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
    const segs = level.label === "8" ? 64 : 48;
    const geo = new THREE.SphereGeometry(
      RADIUS * level.radius,
      segs,
      segs,
      phiStart,
      phiLength,
      thetaStart,
      thetaLength
    );
    const nightU = { value: nightTex };
    const normalU = material.userData.normalUniform;
    const mat = makeTileMaterial(dayTex, nightU, normalU);
    mat.colorWrite = photosOn;
    mat.userData.nightUniform = nightU;
    const piece = new THREE.Mesh(geo, mat);
    // Closer squares sit further out and draw later, so they cover the ones under them.
    const order = { 86: -1, 32: -2, 16: -3, 8: -4 };
    piece.renderOrder = order[level.label] ?? -3;
    piece.userData.tileKey = `${level.label}:${c}:${r}`;
    return piece;
  }

  function loadTile(level, key) {
    if (tileLive.has(key) || tileLoading.has(key) || disposed || !material) return;
    const parts = key.split(":");
    const c = Number(parts[1]);
    const r = Number(parts[2]);
    const light = tileLight(level, c, r);
    const needDay = light !== "night";
    const needNight = light !== "day";
    tileLoading.add(key);
    let dayTex = needDay ? null : sharedBlank();
    let nightTex = needNight ? null : sharedBlank();
    let pending = (needDay ? 1 : 0) + (needNight ? 1 : 0);
    let failed = false;

    const abort = () => {
      if (needDay) disposeOwnMap(dayTex);
      if (needNight) disposeOwnMap(nightTex);
      dayTex = null;
      nightTex = null;
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
        tileLive.has(key) ||
        !dayTex ||
        !nightTex
      ) {
        abort();
        kick();
        return;
      }
      if (needDay) {
        configureTileColor(dayTex);
        releaseDecodedImage(dayTex);
      }
      if (needNight) {
        configureTileNight(nightTex);
        releaseDecodedImage(nightTex);
      }
      ensureTileGroup();
      const piece = makeTilePatch(level, c, r, dayTex, nightTex);
      piece.userData.light = light;
      tileGroup.add(piece);
      tileLive.set(key, piece);
      kick();
    };

    if (needDay) {
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
    }
    if (needNight) {
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
  }

  /** Next closer photos start loading before the current ones would look soft. */
  function soonLevel(dist) {
    const close = TILE_LEVELS[86];
    const fine = TILE_LEVELS[32];
    const mid = TILE_LEVELS[16];
    if (dist > close.onDist && dist <= close.onDist + 0.28) return close;
    if (dist > fine.onDist && dist <= fine.onDist + 0.35) return fine;
    if (dist > mid.onDist && dist <= mid.onDist + 0.45) return mid;
    return null;
  }

  function levelColRow(level, lon, lat) {
    let u = (lon + 180) / 360;
    u = ((u % 1) + 1) % 1;
    const v = THREE.MathUtils.clamp((90 - lat) / 180, 0, 0.9999);
    return {
      c0: Math.floor(u * level.cols),
      r0: Math.min(level.rows - 1, Math.floor(v * level.rows)),
    };
  }

  function keyDist(key, at) {
    const parts = key.split(":");
    const level = TILE_LEVELS[parts[0]];
    if (!level) return 99;
    const { c0, r0 } = levelColRow(level, at.lon, at.lat);
    const c = Number(parts[1]);
    const r = Number(parts[2]);
    const dc = Math.min(Math.abs(c - c0), level.cols - Math.abs(c - c0));
    return dc + Math.abs(r - r0);
  }

  function viewSamples() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const inset = 2;
    const xs = [rect.left + inset, rect.left + rect.width / 2, rect.right - inset];
    const ys = [rect.top + inset, rect.top + rect.height / 2, rect.bottom - inset];
    const hits = [];
    for (const y of ys) {
      for (const x of xs) {
        const hit = lonLatAt(x, y, true);
        if (!hit) return null;
        hits.push(hit);
      }
    }
    return hits;
  }

  // Squares the screen actually covers. When the limb is on screen, the
  // zoomed-out set is used instead, so the edge of the earth does not go empty.
  function keysOnScreen(level, at, samples) {
    if (!samples) return neededTileKeys(level, at.lon, at.lat, TILE_RING);
    let minLat = 90;
    let maxLat = -90;
    let minD = 180;
    let maxD = -180;
    for (const s of samples) {
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
      let d = s.lon - at.lon;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    const sampled = () => {
      const keys = [];
      const seen = new Set();
      for (const s of samples) {
        const { c0, r0 } = levelColRow(level, s.lon, s.lat);
        const key = `${level.label}:${c0}:${r0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
      }
      return keys;
    };
    // The closest photos are small. A wide view keeps the squares under the
    // sample points, and the coarser photo stays underneath the gaps.
    // Wider squares fill the whole view. A 40° span is a normal mid zoom,
    // and leaving the squares between the samples empty shows the blue globe.
    if (level.cols >= 40 && (maxD - minD > 40 || maxLat - minLat > 40)) return sampled();
    const dLon = 360 / level.cols;
    const dLat = 180 / level.rows;
    const row0 = Math.max(0, Math.floor((90 - maxLat) / dLat));
    const row1 = Math.min(level.rows - 1, Math.floor((90 - minLat) / dLat));
    const c0 = Math.floor((at.lon + minD + 180) / dLon);
    const c1 = Math.floor((at.lon + maxD + 180) / dLon);
    const keys = [];
    for (let row = row0; row <= row1; row++) {
      for (let c = c0; c <= c1; c++) keys.push(`${level.label}:${wrapCol(c, level.cols)}:${row}`);
    }
    if (keys.length > 24) return sampled();
    return keys;
  }

  function updateTiles() {
    if (disposed || !tilesEnabled || !mesh || !material) return;
    const dist = camDist();
    const level = pickTileLevel(dist);
    const soon = soonLevel(dist);
    const at = viewLonLat();
    if (!at) return;
    const samples = viewSamples();
    const base = TILE_LEVELS[8];
    const shown = level || soon;
    if (tileLevel && level && tileLevel !== level.label && tileLevel !== "8") holdLevel = tileLevel;
    if (!level) holdLevel = null;
    tileLevel = shown ? shown.label : null;
    ensureTileGroup();
    tileGroup.visible = true;

    const onScreen = shown ? new Set(keysOnScreen(shown, at, samples)) : new Set();
    const soonKeys =
      soon && shown !== soon
        ? new Set(keysOnScreen(soon, at, samples))
        : new Set();
    const screenReady = [...onScreen].every((k) => tileLive.has(k));
    // The far photos stay under the closer ones. Taking them off once the
    // closer set looks complete leaves a blue square whenever you move.
    const baseKeys = keysOnScreen(base, at, samples);
    tileWanted = new Set([...baseKeys, ...onScreen, ...soonKeys]);
    if (screenReady) holdLevel = null;
    const holdKeep =
      holdLevel && TILE_LEVELS[holdLevel]
        ? new Set(keysOnScreen(TILE_LEVELS[holdLevel], at, samples))
        : null;

    for (const key of [...tileLive.keys()]) {
      const parts = key.split(":");
      const lv = TILE_LEVELS[parts[0]];
      const piece = tileLive.get(key);
      if (lv && piece && piece.userData.light !== tileLight(lv, Number(parts[1]), Number(parts[2]))) {
        dropTile(key);
      }
    }
    for (const key of [...tileLive.keys()]) {
      if (holdKeep && key.split(":")[0] === holdLevel) {
        if (!holdKeep.has(key)) dropTile(key);
        continue;
      }
      if (!tileWanted.has(key)) dropTile(key);
    }

    const loadRank = (key) => {
      if (onScreen.has(key)) return 0;
      if (soonKeys.has(key)) return 1;
      if (key.startsWith("8:")) return 2;
      return 3;
    };
    const ordered = [...tileWanted].sort(
      (a, b) => loadRank(a) - loadRank(b) || keyDist(a, at) - keyDist(b, at)
    );
    if (tileLoading.size === 0) {
      for (const key of ordered) {
        if (!tileLive.has(key)) {
          const lv = TILE_LEVELS[key.split(":")[0]];
          if (lv) loadTile(lv, key);
          break;
        }
      }
    }
    const baseReady = baseKeys.every((k) => tileLive.has(k));
    if (!ready && baseReady) {
      ready = true;
      if (typeof onReady === "function") onReady();
    }
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
    if (!cloudsOn) {
      disposeClouds();
      kick();
      return cloudsOn;
    }
    cloudReadyAt = 0;
    updateClouds();
    kick();
    return cloudsOn;
  }

  function setRivers(on) {
    riversOn = !!on;
    if (riverLines) riverLines.visible = riversOn;
    if (!riversOn) {
      for (const key of [...riverLive.keys()]) dropRiverSquare(key);
      riverWanted = new Set();
      if (riverGroup) riverGroup.visible = false;
    } else if (riverGroup) {
      riverGroup.visible = true;
    }
    kick();
    return riversOn;
  }

  function applyPhotos() {
    if (material) material.colorWrite = photosOn;
    if (mesh) mesh.renderOrder = photosOn ? 0 : -6;
    for (const piece of tileLive.values()) {
      if (piece.material) piece.material.colorWrite = photosOn;
    }
  }

  function setPhotos(on) {
    photosOn = !!on;
    applyPhotos();
    kick();
    return photosOn;
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
    "input,button,select,textarea,a,label,#loc-dialog,.leaflet-container,.loc-dialog,#fact-sheet,#place-sheet,#pole-sheet,#line-sheet,#grid-tap,.cycle,.slider-track,.cycle-controls,.m-cell-fact,.vision-btn,.geo-btn,.live-btn,.sun-btn,.fact-sheet-inner,.fact-sheet-scrim";

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
    const roots = [
      "fact-sheet",
      "place-sheet",
      "pole-sheet",
      "line-sheet",
      "grid-tap",
      "loc-dialog",
      "loc-bar",
    ];
    let best = null;
    let bestArea = Infinity;
    for (const id of roots) {
      const root = document.getElementById(id);
      if (!root || root.hasAttribute("hidden")) continue;
      if (id === "grid-tap") {
        const r = root.getBoundingClientRect();
        if (
          pt.x >= r.left &&
          pt.x <= r.right &&
          pt.y >= r.top &&
          pt.y <= r.bottom
        ) {
          const area = Math.max(1, r.width * r.height);
          if (area < bestArea) {
            best = root;
            bestArea = area;
          }
        }
        continue;
      }
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
  const LINE_TAP_PX = 32;

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

  function lineUnderTap(clientX, clientY) {
    if (!gridOn || !gridLabels.length || !mesh) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    camera.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(_earthSphere.center);
    let best = null;
    let bestD = Infinity;
    for (const mark of gridLabels) {
      const info = mark.userData.line;
      if (!info || !mark.visible) continue;
      mark.getWorldPosition(_poleOut);
      _poleCam.copy(camera.position).sub(_poleOut);
      if (_tileLocal.copy(_poleOut).sub(_earthSphere.center).dot(_poleCam) <= 0) {
        continue;
      }
      _poleProj.copy(_poleOut).project(camera);
      if (_poleProj.z < -1 || _poleProj.z > 1) continue;
      const sx = (_poleProj.x * 0.5 + 0.5) * w + rect.left;
      const sy = (-_poleProj.y * 0.5 + 0.5) * h + rect.top;
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d <= LINE_TAP_PX && d < bestD) {
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
      onTap({
        lat: pole.lat,
        lon: pole.lon,
        pole,
        sx: gesture.sx,
        sy: gesture.sy,
      });
      return;
    }
    const line = lineUnderTap(gesture.sx, gesture.sy);
    if (line) {
      onTap({
        lat: line.lat,
        lon: line.lon,
        line,
        sx: gesture.sx,
        sy: gesture.sy,
      });
      return;
    }
    const ll = lonLatAt(gesture.sx, gesture.sy, true);
    if (!ll) {
      onTap(null);
      return;
    }
    onTap({ ...ll, sx: gesture.sx, sy: gesture.sy });
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

  function setOrbiting(on) {
    orbiting = !!on;
    if (!orbiting) lastOrbitMs = 0;
    kick();
    return orbiting;
  }

  function isOrbiting() {
    return orbiting;
  }

  /**
   * Latest GFS wind. Loaded only while W is on, then dropped.
   * Three real hours pass each second so the streams can be seen.
   * One-pixel lines. Each piece is the path the air took.
   * A newer forecast replaces this one while W is on.
   * Sharp turns are spread across 6 forecast squares.
   * A frame only rewrites the moving tip.
   */
  const WIND_R = 1.016;
  const WIND_MAX = 48000;
  const WIND_SEGS = 200;
  const WIND_SUB = 1;
  const WIND_HOUR = 10800;
  const WIND_TEX_W = 4800;
  const WIND_TEX_ROWS = 10;
  let windStep = 6 / (12 * (WIND_HOUR / 1000));
  const windSoft = 6;
  let windOn = false;
  let windLevel = 0;
  let windToken = 0;
  let windBuf = null;
  let windU = null;
  let windV = null;
  let windNlon = 0;
  let windNlat = 0;
  let windScale = 100;
  let windCycle = 0;
  let windTrailSet = 48000;
  let windDensityMul = 0;
  let windCount = 48000;
  let windShow = 199;
  let windFadePow = 1;
  let windFloor = 0.1;
  let windLines = null;
  let windMat = null;
  let windGeo = null;
  let windTex = null;
  let windKeys = null;
  let windBirth = null;
  let windLats = null;
  let windBright = null;
  let windLons = null;
  let windSu = null;
  let windSv = null;
  let windAge = null;
  let windLive = null;
  let windHead = 0;
  let windAcc = 0;
  let windWarm = 0;
  let windFull = false;
  let windClock = 0;
  let windReadyAt = 0;
  let windReadyFlight = null;
  let windFileFlight = null;
  let windFileAt = 0;
  let windInfo = null;
  const _wLL = [0, 0];
  const windQuat = new THREE.Quaternion();
  const windLit = new THREE.Vector3();
  const WIND_DAY_W = 90;
  const WIND_DAY_H = 45;
  const windDay = new Float32Array(WIND_DAY_W * WIND_DAY_H);
  let windDayQx = NaN;
  let windDayQy = NaN;
  let windDayQz = NaN;
  let windDayQw = NaN;
  let windDaySx = NaN;
  let windDaySy = NaN;
  let windDaySz = NaN;
  const uWindHead = { value: 0 };
  const uWindShow = { value: 60 };
  const uWindFade = { value: 1 };

  function windShowSegs() {
    const t = Math.max(0, Math.min(1, (windShow - 30) / (279 - 30)));
    const seconds = (4 + t * (42 - 4)) * 0.3;
    return Math.max(1, Math.min(WIND_SEGS - 1, seconds / windStep));
  }

  function syncWindDraw() {
    if (!windGeo) return;
    const micro = Math.min(
      (WIND_SEGS - 1) * WIND_SUB,
      Math.max(1, Math.ceil(windShowSegs() * WIND_SUB))
    );
    windGeo.setDrawRange(0, micro * 2);
    windGeo.instanceCount = windCount;
  }

  function applyWindCount() {
    const prev = windCount;
    windCount = Math.max(
      1,
      Math.min(WIND_MAX, Math.round(windTrailSet * (1 + windDensityMul)))
    );
    if (!windLats || windCount <= prev) {
      syncWindDraw();
      return;
    }
    for (let i = prev; i < windCount; i++) {
      spawnWind(i);
      windBirth[i] = 0;
      for (let s = 0; s < WIND_SEGS; s++) windKeys[(s * WIND_MAX + i) * 2] = -1000;
    }
    windFull = true;
    syncWindDraw();
  }

  function spawnWind(i) {
    windLats[i] = Math.asin(Math.random() * 2 - 1) * (180 / Math.PI);
    windLons[i] = Math.random() * 360 - 180;
    windAge[i] = 28 + Math.random() * 28;
    windSu[i] = 0;
    windSv[i] = 0;
    windLive[i] = 0;
  }

  function writeKey(slot, i, lat, lon, bright, birth) {
    const o = (slot * WIND_MAX + i) * 2;
    windKeys[o] = birth ? lat + 360 : lat;
    windKeys[o + 1] = Math.round(lon * 1000) + bright;
  }

  function windGroundLit(lat, lon) {
    earthPoint(lat, lon, 1, _earthOut);
    windLit.set(_earthOut[0], _earthOut[1], _earthOut[2]).applyQuaternion(windQuat);
    return windLit.dot(sunDir);
  }

  function dayAmount(ndl) {
    const t = ndl <= -0.04 ? 0 : ndl >= 0.2 ? 1 : (ndl + 0.04) / 0.24;
    const u = t < 0 ? 0 : t > 1 ? 1 : t;
    return u * u * (3 - 2 * u);
  }

  // Sunlight over land changes only when the Earth turns or the sun moves.
  function refreshWindDay() {
    if (!mesh) return;
    windQuat.copy(earthTilt.quaternion).multiply(mesh.quaternion);
    const qx = windQuat.x;
    const qy = windQuat.y;
    const qz = windQuat.z;
    const qw = windQuat.w;
    const sx = sunDir.x;
    const sy = sunDir.y;
    const sz = sunDir.z;
    if (
      qx === windDayQx && qy === windDayQy && qz === windDayQz && qw === windDayQw &&
      sx === windDaySx && sy === windDaySy && sz === windDaySz
    ) {
      return;
    }
    windDayQx = qx;
    windDayQy = qy;
    windDayQz = qz;
    windDayQw = qw;
    windDaySx = sx;
    windDaySy = sy;
    windDaySz = sz;
    const latStep = 180 / WIND_DAY_H;
    const lonStep = 360 / WIND_DAY_W;
    for (let y = 0; y < WIND_DAY_H; y++) {
      const lat = -90 + (y + 0.5) * latStep;
      const row = y * WIND_DAY_W;
      for (let x = 0; x < WIND_DAY_W; x++) {
        const lon = -180 + (x + 0.5) * lonStep;
        windDay[row + x] = dayAmount(windGroundLit(lat, lon));
      }
    }
  }

  function windDayAt(lat, lon) {
    let L = lon;
    if (L < -180 || L >= 180) {
      L = ((L + 180) % 360 + 360) % 360 - 180;
    }
    const fx = ((L + 180) / 360) * WIND_DAY_W - 0.5;
    const fy = ((lat + 90) / 180) * WIND_DAY_H - 0.5;
    let x0 = Math.floor(fx);
    const tx = fx - x0;
    x0 %= WIND_DAY_W;
    if (x0 < 0) x0 += WIND_DAY_W;
    const x1 = x0 + 1 === WIND_DAY_W ? 0 : x0 + 1;
    let y0 = Math.floor(fy);
    let ty = fy - y0;
    if (y0 < 0) {
      y0 = 0;
      ty = 0;
    }
    let y1 = y0 + 1;
    if (y1 >= WIND_DAY_H) {
      y1 = WIND_DAY_H - 1;
      ty = 0;
    }
    const i00 = windDay[y0 * WIND_DAY_W + x0];
    const i10 = windDay[y0 * WIND_DAY_W + x1];
    const i01 = windDay[y1 * WIND_DAY_W + x0];
    const i11 = windDay[y1 * WIND_DAY_W + x1];
    const a = i00 + (i10 - i00) * tx;
    const b = i01 + (i11 - i01) * tx;
    return a + (b - a) * ty;
  }

  // Water keeps speed as brightness, including just offshore.
  // Daytime land is lifted so the line shows on the bright ground.
  function windHereBright(u, v, lat, lon) {
    const speed = Math.hypot(u, v);
    const t = speed > 10 ? 1 : speed * 0.1;
    const sea = windFloor + 0.28 * t;
    if (!overLand(lat, lon)) return sea;
    const day = windDayAt(lat, lon);
    if (day <= 0) return sea;
    return sea + (0.62 + 0.28 * t - sea) * day;
  }

  function flushWind(slots) {
    if (!windTex) return;
    const props = renderer.properties.get(windTex);
    const glTex = props && props.__webglTexture;
    if (!glTex || windFull) {
      windTex.needsUpdate = true;
      windFull = false;
      return;
    }
    const gl = renderer.getContext();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    renderer.state.bindTexture(gl.TEXTURE_2D, glTex);
    const row = WIND_MAX * 2;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s];
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        slot * WIND_TEX_ROWS,
        WIND_TEX_W,
        WIND_TEX_ROWS,
        gl.RG,
        gl.FLOAT,
        windKeys.subarray(slot * row, slot * row + row)
      );
    }
  }

  function stepWindAll(dt, commit) {
    const slot = windHead;
    refreshWindDay();
    for (let i = 0; i < windCount; i++) {
      windAge[i] -= dt;
      if (windAge[i] <= 0) spawnWind(i);
      const uv = windSample(windLats[i], windLons[i]);
      if (!windLive[i]) {
        windSu[i] = uv[0];
        windSv[i] = uv[1];
      } else {
        windSu[i] = windSu[i] * 0.82 + uv[0] * 0.18;
        windSv[i] = windSv[i] * 0.82 + uv[1] * 0.18;
      }
      stepWind(windLats[i], windLons[i], windSu[i], windSv[i], dt, WIND_HOUR, _wLL);
      windLats[i] = _wLL[0];
      windLons[i] = _wLL[1];
      const br = windHereBright(windSu[i], windSv[i], windLats[i], windLons[i]);
      windBright[i] = br;
      if (!windLive[i]) continue;
      writeKey(slot, i, windLats[i], windLons[i], br, windBirth[i]);
    }
    const dirty = [slot];
    if (commit) {
      const next = (windHead + 1) % WIND_SEGS;
      for (let i = 0; i < windCount; i++) {
        const birth = !windLive[i];
        writeKey(next, i, windLats[i], windLons[i], windBright[i], birth);
        windBirth[i] = birth ? 1 : 0;
        windLive[i] = 1;
      }
      windHead = next;
      uWindHead.value = windHead;
      dirty.push(next);
    }
    flushWind(dirty);
  }

  function resetWindField() {
    windHead = 0;
    windAcc = 0;
    windClock = 0;
    uWindHead.value = 0;
    if (windKeys) windKeys.fill(-1000);
    if (windBirth) windBirth.fill(0);
    for (let i = 0; i < WIND_MAX; i++) spawnWind(i);
    refreshWindDay();
    for (let i = 0; i < windCount; i++) {
      const uv = windSample(windLats[i], windLons[i]);
      windSu[i] = uv[0];
      windSv[i] = uv[1];
      writeKey(0, i, windLats[i], windLons[i], windHereBright(uv[0], uv[1], windLats[i], windLons[i]), false);
      windLive[i] = 1;
    }
    windWarm = Math.round(windShowSegs());
    windFull = true;
  }

  function disposeWindMesh() {
    windWarm = 0;
    if (windLines) {
      if (windLines.parent) windLines.parent.remove(windLines);
      windLines.geometry.dispose();
      windLines = null;
    }
    windGeo = null;
    windMat?.dispose();
    windMat = null;
    windTex?.dispose();
    windTex = null;
    windKeys = null;
    windBirth = null;
    windLats = windLons = windSu = windSv = windAge = windLive = windBright = null;
  }

  function disposeWind() {
    windOn = false;
    windBuf = null;
    windU = null;
    windV = null;
    windInfo = null;
    windReadyAt = 0;
    windFileAt = 0;
    if (windReadyFlight) windReadyFlight.abort();
    windReadyFlight = null;
    if (windFileFlight) windFileFlight.abort();
    windFileFlight = null;
    disposeWindMesh();
  }

  function ensureWindLines() {
    if (!mesh || windLines) return;
    windKeys = new Float32Array(WIND_TEX_W * WIND_TEX_ROWS * WIND_SEGS * 2);
    windKeys.fill(-1000);
    windBirth = new Uint8Array(WIND_MAX);
    windLats = new Float32Array(WIND_MAX);
    windLons = new Float32Array(WIND_MAX);
    windSu = new Float32Array(WIND_MAX);
    windSv = new Float32Array(WIND_MAX);
    windAge = new Float32Array(WIND_MAX);
    windLive = new Uint8Array(WIND_MAX);
    windBright = new Float32Array(WIND_MAX);
    windTex = new THREE.DataTexture(
      windKeys,
      WIND_TEX_W,
      WIND_TEX_ROWS * WIND_SEGS,
      THREE.RGFormat,
      THREE.FloatType
    );
    windTex.flipY = false;
    windTex.generateMipmaps = false;
    windTex.magFilter = THREE.NearestFilter;
    windTex.minFilter = THREE.NearestFilter;
    windTex.wrapS = THREE.ClampToEdgeWrapping;
    windTex.wrapT = THREE.ClampToEdgeWrapping;
    windTex.colorSpace = THREE.NoColorSpace;
    windTex.needsUpdate = true;
    const verts = (WIND_SEGS - 1) * WIND_SUB * 2;
    const ids = new Float32Array(WIND_MAX);
    for (let i = 0; i < WIND_MAX; i++) ids[i] = i;
    windGeo = new THREE.InstancedBufferGeometry();
    windGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    windGeo.setAttribute("aId", new THREE.InstancedBufferAttribute(ids, 1));
    windGeo.instanceCount = windCount;
    windMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uKeys: { value: windTex },
        uHead: uWindHead,
        uShow: uWindShow,
        uFadePow: uWindFade,
      },
      vertexShader: `
        attribute float aId;
        uniform sampler2D uKeys;
        uniform float uHead;
        uniform float uShow;
        uniform float uFadePow;
        varying float vFade;
        vec2 keyAt(int behind) {
          if (behind < 0 || behind >= ${WIND_SEGS}) return vec2(-1000.0, 0.0);
          int slot = int(mod(uHead - float(behind) + ${WIND_SEGS}.0, ${WIND_SEGS}.0));
          int particle = int(aId + 0.5);
          int x = particle - (particle / ${WIND_TEX_W}) * ${WIND_TEX_W};
          int y = slot * ${WIND_TEX_ROWS} + (particle / ${WIND_TEX_W});
          return texelFetch(uKeys, ivec2(x, y), 0).rg;
        }
        vec3 onGlobe(float latDeg, float lonDeg) {
          float lat = radians(latDeg);
          float lon = radians(lonDeg);
          float cl = cos(lat);
          return vec3(cl * cos(lon), sin(lat), -cl * sin(lon));
        }
        void main() {
          int pair = gl_VertexID / 2;
          int which = gl_VertexID - pair * 2;
          int span = pair / ${WIND_SUB};
          float sub = float(${WIND_SUB});
          float age0 = float(pair) / sub;
          float age1 = float(pair + 1) / sub;
          float age = which == 0 ? age0 : min(age1, uShow);
          float along = which == 0 ? 0.0 : clamp((min(age1, uShow) - age0) / max(age1 - age0, 0.0001), 0.0, 1.0);
          vec2 k0 = keyAt(span);
          vec2 k1 = keyAt(span + 1);
          bool hide = age0 >= uShow || k0.x < -180.0 || k1.x < -180.0 || k0.x > 180.0;
          float lat0 = k0.x > 180.0 ? k0.x - 360.0 : k0.x;
          float lat1 = k1.x > 180.0 ? k1.x - 360.0 : k1.x;
          float lon0 = floor(k0.y) / 1000.0;
          float lon1 = floor(k1.y) / 1000.0;
          vec3 b = onGlobe(lat0, lon0);
          vec3 c = onGlobe(lat1, lon1);
          if (!hide && dot(b, c) < 0.99) hide = true;
          if (hide) {
            vFade = 0.0;
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          vec3 p = mix(b, c, along);
          p *= (${WIND_R} / length(p));
          float br0 = k0.y - floor(k0.y);
          float br1 = k1.y - floor(k1.y);
          float br = mix(br0, br1, along);
          float fade = 1.0 - age / uShow;
          vFade = fade <= 0.0 ? 0.0 : pow(fade, uFadePow) * br;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying float vFade;
        void main() {
          if (vFade < 0.004) discard;
          gl_FragColor = vec4(0.78, 0.88, 1.0, vFade);
        }
      `,
    });
    windLines = new THREE.LineSegments(windGeo, windMat);
    windLines.name = "wind";
    windLines.frustumCulled = false;
    windLines.renderOrder = 8;
    mesh.add(windLines);
    uWindShow.value = windShowSegs();
    uWindFade.value = windFadePow;
    syncWindDraw();
    resetWindField();
  }

  function adoptWind(buf) {
    const view = new DataView(buf);
    const magic = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    );
    if (magic !== "WND1") throw new Error("wind " + magic);
    windNlon = view.getUint16(4, true);
    windNlat = view.getUint16(6, true);
    const nlev = view.getUint16(8, true);
    windScale = view.getUint16(10, true) || 100;
    windCycle = view.getUint32(12, true);
    const plane = windNlon * windNlat;
    if (nlev < 2 || buf.byteLength < 16 + plane * 4 * 2) throw new Error("wind short");
    windBuf = buf;
    buildWindFields();
  }

  function buildWindFields() {
    if (!windBuf) return;
    const plane = windNlon * windNlat;
    const rawU = new Int16Array(windBuf, 16, plane);
    const rawV = new Int16Array(windBuf, 16 + plane * 2, plane);
    windU = softenWind(rawU, windNlon, windNlat, windSoft);
    windV = softenWind(rawV, windNlon, windNlat, windSoft);
    windBuf = null;
  }

  // Neighbors in the file can almost reverse. Softening by a few forecast
  // squares turns that pinch into a curve. Only the surface wind is kept.
  function softenWind(src, nlon, nlat, sigma) {
    const radius = Math.max(1, Math.round(sigma * 3));
    const weight = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const w = Math.exp(-0.5 * (i / sigma) * (i / sigma));
      weight[i + radius] = w;
      sum += w;
    }
    for (let i = 0; i < weight.length; i++) weight[i] /= sum;
    const wide = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < nlat; y++) {
      const row = y * nlon;
      for (let x = 0; x < nlon; x++) {
        let acc = 0;
        for (let i = 0; i < weight.length; i++) {
          const xx = (x + i - radius + nlon) % nlon;
          acc += src[row + xx] * weight[i];
        }
        wide[row + x] = acc;
      }
    }
    for (let y = 0; y < nlat; y++) {
      for (let x = 0; x < nlon; x++) {
        let acc = 0;
        for (let i = 0; i < weight.length; i++) {
          let yy = y + i - radius;
          if (yy < 0) yy = 0;
          else if (yy >= nlat) yy = nlat - 1;
          acc += wide[yy * nlon + x] * weight[i];
        }
        out[y * nlon + x] = acc;
      }
    }
    return out;
  }

  function windSample(lat, lon) {
    const raw = sampleUV(windU, windV, lat, lon, windNlon, windNlat);
    return [raw[0] / windScale, raw[1] / windScale];
  }

  function pullWindReady() {
    if (windReadyFlight) return;
    windReadyAt = performance.now() + 10 * 60 * 1000;
    const ctrl = new AbortController();
    windReadyFlight = ctrl;
    const readyUrl =
      "https://raw.githubusercontent.com/agamkram/superearth-app/wind-data/ready.json?t=" +
      Math.floor(Date.now() / 60000);
    fetch(readyUrl, { cache: "no-store", signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const cycle = String((data && data.cycle) || "");
        const sha = String((data && data.sha) || "");
        if (/^\d{10}$/.test(cycle) && /^[0-9a-f]{40}$/.test(sha)) windInfo = { cycle, sha };
      })
      .catch(() => {})
      .finally(() => {
        if (windReadyFlight === ctrl) windReadyFlight = null;
        kick();
      });
  }

  function pullFreshWind() {
    if (!windOn || !windInfo || windFileFlight || !windU) return;
    if (String(windCycle) === windInfo.cycle) return;
    if (performance.now() < windFileAt) return;
    windFileAt = performance.now() + 60 * 1000;
    const info = windInfo;
    const token = ++windToken;
    const ctrl = new AbortController();
    windFileFlight = ctrl;
    fetch(`https://cdn.jsdelivr.net/gh/agamkram/superearth-app@${info.sha}/wind.bin`, {
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error("wind " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed || token !== windToken || !windOn) return;
        adoptWind(buf);
        ensureWindLines();
        if (windLines) resetWindField();
        kick();
        if (typeof onWind === "function") onWind();
      })
      .catch(() => {})
      .finally(() => {
        if (windFileFlight === ctrl) windFileFlight = null;
      });
  }

  function updateWind(now) {
    if (!windOn) return;
    if (!windReadyFlight && performance.now() >= windReadyAt) pullWindReady();
    pullFreshWind();
    if (!windU) return;
    if (!windLines) {
      ensureWindLines();
      if (!windLines) return;
    }
    uWindShow.value = windShowSegs();
    uWindFade.value = windFadePow;
    syncWindDraw();
    const t = typeof now === "number" ? now : performance.now();
    if (windWarm > 0) {
      const batch = 6;
      for (let n = 0; n < batch && windWarm > 0; n++) {
        stepWindAll(windStep, true);
        windWarm--;
      }
      windClock = t;
      windAcc = 0;
      return;
    }
    if (!windClock) windClock = t;
    const dt = Math.min(0.05, (t - windClock) / 1000);
    windClock = t;
    if (dt <= 0) return;
    windAcc += dt;
    const commit = windAcc >= windStep;
    if (commit) windAcc = 0;
    stepWindAll(dt, commit);
  }

  function windHere() {
    if (!windOn) return null;
    if (!windU) return { loading: true, level: windLevel };
    const uv = windSample(observerLat, observerLon);
    const said = windFrom(uv[0], uv[1]);
    return {
      loading: false,
      level: windLevel,
      levelName: "10 m",
      u: uv[0],
      v: uv[1],
      speed: said.speed,
      from: said.from,
      cycle: windCycle,
    };
  }

  function setWindLook(opts) {
    if (!opts) return;
    if (opts.trails != null) windTrailSet = Math.max(1, Math.min(WIND_MAX, opts.trails | 0));
    if (opts.density != null) windDensityMul = Math.max(0, opts.density);
    if (opts.trails != null || opts.density != null) applyWindCount();
    if (opts.length != null) windShow = Math.max(1, Math.min(400, opts.length | 0));
    if (opts.fade != null) windFadePow = opts.fade;
    if (opts.light != null) windFloor = opts.light;
    uWindShow.value = windShowSegs();
    uWindFade.value = windFadePow;
    syncWindDraw();
    if (windOn) kick();
  }

  function setWind(level) {
    if (level < 0) {
      windToken++;
      disposeWind();
      kick();
      if (typeof onWind === "function") onWind();
      return;
    }
    const turningOn = !windOn;
    windLevel = 0;
    windOn = true;
    if (windU) {
      ensureWindLines();
      if (turningOn && windLines) resetWindField();
      kick();
      if (typeof onWind === "function") onWind();
      return;
    }
    const token = ++windToken;
    fetch(new URL(`./wind.bin?v=${TEX_VER}`, import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error("wind " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (disposed || token !== windToken) return;
        adoptWind(buf);
        if (!windOn) return;
        ensureWindLines();
        kick();
        if (typeof onWind === "function") onWind();
      })
      .catch(() => {
        if (token !== windToken) return;
        disposeWind();
        if (typeof onWind === "function") onWind();
      });
    kick();
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
    if (orbiting) {
      if (!lastOrbitMs) lastOrbitMs = t;
      const dt = Math.min(0.05, (t - lastOrbitMs) / 1000);
      lastOrbitMs = t;
      if (dt > 0) {
        userSpin += ORBIT_RAD_PER_SEC * dt;
        applyEphemeris({ skipKick: true });
      }
    }
    syncEarth();
    updateTiles();
    updateClouds();
    updateRiverSquares();
    syncRiverPixels();
    if (gridOn) updateGridLabels();
    if (windOn) updateWind(t);
    renderer.render(scene, camera);
    // Idle when still. Real Earth spin is invisible frame-to-frame; the page
    // refreshes Live on a timer. Keep looping only while dragging, tipping, orbiting, or the wind is on.
    if (oneFinger || twoFinger || tilting || orbiting || windOn) kick();
  }

  /** Bar height changed (cards folded). Keep a zoomed view; refit the opening pose. */
  function refitChrome() {
    const prevHome = homeDist;
    const dist = camDist();
    const centered = target.lengthSq() < 1e-4;
    const atOpening =
      centered &&
      Math.abs(dist - prevHome) / Math.max(prevHome, 0.01) < 0.03;
    homeDist = computeHomeDistance(
      width || window.innerWidth || 1,
      height || window.innerHeight || 1
    );
    homeLiftY = homeScreenOffsetY();
    const next = THREE.MathUtils.clamp(
      atOpening ? homeDist : dist,
      MIN_DIST,
      maxCamDist()
    );
    if (Math.abs(next - dist) > 1e-3) {
      if (next >= homeDist - 1e-4) {
        target.set(0, 0, 0);
        clearScreenPan();
      }
      readSpherical();
      spherical.radius = next;
      writeCamera();
      syncEarth();
      prevCamDist = camDist();
    }
    applyCanvasPanTransform();
  }

  applyEphemeris();
  loadBase();
  loadSkyMoon();
  loadBorders();
  loadLakes();
  loadBigRivers();
  buildGrid();
  loadGeoLines();
  fitToHost();
  applyHomeFraming();
  kick();

  return {
    resize,
    fitToHost,
    refitChrome,
    resetView,
    setObserver,
    setClouds,
    setRivers,
    setPhotos,
    setBorders,
    setGrid,
    setTilt,
    setOrbiting,
    isOrbiting,
    setAurora,
    setAuroraShown,
    setSun,
    setWind,
    setWindLook,
    windHere,
    setCapitalMark,
    hideCapitalMark,
    setTapMark,
    hideTapMark,
    setTime,
    getPhaseInfo,
    getObserver,
    getCamDist: () => camDist(),
    isReady: () => ready,
    dispose() {
      disposed = true;
      cancelAnimationFrame(animId);
      animId = 0;
      orbiting = false;
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
      disposeClouds();
      disposeWind();
      disposePoleMarks();
      disposeCapDot();
      disposeTapDot();
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
