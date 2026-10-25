#!/usr/bin/env python3
"""Bake Natural Earth 10m lakes into a triangle mesh for SuperEarth.

Writes lakes-10m.bin:
  4 bytes magic LK10
  uint32 vertCount
  vertCount × (float32 lon, float32 lat)
  uint32 indexCount
  indexCount × uint32 (triangles)
"""
from __future__ import annotations

import math
import struct
from pathlib import Path

import numpy as np
import shapefile
from mapbox_earcut import triangulate_float32

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / ".texture-src" / "ne" / "ne_10m_lakes.shp"
OUT = ROOT / "lakes-10m.bin"
MAGIC = b"LK10"


def rings_of(shp):
    pts = shp.points
    parts = list(shp.parts) + [len(pts)]
    rings = []
    for a, b in zip(parts, parts[1:]):
        ring = [(float(x), float(y)) for x, y in pts[a:b]]
        if len(ring) >= 2 and ring[0] == ring[-1]:
            ring = ring[:-1]
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def triangulate(rings):
    if not rings:
        return None, None
    verts = []
    ends = []
    for ring in rings:
        verts.extend(ring)
        ends.append(len(verts))
    arr = np.asarray(verts, dtype=np.float32)
    holes = np.asarray(ends, dtype=np.uint32)
    try:
        idx = triangulate_float32(arr, holes)
    except Exception:
        return None, None
    if idx is None or len(idx) < 3:
        return None, None
    return arr, np.asarray(idx, dtype=np.uint32)


# Tiles sit at radius 1.0022, lakes at 1.0024. A triangle wider than ~2.3°
# dips through the photo in the middle. Keep edges under 1°.
MAX_EDGE_DEG = 1.0


def _xyz(lonlat):
    lon = np.radians(lonlat[:, 0])
    lat = np.radians(lonlat[:, 1])
    cl = np.cos(lat)
    return np.stack([cl * np.cos(lon), np.sin(lat), -cl * np.sin(lon)], axis=1)


def _lonlat_from_xyz(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    x, y, z = v[0] / n, v[1] / n, v[2] / n
    lat = math.degrees(math.asin(max(-1.0, min(1.0, y))))
    lon = math.degrees(math.atan2(-z, x))
    return (lon, lat)


def refine(verts, idx):
    """Split long edges so lake faces follow the globe instead of cutting through it."""
    verts = [ (float(p[0]), float(p[1])) for p in verts ]
    xyz = _xyz(np.asarray(verts, dtype=np.float64)).tolist()
    mid = {}
    out = []
    queue = [tuple(int(i) for i in t) for t in np.asarray(idx, dtype=np.uint32).reshape(-1, 3)]

    def ang(i, j):
        a, b = xyz[i], xyz[j]
        d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        d = max(-1.0, min(1.0, d))
        return math.degrees(math.acos(d))

    def midpoint(i, j):
        key = (i, j) if i < j else (j, i)
        hit = mid.get(key)
        if hit is not None:
            return hit
        a, b = xyz[i], xyz[j]
        m = (a[0] + b[0], a[1] + b[1], a[2] + b[2])
        ll = _lonlat_from_xyz(m)
        n = len(verts)
        verts.append(ll)
        xyz.append(_xyz(np.asarray([ll], dtype=np.float64))[0].tolist())
        mid[key] = n
        return n

    while queue:
        a, b, c = queue.pop()
        eab, ebc, eca = ang(a, b), ang(b, c), ang(c, a)
        longest = max(eab, ebc, eca)
        if longest <= MAX_EDGE_DEG:
            out.append((a, b, c))
            continue
        if longest == eab:
            m = midpoint(a, b)
            queue.append((a, m, c))
            queue.append((m, b, c))
        elif longest == ebc:
            m = midpoint(b, c)
            queue.append((a, b, m))
            queue.append((a, m, c))
        else:
            m = midpoint(c, a)
            queue.append((a, b, m))
            queue.append((b, c, m))

    return np.asarray(verts, dtype=np.float32), np.asarray(out, dtype=np.uint32).reshape(-1)


def main():
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}")
    r = shapefile.Reader(str(SRC))
    all_verts = []
    all_idx = []
    base = 0
    used = 0
    skipped = 0
    for shp in r.iterShapes():
        rings = rings_of(shp)
        if not rings:
            skipped += 1
            continue
        verts, idx = triangulate(rings)
        if verts is None:
            # Some records are several outer rings. Try each ring alone.
            ok = False
            for ring in rings:
                verts, idx = triangulate([ring])
                if verts is None:
                    continue
                all_verts.append(verts)
                all_idx.append(idx + base)
                base += len(verts)
                ok = True
            if ok:
                used += 1
            else:
                skipped += 1
            continue
        all_verts.append(verts)
        all_idx.append(idx + base)
        base += len(verts)
        used += 1

    if not all_verts:
        raise SystemExit("no lakes triangulated")
    verts = np.concatenate(all_verts, axis=0)
    idx = np.concatenate(all_idx, axis=0)
    verts, idx = refine(verts, idx)
    with OUT.open("wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<I", len(verts)))
        f.write(np.ascontiguousarray(verts, dtype=np.float32).tobytes())
        f.write(struct.pack("<I", len(idx)))
        f.write(np.ascontiguousarray(idx, dtype=np.uint32).tobytes())
    print(
        f"wrote {OUT.name}: {used} lakes, skipped {skipped}, "
        f"{len(verts)} verts, {len(idx) // 3} tris, {OUT.stat().st_size} bytes"
    )


if __name__ == "__main__":
    main()
