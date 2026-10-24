#!/usr/bin/env python3
"""Bake country + state tap data for SuperEarth.

Writes:
  places.json      — name, population, area km², capital, region
  places-polys.bin — quantized lon/lat rings for point-in-polygon

Countries: Natural Earth 110m admin_0
States:    Natural Earth 50m admin_1 (US, CA, AU, BR, IN, ID, CN, RU, ZA)
"""
from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
NE = ROOT / ".texture-src" / "ne"
OUT_JSON = ROOT / "places.json"
OUT_BIN = ROOT / "places-polys.bin"

# lon/lat stored as int16 × 100 → 0.01° (~1 km)
Q = 100


def ring_area_km2(ring):
    if len(ring) < 3:
        return 0.0
    total = 0.0
    n = len(ring)
    for i in range(n):
        lon1, lat1 = ring[i]
        lon2, lat2 = ring[(i + 1) % n]
        total += math.radians(lon2 - lon1) * (
            2.0 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2))
        )
    return abs(total) * 6371.0 * 6371.0 / 2.0


def shape_area_km2(shp):
    pts = shp.points
    parts = list(shp.parts) + [len(pts)]
    area = 0.0
    for a, b in zip(parts, parts[1:]):
        ring = pts[a:b]
        if len(ring) >= 3:
            area += ring_area_km2(ring)
    return area


def shape_rings(shp):
    pts = shp.points
    parts = list(shp.parts) + [len(pts)]
    rings = []
    for a, b in zip(parts, parts[1:]):
        ring = [(float(x), float(y)) for x, y in pts[a:b]]
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def quantize(ring):
    out = []
    for lon, lat in ring:
        qlon = int(round(lon * Q))
        qlat = int(round(lat * Q))
        qlon = max(-18000, min(18000, qlon))
        qlat = max(-9000, min(9000, qlat))
        out.append((qlon, qlat))
    return out


def load_capitals():
    path = NE / "ne_110m_populated_places.shp"
    r = shapefile.Reader(str(path))
    fields = [f[0] for f in r.fields[1:]]
    caps = {}
    for rec in r.iterRecords():
        d = dict(zip(fields, rec))
        if d.get("FEATURECLA") != "Admin-0 capital":
            continue
        a3 = (d.get("ADM0_A3") or "").strip()
        name = (d.get("NAME") or "").strip()
        if a3 and name:
            caps[a3] = name
    return caps


def load_wikidata():
    path = NE / "wikidata-admin1.json"
    if not path.exists():
        return {"pop": {}, "cap": {}, "area": {}}
    return json.loads(path.read_text())


def main():
    caps = load_capitals()
    wd = load_wikidata()
    places = []
    all_rings = []  # parallel to places

    country_reader = shapefile.Reader(str(NE / "ne_110m_admin_0_countries.shp"))
    cf = [f[0] for f in country_reader.fields[1:]]

    for shp, rec in zip(country_reader.iterShapes(), country_reader.iterRecords()):
        d = dict(zip(cf, rec))
        name = (d.get("NAME_EN") or d.get("NAME") or d.get("ADMIN") or "").strip()
        if not name:
            continue
        a3 = (d.get("ADM0_A3") or "").strip()
        pop = d.get("POP_EST")
        try:
            pop = int(float(pop)) if pop not in (None, "") else None
        except (TypeError, ValueError):
            pop = None
        if pop is not None and pop < 0:
            pop = None
        area = shape_area_km2(shp)
        area = round(area) if area >= 1 else None
        places.append(
            {
                "kind": "country",
                "name": name,
                "pop": pop,
                "area": area,
                "capital": caps.get(a3) or None,
                "region": (d.get("CONTINENT") or "").strip() or None,
            }
        )
        all_rings.append(shape_rings(shp))

    n_country = len(places)

    state_reader = shapefile.Reader(str(NE / "ne_50m_admin_1_states_provinces.shp"))
    sf = [f[0] for f in state_reader.fields[1:]]

    for shp, rec in zip(state_reader.iterShapes(), state_reader.iterRecords()):
        d = dict(zip(sf, rec))
        name = (d.get("name_en") or d.get("name") or "").strip()
        if not name:
            continue
        qid = (d.get("wikidataid") or "").strip()
        pop = wd["pop"].get(qid)
        capital = wd["cap"].get(qid)
        area = wd["area"].get(qid)
        if area:
            area = round(float(area))
        else:
            a = shape_area_km2(shp)
            area = round(a) if a >= 1 else None
        admin = (d.get("admin") or "").strip() or None
        if admin == "United States of America":
            admin = "United States"
        places.append(
            {
                "kind": "state",
                "name": name,
                "pop": int(pop) if pop else None,
                "area": area,
                "capital": capital or None,
                "region": admin,
            }
        )
        all_rings.append(shape_rings(shp))

    with OUT_BIN.open("wb") as f:
        f.write(struct.pack("<I", len(places)))
        for rings in all_rings:
            f.write(struct.pack("<I", len(rings)))
            for ring in rings:
                q = quantize(ring)
                f.write(struct.pack("<I", len(q)))
                for lon, lat in q:
                    f.write(struct.pack("<hh", lon, lat))

    OUT_JSON.write_text(
        json.dumps(
            {
                "places": places,
                "q": Q,
                "note": "Natural Earth + Wikidata. Area km². Pop estimates.",
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    npts = sum(len(r) for rings in all_rings for r in rings)
    print(
        f"wrote {OUT_JSON.name}: {len(places)} places "
        f"({n_country} countries, {len(places) - n_country} states)"
    )
    print(f"wrote {OUT_BIN.name}: {npts} points, {OUT_BIN.stat().st_size} bytes")


if __name__ == "__main__":
    main()
