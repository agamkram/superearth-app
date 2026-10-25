#!/usr/bin/env python3
"""Bake Natural Earth 10m rivers into SuperEarth's lon/lat line bin.

Same layout as borders-50m.bin:
  uint32 nLines
  for each line:
    uint32 nPoints
    nPoints × (float32 lon, float32 lat)

Skips lake centerlines so Superior and Baikal do not get a stripe.
"""
from __future__ import annotations

import math
import struct
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
NE = ROOT / ".texture-src" / "ne"
SRCS = [
    NE / "ne_10m_rivers_lake_centerlines.shp",
    NE / "ne_10m_rivers_north_america.shp",
    NE / "ne_10m_rivers_europe.shp",
]
OUT = ROOT / "rivers-10m.bin"
MAX_EDGE_DEG = 1.0


def xyz(lon, lat):
    lon = math.radians(lon)
    lat = math.radians(lat)
    cl = math.cos(lat)
    return (cl * math.cos(lon), math.sin(lat), -cl * math.sin(lon))


def lonlat_from_xyz(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    x, y, z = v[0] / n, v[1] / n, v[2] / n
    lat = math.degrees(math.asin(max(-1.0, min(1.0, y))))
    lon = math.degrees(math.atan2(-z, x))
    return (lon, lat)


def ang_deg(a, b):
    ax, ay, az = xyz(*a)
    bx, by, bz = xyz(*b)
    d = max(-1.0, min(1.0, ax * bx + ay * by + az * bz))
    return math.degrees(math.acos(d))


def densify(line):
    if len(line) < 2:
        return line
    out = [line[0]]
    for pt in line[1:]:
        prev = out[-1]
        span = ang_deg(prev, pt)
        if span <= MAX_EDGE_DEG:
            out.append(pt)
            continue
        steps = max(2, int(math.ceil(span / MAX_EDGE_DEG)))
        ax, ay, az = xyz(*prev)
        bx, by, bz = xyz(*pt)
        for i in range(1, steps):
            t = i / steps
            out.append(lonlat_from_xyz((ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t)))
        out.append(pt)
    return out


def is_centerline(featurecla):
    s = (featurecla or "").lower()
    return "centerline" in s or s == "lake centerline"


def polylines(shp_path):
    r = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in r.fields[1:]]
    lines = []
    skipped = 0
    for shp, rec in zip(r.iterShapes(), r.iterRecords()):
        d = dict(zip(fields, rec))
        if is_centerline(d.get("featurecla")):
            skipped += 1
            continue
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for a, b in zip(parts, parts[1:]):
            ring = [(float(x), float(y)) for x, y in pts[a:b]]
            if len(ring) >= 2:
                lines.append(densify(ring))
    return lines, skipped


def write_bin(path, lines):
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(lines)))
        for line in lines:
            f.write(struct.pack("<I", len(line)))
            for lon, lat in line:
                f.write(struct.pack("<ff", lon, lat))


def main():
    all_lines = []
    for src in SRCS:
        if not src.exists():
            raise SystemExit(f"missing {src}")
        lines, skipped = polylines(src)
        all_lines.extend(lines)
        print(f"{src.name}: {len(lines)} river lines, skipped {skipped} centerlines")
    write_bin(OUT, all_lines)
    npts = sum(len(x) for x in all_lines)
    print(
        f"wrote {OUT.name}: {len(all_lines)} lines, {npts} points, "
        f"{OUT.stat().st_size} bytes"
    )


if __name__ == "__main__":
    main()
