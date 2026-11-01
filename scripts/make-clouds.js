/**
 * Build the cloud picture for one satellite time.
 *
 *   node scripts/make-clouds.js 2026-11-01T18:00:00Z /tmp/clouds-alpha.png
 *
 * The processing is Matt Eason's live-cloud-maps (CC0), kept as written so the
 * clouds look the same. Two changes: every EUMETSAT layer is asked for the same
 * time, and only the full-size cloud picture with transparency is written.
 * cloud-frame.png is that project's frame.png.
 */
const Jimp = require("jimp");
const path = require("path");
const https = require("https");

const TIME = process.argv[2];
const OUT = process.argv[3];
if (!/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(TIME || "") || !OUT) {
  console.error("usage: node make-clouds.js 2026-11-01T18:00:00Z out.png");
  process.exit(2);
}

const SOURCE_WIDTH = 8192;
const SOURCE_HEIGHT = SOURCE_WIDTH / 2;

const cachedJpegDecoder = Jimp.decoders["image/jpeg"];
Jimp.decoders["image/jpeg"] = (data) => cachedJpegDecoder(data, { maxMemoryUsageInMB: 1024 });

// EUMETSAT cuts a request off at about 200 seconds, and a 4096 square takes
// about that long to draw. Each half is fetched as four 2048 pieces on the
// same pixel grid and joined.
const PIECE = SOURCE_HEIGHT / 2;

function pieceUrl(name, latMin, lonMin) {
  return (
    "https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetMap&version=1.3.0" +
    `&layers=mumi:${name}&styles=&format=image/png&crs=EPSG:4326` +
    `&bbox=${latMin},${lonMin},${latMin + 90},${lonMin + 90}` +
    `&width=${PIECE}&height=${PIECE}&time=${TIME}`
  );
}

let running = 0;
const waiting = [];
function limited(job) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          if (waiting.length) waiting.shift()();
        });
    };
    if (running < 6) start();
    else waiting.push(start);
  });
}

async function half(name, west) {
  const out = new Jimp(SOURCE_HEIGHT, SOURCE_HEIGHT);
  const spots = [
    [0, west, 0, 0],
    [0, west + 90, PIECE, 0],
    [-90, west, 0, PIECE],
    [-90, west + 90, PIECE, PIECE],
  ];
  const pieces = await Promise.all(
    spots.map(([lat, lon]) => limited(() => download(pieceUrl(name, lat, lon))).then((b) => Jimp.read(b)))
  );
  pieces.forEach((p, i) => {
    if (p.bitmap.width !== PIECE || p.bitmap.height !== PIECE) throw new Error("piece size " + name);
    out.blit(p, spots[i][2], spots[i][3]);
  });
  return out;
}

function download(url, tries = 3) {
  return fetchOnce(url).catch((err) => {
    if (tries <= 1) throw err;
    console.log("retrying after:", err.message);
    return download(url, tries - 1);
  });
}

function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 600000 }, (res) => {
      const type = String(res.headers["content-type"] || "");
      if (res.statusCode !== 200 || !type.startsWith("image/png")) {
        res.resume();
        reject(new Error(`EUMETSAT answered ${res.statusCode} ${type} for ${url}`));
        return;
      }
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve(Buffer.concat(parts)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("EUMETSAT timed out for " + url)));
    req.on("error", reject);
  });
}

async function main() {
  const [irMapLeft, irMapRight, dustMapLeft, dustMapRight, visibleMapLeft, visibleMapRight, frame] =
    await Promise.all([
      half("worldcloudmap_ir108", -180),
      half("worldcloudmap_ir108", 0),
      half("wideareacoverage_rgb_dust", -180),
      half("wideareacoverage_rgb_dust", 0),
      half("wideareacoverage_rgb_natural", -180),
      half("wideareacoverage_rgb_natural", 0),
      Jimp.read(path.join(__dirname, "cloud-frame.png")),
    ]);
  const cloudMapWithAlpha = processImages(
    irMapLeft, irMapRight, dustMapLeft, dustMapRight, visibleMapLeft, visibleMapRight, frame
  );
  await cloudMapWithAlpha.deflateLevel(9).colorType(4).writeAsync(OUT);
  console.log("wrote", OUT, "for", TIME);
}

