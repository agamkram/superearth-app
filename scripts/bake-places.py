#!/usr/bin/env python3
"""Bake country + state tap data for SuperEarth.

Writes:
  places.json      — name, population, area km², capital, capLat, capLon, region
  places-polys.bin — quantized lon/lat rings for point-in-polygon

Countries: Natural Earth 110m admin_0
States:    Natural Earth 50m admin_1 (US, CA, AU, BR, IN, ID, CN, RU, ZA)
"""
from __future__ import annotations

import json
import math
import struct
import unicodedata
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
NE = ROOT / ".texture-src" / "ne"
OUT_JSON = ROOT / "places.json"
OUT_BIN = ROOT / "places-polys.bin"

# lon/lat stored as int16 × 100 → 0.01° (~1 km)
Q = 100

# States the wikidata file left blank. Cities that are their own capital
# are listed as themselves. Jervis Bay has no capital of its own.
STATE_CAPITALS = {
    ("British Columbia", "Canada"): "Victoria",
    ("New Brunswick", "Canada"): "Fredericton",
    ("Prince Edward Island", "Canada"): "Charlottetown",
    ("Alaska", "United States"): "Juneau",
    ("Washington", "United States"): "Olympia",
    ("Jakarta", "Indonesia"): "Jakarta",
    ("Delhi", "India"): "New Delhi",
    ("Chandigarh", "India"): "Chandigarh",
    ("Moscow", "Russia"): "Moscow",
    ("Saint Petersburg", "Russia"): "Saint Petersburg",
    ("Sevastopol", "Russia"): "Sevastopol",
}


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


COUNTRY_CAPITAL_NAMES = {
    "GRL": "Nuuk",
    "FLK": "Stanley",
    "PRI": "San Juan",
    "NCL": "Nouméa",
    "SSD": "Juba",
    "SAH": "Laayoune",
    "PSX": "East Jerusalem",
    "CYN": "North Nicosia",
}

STATE_CAPITAL_ALIASES = {
    "Yuzhong District": "Chongqing",
    "Tongzhou District": "Beijing",
    "Hexi District": "Tianjin",
    "Huangpu District": "Shanghai",
    "Palangka Raya": "Palangkaraya",
    "Bau-Bau": "Baubau",
    "Srivijayapuram": "Port Blair",
    "Gairsain": "Dehra Dun",
    "Magas": "Nazran",
    "Mahikeng": "Mmabatho",
    "Banjarbaru": "Bandjarmasin",
}

# Not in Natural Earth 10m populated places.
HARDCODED_COORDS = {
    "Mamuju": (-2.6748, 118.8887),
    "Sofifi": (0.7373, 127.5588),
}

COUNTRY_ALIASES = {
    "united states of america": "united states",
    "people s republic of china": "china",
    "the bahamas": "bahamas",
    "the gambia": "gambia",
    "czech republic": "czechia",
    "east timor": "timor leste",
    "swaziland": "eswatini",
}


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    out = []
    for ch in s.lower():
        if ch.isalnum() or ch.isspace():
            out.append(ch)
        else:
            out.append(" ")
    return " ".join("".join(out).split())


def country_key(name):
    k = fold(name)
    return COUNTRY_ALIASES.get(k, k)


def load_place_points():
    path = NE / "ne_10m_populated_places.shp"
    if not path.exists():
        path = NE / "ne_110m_populated_places.shp"
    r = shapefile.Reader(str(path))
    fields = [f[0] for f in r.fields[1:]]
    by_a3 = {}
    by_name = {}
    for rec in r.iterRecords():
        d = dict(zip(fields, rec))
        feat = (d.get("FEATURECLA") or "").strip()
        lat = d.get("LATITUDE")
        lon = d.get("LONGITUDE")
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        names = [
            d.get("NAME"),
            d.get("NAMEASCII"),
            d.get("NAME_EN"),
            d.get("NAMEALT"),
        ]
        extra = []
        for n in names:
            if n and "|" in str(n):
                extra.extend(str(n).split("|"))
        names.extend(extra)
        country = country_key(d.get("ADM0NAME") or d.get("SOV0NAME") or "")
        a3 = (d.get("ADM0_A3") or "").strip()
        rank = 0
        fl = feat.lower()
        if fl == "admin-0 capital":
            rank = 4
        elif "capital" in fl:
            rank = 3
        else:
            rank = 1
        pt = (lat, lon, rank)
        if a3 and rank >= 3:
            prev = by_a3.get(a3)
            if not prev or pt[2] > prev[2]:
                by_a3[a3] = pt
        for n in names:
            k = fold(n)
            if not k or not country:
                continue
            key = (k, country)
            prev = by_name.get(key)
            if not prev or pt[2] > prev[2]:
                by_name[key] = pt
    return by_a3, by_name


def load_capitals(by_a3, by_name):
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
    for a3, name in COUNTRY_CAPITAL_NAMES.items():
        caps.setdefault(a3, name)
    return caps


def capital_point(name, country, a3, by_a3, by_name):
    names = [name]
    alias = STATE_CAPITAL_ALIASES.get(name)
    if alias:
        names.append(alias)
    ck = country_key(country)
    for n in names:
        k = fold(n)
        if k and ck:
            hit = by_name.get((k, ck))
            if hit:
                return round(hit[0], 4), round(hit[1], 4)
    if name in HARDCODED_COORDS:
        lat, lon = HARDCODED_COORDS[name]
        return lat, lon
    if a3 and a3 in by_a3:
        lat, lon, _ = by_a3[a3]
        return round(lat, 4), round(lon, 4)
    return None, None


def load_wikidata():
    path = NE / "wikidata-admin1.json"
    if not path.exists():
        return {"pop": {}, "cap": {}, "area": {}}
    return json.loads(path.read_text())


def main():
    by_a3, by_name = load_place_points()
    caps = load_capitals(by_a3, by_name)
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
        capital = caps.get(a3) or None
        cap_lat, cap_lon = capital_point(
            capital, d.get("ADMIN") or d.get("NAME") or name, a3, by_a3, by_name
        )
        places.append(
            {
                "kind": "country",
                "name": name,
                "pop": pop,
                "area": area,
                "capital": capital,
                "capLat": cap_lat,
                "capLon": cap_lon,
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
        if not capital:
            capital = STATE_CAPITALS.get((name, admin))
        cap_lat, cap_lon = capital_point(capital, admin, None, by_a3, by_name)
        places.append(
            {
                "kind": "state",
                "name": name,
                "pop": int(pop) if pop else None,
                "area": area,
                "capital": capital or None,
                "capLat": cap_lat,
                "capLon": cap_lon,
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
