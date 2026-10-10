/**
 * Proxy NOAA CO-OPS high/low tide predictions (browser often gets 403 direct).
 * GET /api/noaa-hilo?station=8518750&begin=20260719&end=20260721
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const station = String(req.query.station || "").trim();
  const begin = String(req.query.begin || "").trim();
  const end = String(req.query.end || "").trim();
  if (!/^[A-Za-z0-9]+$/.test(station) || station.length > 16) {
    res.status(400).json({ error: "invalid station" });
    return;
  }
  if (!/^\d{8}$/.test(begin) || !/^\d{8}$/.test(end)) {
    res.status(400).json({ error: "invalid begin/end (YYYYMMDD)" });
    return;
  }

  const params = new URLSearchParams({
    product: "predictions",
    application: "superearth-app",
    begin_date: begin,
    end_date: end,
    datum: "MLLW",
    station,
    time_zone: "gmt",
    units: "english",
    interval: "hilo",
    format: "json",
  });
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params}`;

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: "upstream failed", detail: String(err) });
  }
};