function interpolate(fromA, toA, fromB, toB, input) {
  if(input < fromA) {
    return fromB
  }

  if(input > toA) {
    return toB
  }

  const proportionOfRange = (input - fromA) / (toA - fromA);
  return fromB + (toB - fromB) * proportionOfRange;
}

function screen(A, B) {
  const ax = A/255.0
  const bx = B/255.0
  return (1 - (1 - ax) * (1 - bx)) * 255
}

function multiply(A, B) {
  const ax = A/255.0
  const bx = B/255.0
  return ax * bx * 255
}

function gamma(gamma, input) {
  const gammaCorrection = 1 / gamma
  return 255 * Math.pow(input / 255, gammaCorrection)
}

function processImages(irMapLeft, irMapRight, dustMapLeft, dustMapRight, visibleMapLeft, visibleMapRight, frame) {
  // Halves are joined the wrong way round so the antimeridian gap sits in the middle; swapped back below.
  const irMap = new Jimp(SOURCE_WIDTH, SOURCE_HEIGHT);
  irMap.blit(irMapRight, 0, 0).blit(irMapLeft, SOURCE_WIDTH/2, 0);

  const dustMap = new Jimp(SOURCE_WIDTH, SOURCE_HEIGHT);
  dustMap.blit(dustMapRight, 0, 0).blit(dustMapLeft, SOURCE_WIDTH/2, 0);

  const visibleMap = new Jimp(SOURCE_WIDTH, SOURCE_HEIGHT);
  visibleMap.blit(visibleMapRight, 0, 0).blit(visibleMapLeft, SOURCE_WIDTH/2, 0);

  const cloudMap = new Jimp(SOURCE_WIDTH, SOURCE_HEIGHT, 0xff0000ff);

  let gapStartX = null;
  let gapEndX = null;
  let gapStartVal = null;
  let gapEndVal = null;
  let afterGapCounter = 0;

  cloudMap.scan(0, 0, cloudMap.bitmap.width, cloudMap.bitmap.height, function(x, y, idx) {
    const dustR = dustMap.bitmap.data[idx];
    const dustB = 255 - dustMap.bitmap.data[idx+2];

    const dustRMasked = (dustR / 255.0) * (dustB / 255.0) * 255
    const dust = screen(dustRMasked, 0.5 * dustB);

    const ir = interpolate(72, 178, 0, 255, irMap.bitmap.data[idx]);

    const irGammaCorrected = gamma(1.46, ir);

    const outputValue = gamma(2.0, screen(dust, irGammaCorrected*0.77))

    const visibleR = visibleMap.bitmap.data[idx];
    const visibleG = visibleMap.bitmap.data[idx+1];
    const visibleB = visibleMap.bitmap.data[idx+2];

    const visibleDiff = Math.max(visibleR, visibleG, visibleB) - Math.min(visibleR, visibleG, visibleB);

    const visibleGBDiff = Math.abs(visibleG - visibleB)

    if(visibleDiff < 25 || (visibleR < visibleG && visibleGBDiff < 11 && visibleG > 150)) {
      const visibleValue = gamma(1.5, Math.max(visibleR, visibleG, visibleB));

      const fadeStartX = cloudMap.bitmap.width * 0.4;
      const fadeEndX = cloudMap.bitmap.width * 0.6
      const amAdjustment =
        (x > fadeStartX && x < fadeEndX && visibleValue < 255)
          ? Math.abs(interpolate(fadeStartX, fadeEndX, -1, 1, x))
          : 1;
      cloudMap.bitmap.data[idx] = Math.max(visibleValue*amAdjustment, outputValue);
      cloudMap.bitmap.data[idx + 1] = Math.max(visibleValue*amAdjustment, outputValue);
      cloudMap.bitmap.data[idx + 2] = Math.max(visibleValue*amAdjustment, outputValue);
    } else {
      cloudMap.bitmap.data[idx] = outputValue;
      cloudMap.bitmap.data[idx + 1] = outputValue;
      cloudMap.bitmap.data[idx + 2] = outputValue;
    }

    if(y > cloudMap.bitmap.height / 8 && y < cloudMap.bitmap.height - cloudMap.bitmap.height / 8) {
      const thisPixelVal = cloudMap.bitmap.data[idx];

      const GAP_BUFFER = 3;

      if(thisPixelVal === 255 && gapStartX == null) {
        gapStartX = x - GAP_BUFFER;
        gapStartVal = cloudMap.bitmap.data[idx - 4 * GAP_BUFFER];
      } else if(gapStartX != null && thisPixelVal < 255 && afterGapCounter < GAP_BUFFER) {
        afterGapCounter++;
      } else if(thisPixelVal < 255 && gapStartX != null && afterGapCounter === GAP_BUFFER) {
        gapEndX = x;
        gapEndVal = thisPixelVal;

        const addedPerStep = (gapEndVal - gapStartVal) / (gapEndX - gapStartX)

        for(let gapX = gapStartX; gapX <= gapEndX; gapX++) {
          const pixelIndexInGap = gapX - gapStartX;
          let newPixelValue = gapStartVal + pixelIndexInGap * addedPerStep;

          if(newPixelValue > 255) { newPixelValue = 255; }
          if(newPixelValue < 0) { newPixelValue = 0; }
          cloudMap.setPixelColor(Jimp.rgbaToInt(newPixelValue, newPixelValue, newPixelValue, 255), gapX, y)
        }

        gapStartX = null;
        gapEndX = null;
        gapStartVal = null;
        gapEndVal = null;
        afterGapCounter = 0;
      }
    }

  });

  const cloudMapRight = cloudMap.clone().crop(0,0, cloudMap.bitmap.width / 2, cloudMap.bitmap.height)
  cloudMap.blit(cloudMap, 0, 0, cloudMap.bitmap.width / 2, 0, cloudMap.bitmap.width / 2, cloudMap.bitmap.height);
  cloudMap.blit(cloudMapRight, cloudMap.bitmap.width / 2, 0);

  // No satellite data at the poles; the top and bottom are mirrored over the gap.
  const cloudMapFlipped = cloudMap.clone().flip(false, true)
  const heightToMirror = cloudMap.bitmap.height / 8
  cloudMap.blit(cloudMapFlipped, 0, 0, 0, cloudMap.bitmap.height - heightToMirror*2, cloudMap.bitmap.width, heightToMirror)
  cloudMap.blit(cloudMapFlipped, 0, cloudMap.bitmap.height - heightToMirror, 0, heightToMirror, cloudMap.bitmap.width, heightToMirror)

  cloudMap
    .composite(frame.resize(cloudMap.bitmap.width, cloudMap.bitmap.height), 0, 0);

  const cloudMapWithAlpha = cloudMap.clone();

  const cloudMapEdges = cloudMap.clone().gaussian(3).brightness(0.5)

  cloudMapWithAlpha.scan(0, 0, cloudMapWithAlpha.bitmap.width, cloudMapWithAlpha.bitmap.height, function(x, y, idx) {
    this.bitmap.data[idx + 3] = this.bitmap.data[idx]

    const edgeValue = cloudMapEdges.bitmap.data[idx]
    const val = multiply(255, edgeValue)

    this.bitmap.data[idx] = val;
    this.bitmap.data[idx + 1] = val;
    this.bitmap.data[idx + 2] = val;
  });

  return cloudMapWithAlpha;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
