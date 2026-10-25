#!/usr/bin/env python3
"""Bake Natural Earth 10m geographic lines for SuperEarth.

  uint32 nLines
  for each line:
    uint32 nPoints
    nPoints × (float32 lon, float32 lat)

Equator, tropics, polar circles. Skips the date line.
"""
from __future__ import annotations

import math
import struct
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / ".texture-src" / "ne" / "ne_10m_geographic_lines.shp"
OUT = ROOT / "geo-lines-10m.bin"
MAX_EDGE_DEG = 1.0


def xyz(lon, lat):
    lon = math.radians(lon)
    lat = math.radians(lat)
    cl = math.cos(lat)
    return (cl * math.cos(lon), math.sin(lat), -cl * math.sin(lon))


def lonlat_from_xyz(v):
    n = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1.0
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
            out.append(
                lonlat_from_xyz(
                    (ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t)
                )
            )
        out.append(pt)
    return out


def polylines(shp_path):
    r = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in r.fields[1:]]
    lines = []
    names = []
    for shp, rec in zip(r.iterShapes(), r.iterRecords()):
        d = dict(zip(fields, rec))
        name = str(d.get("name") or d.get("NAME") or "")
        if "date line" in name.lower():
            continue
        names.append(name)
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for a, b in zip(parts, parts[1:]):
            ring = [(float(x), float(y)) for x, y in pts[a:b]]
            if len(ring) >= 2:
                lines.append(densify(ring))
    return lines, names


def write_bin(path, lines):
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(lines)))
        for line in lines:
            f.write(struct.pack("<I", len(line)))
            for lon, lat in line:
                f.write(struct.pack("<ff", lon, lat))


def main():
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}")
    lines, names = polylines(SRC)
    write_bin(OUT, lines)
    npts = sum(len(x) for x in lines)
    print("names:", ", ".join(n for n in names if n))
    print(
        f"wrote {OUT.name}: {len(lines)} lines, {npts} points, "
        f"{OUT.stat().st_size} bytes"
    )


if __name__ == "__main__":
    main()
