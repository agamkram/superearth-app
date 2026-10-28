#!/usr/bin/env python3
"""Bake Natural Earth 10m coast and borders for SuperEarth.

uint32 nLines
for each line:
  uint32 nPoints
  nPoints × (float32 lon, float32 lat)

Country + coast: ne_10m_coastline + ne_10m_admin_0_boundary_lines_land
  → borders-10m.bin
US states: ne_10m_admin_1_states_provinces_lines where ADM0_A3 is USA
  → states-us-10m.bin
Other states: the rest of that file
  → states-other-10m.bin

Edges longer than 1° are filled in so a line stays on the globe.
"""
from __future__ import annotations

import math
import struct
import sys
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
NE = ROOT / ".texture-src" / "ne"
COAST = NE / "ne_10m_coastline.shp"
LAND = NE / "ne_10m_admin_0_boundary_lines_land.shp"
STATES = NE / "ne_10m_admin_1_states_provinces_lines.shp"
OUT_BORDERS = ROOT / "borders-10m.bin"
OUT_US_STATES = ROOT / "states-us-10m.bin"
OUT_OTHER_STATES = ROOT / "states-other-10m.bin"
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
        # Date line jumps stay as jumps. The loader drops that one segment.
        if abs(pt[0] - prev[0]) >= 180:
            out.append(pt)
            continue
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


def polylines(shp_path, country=None):
    r = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in r.fields[1:]]
    code_i = fields.index("ADM0_A3") if "ADM0_A3" in fields else None
    lines = []
    for shp, rec in zip(r.iterShapes(), r.iterRecords()):
        if country is not None:
            code = rec[code_i] if code_i is not None else ""
            is_us = code == "USA"
            if country == "USA" and not is_us:
                continue
            if country == "other" and is_us:
                continue
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for a, b in zip(parts, parts[1:]):
            ring = [(float(x), float(y)) for x, y in pts[a:b]]
            if len(ring) >= 2:
                lines.append(densify(ring))
    return lines


def write_bin(path, lines):
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(lines)))
        for line in lines:
            f.write(struct.pack("<I", len(line)))
            for lon, lat in line:
                f.write(struct.pack("<ff", lon, lat))


def bake(src_list, out, country=None):
    lines = []
    for src in src_list:
        if not src.exists():
            sys.stderr.write(f"missing {src}\n")
            sys.exit(1)
        part = polylines(src, country)
        print(f"{src.name}: {len(part)} lines, {sum(len(x) for x in part)} points")
        lines.extend(part)
    write_bin(out, lines)
    npts = sum(len(x) for x in lines)
    print(f"wrote {out.name}: {len(lines)} lines, {npts} points, {out.stat().st_size} bytes")


def main():
    bake([COAST, LAND], OUT_BORDERS)
    bake([STATES], OUT_US_STATES, "USA")
    bake([STATES], OUT_OTHER_STATES, "other")


if __name__ == "__main__":
    main()
