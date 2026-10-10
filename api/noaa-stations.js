/**
 * Proxy NOAA tide-prediction station list (slim coastal reference set).
 * GET /api/noaa-stations
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const INLAND =
    /\b(creek|bayou|slough|plantation|drawbridge|highway bridge|railroad bridge|mi\.?\s*above|miles?\s+above|above\s+(entrance|mouth)|ferry landing)\b/i;

  try {
    const upstream = await fetch(
      "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions",
      { headers: { Accept: "application/json" } }
    );
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "stations upstream failed" });
      return;
    }
    const data = await upstream.json();
    const list = (data.stations || [])
      .filter(
        (s) =>
          s &&
          s.id &&
          s.type === "R" &&
          Number.isFinite(Number(s.lat)) &&
          Number.isFinite(Number(s.lng)) &&
          !INLAND.test(String(s.name || ""))
      )
      .map((s) => ({
        id: String(s.id),
        lat: Number(s.lat),
        lng: Number(s.lng),
        name: String(s.name || s.id),
        state: s.state ? String(s.state).trim() : "",
      }));

    res.status(200).json({ stations: list, count: list.length });
  } catch (err) {
    res.status(502).json({ error: "upstream failed", detail: String(err) });
  }
};
