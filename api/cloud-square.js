/**
 * One of the eight cloud pieces.
 * The phone asks for the piece it can see. The full picture is unpacked
 * once per update, cut into eight, and then each piece is a file.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const COLS = 4;
const ROWS = 2;
const loading = new Map();
const ready = new Map();

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
    fs.writeFileSync(file, buf);
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

function cutAll(stamp) {
  if (ready.has(stamp)) return ready.get(stamp);
  const job = (async () => {
    const dir = path.join(os.tmpdir(), `superearth-cloud-squares-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const missing = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const file = squarePath(stamp, c, r);
        if (!squareReady(file)) missing.push([c, r, file]);
      }
    }
    if (!missing.length) return;
    const buf = await sourcePng(stamp);
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tw = Math.floor(info.width / COLS);
    const th = Math.floor(info.height / ROWS);
    const raw = {
      width: info.width,
      height: info.height,
      channels: info.channels,
    };
    for (const [c, r, file] of missing) {
      const png = await sharp(data, { raw })
        .extract({ left: c * tw, top: r * th, width: tw, height: th })
        .png({ compressionLevel: 1 })
        .toBuffer();
      fs.writeFileSync(file, png);
    }
  })();
  ready.set(stamp, job);
  job.catch(() => ready.delete(stamp));
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
    await cutAll(stamp);
    const png = fs.readFileSync(squarePath(stamp, c, r));
    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (_) {
    res.status(502).end("cloud square failed");
  }
};
