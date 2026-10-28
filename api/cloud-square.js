/**
 * One square of the sharp live cloud photo.
 * The phone asks for the squares it can see. This cuts them from the full
 * picture so the phone never unpacks that picture itself.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const loading = new Map();

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

const GRIDS = new Set(["4x2", "8x4", "16x8"]);

async function oneSquare(stamp, c, r, cols, rows) {
  const dir = path.join(os.tmpdir(), `superearth-cloud-squares-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `c${c}r${r}-${cols}x${rows}.png`);
  try {
    if (fs.statSync(file).size > 1000) return fs.readFileSync(file);
  } catch (_) {}
  const buf = await sourcePng(stamp);
  const meta = await sharp(buf).metadata();
  const tw = Math.floor(meta.width / cols);
  const th = Math.floor(meta.height / rows);
  const png = await sharp(buf)
    .extract({ left: c * tw, top: r * th, width: tw, height: th })
    .png({ compressionLevel: 1 })
    .toBuffer();
  fs.writeFileSync(file, png);
  return png;
}

module.exports = async function handler(req, res) {
  const c = Number(req.query.c);
  const r = Number(req.query.r);
  const cols = Number(req.query.cols ?? 4);
  const rows = Number(req.query.rows ?? 2);
  const stamp = String(req.query.t || "");
  const grid = `${cols}x${rows}`;
  if (
    !/^\d+$/.test(stamp) ||
    !GRIDS.has(grid) ||
    !Number.isInteger(c) ||
    !Number.isInteger(r) ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    c < 0 ||
    r < 0 ||
    c >= cols ||
    r >= rows
  ) {
    res.status(400).end("bad square");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=10800, s-maxage=10800");
  try {
    const png = await oneSquare(stamp, c, r, cols, rows);
    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (_) {
    res.status(502).end("cloud square failed");
  }
};
