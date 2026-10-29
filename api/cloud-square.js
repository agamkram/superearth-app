/**
 * A finished cloud square. This does not cut a photograph.
 * The scheduled job publishes the set. A request only fetches that set.
 */
const READY = "https://raw.githubusercontent.com/agamkram/superearth-app/cloud-tiles/ready.json";

module.exports = async function handler(req, res) {
  const c = Number(req.query.c);
  const r = Number(req.query.r);
  if (![0, 1, 2, 3].includes(c) || ![0, 1].includes(r)) {
    res.status(400).end("bad square");
    return;
  }
  try {
    const readyRes = await fetch(READY + "?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" });
    if (!readyRes.ok) throw new Error("ready");
    const info = await readyRes.json();
    if (!/^\d+$/.test(String(info.stamp || "")) || !/^[0-9a-f]{40}$/.test(String(info.sha || ""))) {
      throw new Error("ready");
    }
    const file = `https://cdn.jsdelivr.net/gh/agamkram/superearth-app@${info.sha}/${info.stamp}-c${c}r${r}.png`;
    const upstream = await fetch(file);
    if (!upstream.ok) throw new Error("file");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).send(buf);
  } catch (_) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).end("not ready");
  }
};
