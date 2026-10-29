/**
 * One of the eight cloud pieces.
 * The phone asks for one piece. The full picture is fetched once per update,
 * and the asked-for square is cut and returned before the other seven.
 * The source is gray plus transparency. Those exact pixels are saved that
 * way. A color picture is kept as color.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const sharp = require("sharp");

const COLS = 4;
const ROWS = 2;
const loading = new Map();
const cutting = new Map();

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeB, data])) >>> 0, 0);
  return Buffer.concat([len, typeB, data, crc]);
}

/** Lossless gray+alpha PNG. Same bytes the color file was storing twice. */
function pngGrayAlpha(la, width, height) {
  const rowBytes = width * 2;
  const raw = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + rowBytes);
    const src = y * rowBytes;
    raw[dst] = 1;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= 2 ? la[src + x - 2] : 0;
      raw[dst + 1 + x] = (la[src + x] - left) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("sRGB", Buffer.from([0])),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sourcePng(stamp) {
  if (loading.has(stamp)) return loading.get(stamp);
  const job = (async () => {
    const file = path.join(os.tmpdir(), `superearth-clouds-${stamp}.png`);
    try {
      if (fs.statSync(file).size > 1000) return fs.readFileSync(file);
    } catch (_) {}
    const upstream = await fetch(
      `https://clouds.matteason.co.uk/images/8192x4096/clouds-alpha.png?t=${stamp}`,
      { headers: { "User-Agent": "SuperEarth" } }
    );
    if (!upstream.ok) throw new Error("cloud photo failed");
    const buf = Buffer.from(await upstream.arrayBuffer());
    const part = file + ".part";
    fs.writeFileSync(part, buf);
    fs.renameSync(part, file);
    return buf;
  })();
  loading.set(stamp, job);
  job.catch(() => loading.delete(stamp));
  return job;
}

function squarePath(stamp, c, r) {
  const dir = path.join(os.tmpdir(), `superearth-cloud-squares-${stamp}`);
  return path.join(dir, `c${c}r${r}-${COLS}x${ROWS}.png`);
}

function squareReady(file) {
  try {
    return fs.statSync(file).size > 1000;
  } catch (_) {
    return false;
  }
}

function cutSquare(stamp, c, r) {
  const file = squarePath(stamp, c, r);
  if (squareReady(file)) return Promise.resolve();
  const key = stamp + ":" + c + ":" + r;
  if (cutting.has(key)) return cutting.get(key);
  const job = (async () => {
    const buf = await sourcePng(stamp);
    const meta = await sharp(buf).metadata();
    const tw = Math.floor(meta.width / COLS);
    const th = Math.floor(meta.height / ROWS);
    const { data, info } = await sharp(buf)
      .extract({ left: c * tw, top: r * th, width: tw, height: th })
      .raw()
      .toBuffer({ resolveWithObject: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const part = file + ".part";
    if (info.channels === 2) {
      fs.writeFileSync(part, pngGrayAlpha(data, info.width, info.height));
    } else if (info.channels === 4) {
      const la = Buffer.alloc(info.width * info.height * 2);
      let colored = false;
      for (let i = 0, j = 0; i < data.length; i += 4, j += 2) {
        if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) colored = true;
        la[j] = data[i];
        la[j + 1] = data[i + 3];
      }
      if (colored) {
        await sharp(data, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .png({ compressionLevel: 6 })
          .toFile(part);
      } else {
        fs.writeFileSync(part, pngGrayAlpha(la, info.width, info.height));
      }
    } else {
      throw new Error("cloud channels");
    }
    fs.renameSync(part, file);
  })();
  cutting.set(key, job);
  const drop = () => {
    if (cutting.get(key) === job) cutting.delete(key);
  };
  job.then(drop, drop);
  return job;
}

module.exports = async function handler(req, res) {
  const c = Number(req.query.c);
  const r = Number(req.query.r);
  const cols = Number(req.query.cols ?? 4);
  const rows = Number(req.query.rows ?? 2);
  const stamp = String(req.query.t || "");
  if (
    !/^\d+$/.test(stamp) ||
    cols !== COLS ||
    rows !== ROWS ||
    !Number.isInteger(c) ||
    !Number.isInteger(r) ||
    c < 0 ||
    r < 0 ||
    c >= COLS ||
    r >= ROWS
  ) {
    res.status(400).end("bad square");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=10800, s-maxage=10800");
  try {
    await cutSquare(stamp, c, r);
    const png = fs.readFileSync(squarePath(stamp, c, r));
    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (_) {
    res.status(502).end("cloud square failed");
  }
};
