#!/usr/bin/env python3
"""Bake Natural Earth 10m rivers into SuperEarth's ranked line bin.

  4 bytes magic RV10
  uint32 nLines
  for each line:
    uint8 scalerank (1=giant .. 12=creek)
    3 pad bytes
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
# Join same-rank pieces whose tips sit within ~2 km so one river is not a dashed chain.
MAX_JOIN_DEG = 0.02


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
        sr = d.get("scalerank")
        try:
            sr = int(round(float(sr)))
        except (TypeError, ValueError):
            sr = 8
        sr = max(1, min(12, sr))
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for a, b in zip(parts, parts[1:]):
            ring = [(float(x), float(y)) for x, y in pts[a:b]]
            if len(ring) >= 2:
                lines.append((densify(ring), sr))
    return lines, skipped


def stitch_same_rank(lines):
    """Tip-to-tip join of same-rank pieces. Does not glue tributaries into a mid-river T."""
    from collections import defaultdict

    n = len(lines)
    if n < 2:
        return lines
    pts = [list(p) for p, _sr in lines]
    srs = [sr for _p, sr in lines]
    inv = 1.0 / MAX_JOIN_DEG
    thresh2 = MAX_JOIN_DEG * MAX_JOIN_DEG

    def coord(e):
        i, k = divmod(e, 2)
        return pts[i][0] if k == 0 else pts[i][-1]

    buckets = defaultdict(list)
    for e in range(n * 2):
        lon, lat = coord(e)
        buckets[(int(math.floor(lon * inv)), int(math.floor(lat * inv)))].append(e)

    def nearest(e):
        lon, lat = coord(e)
        i = e // 2
        sr = srs[i]
        best = None
        bx, by = int(math.floor(lon * inv)), int(math.floor(lat * inv))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for f in buckets.get((bx + dx, by + dy), []):
                    j = f // 2
                    if j == i or srs[j] != sr:
                        continue
                    flon, flat = coord(f)
                    d2 = (flon - lon) ** 2 + (flat - lat) ** 2
                    if d2 <= thresh2 and (best is None or d2 < best[0]):
                        best = (d2, f)
        return None if best is None else best[1]

    partner = [nearest(e) for e in range(n * 2)]
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    link = defaultdict(list)
    seen = set()
    for e in range(n * 2):
        f = partner[e]
        if f is None or partner[f] != e:
            continue
        a, b = (e, f) if e < f else (f, e)
        if (a, b) in seen:
            continue
        seen.add((a, b))
        i, j = e // 2, f // 2
        if find(i) == find(j):
            continue
        parent[find(j)] = find(i)
        link[i].append((e % 2, j, f % 2))
        link[j].append((f % 2, i, e % 2))

    used = [False] * n
    out = []
    for start in range(n):
        if used[start]:
            continue
        stack = [start]
        comp = []
        seen_l = set()
        while stack:
            i = stack.pop()
            if i in seen_l:
                continue
            seen_l.add(i)
            comp.append(i)
            for _le, o, _oe in link[i]:
                stack.append(o)
        heads = [i for i in comp if len(link[i]) <= 1]
        head = heads[0] if heads else comp[0]
        start_end = 0
        if len(link[head]) == 1:
            start_end = 1 - link[head][0][0]
        seq = []
        cur, enter_end = head, start_end
        visited = set()
        while cur is not None and cur not in visited:
            seq.append((cur, enter_end == 1))
            visited.add(cur)
            exit_end = 1 - enter_end
            nxt = None
            for le, ol, oe in link[cur]:
                if le == exit_end and ol not in visited:
                    nxt = (ol, oe)
                    break
            cur, enter_end = nxt if nxt else (None, 0)
        acc = []
        acc_sr = srs[head]
        for li, rev in seq:
            used[li] = True
            p = pts[li][::-1] if rev else pts[li]
            acc.extend(p)
        out.append((acc, acc_sr))
        for i in comp:
            if used[i]:
                continue
            used[i] = True
            out.append((pts[i], srs[i]))
    return out


def write_bin(path, lines):
    with open(path, "wb") as f:
        f.write(b"RV10")
        f.write(struct.pack("<I", len(lines)))
        for line, sr in lines:
            f.write(struct.pack("<BxxxI", sr, len(line)))
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
    before = len(all_lines)
    all_lines = stitch_same_rank(all_lines)
    print(f"stitched same-rank tips: {before} -> {len(all_lines)} lines")
    write_bin(OUT, all_lines)
    npts = sum(len(x[0]) for x in all_lines)
    mx = max((len(x[0]) for x in all_lines), default=0)
    print(
        f"wrote {OUT.name}: {len(all_lines)} lines, {npts} points, "
        f"longest {mx}, {OUT.stat().st_size} bytes"
    )


if __name__ == "__main__":
    main()
