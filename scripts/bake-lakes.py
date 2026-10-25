#!/usr/bin/env python3
"""Bake Natural Earth lakes plus a few missing coastal lakes for SuperEarth.

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
NE = ROOT / ".texture-src" / "ne"
# Regional files first so extra detail wins if the same water appears twice.
SRCS = [
    NE / "ne_10m_lakes_north_america.shp",
    NE / "ne_10m_lakes_europe.shp",
    NE / "ne_10m_lakes.shp",
]
EXTRA = Path(__file__).with_name("extra-lakes.json")
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


def bbox_of_rings(rings):
    xs = [p[0] for ring in rings for p in ring]
    ys = [p[1] for ring in rings for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    aa = (a[2] - a[0]) * (a[3] - a[1])
    ba = (b[2] - b[0]) * (b[3] - b[1])
    return inter / max(aa + ba - inter, 1e-18)


def already_have(bb, kept):
    return any(iou(bb, other) > 0.65 for other in kept)


def add_rings(rings, all_verts, all_idx, base):
    if not rings:
        return base, False
    verts, idx = triangulate(rings)
    if verts is None:
        ok = False
        for ring in rings:
            verts, idx = triangulate([ring])
            if verts is None:
                continue
            all_verts.append(verts)
            all_idx.append(idx + base)
            base += len(verts)
            ok = True
        return base, ok
    all_verts.append(verts)
    all_idx.append(idx + base)
    return base + len(verts), True


def main():
    all_verts = []
    all_idx = []
    base = 0
    used = 0
    skipped = 0
    duped = 0
    kept = []
    from_src = {}
    for src in SRCS:
        if not src.exists():
            raise SystemExit(f"missing {src}")
        n_here = 0
        r = shapefile.Reader(str(src))
        for shp in r.iterShapes():
            rings = rings_of(shp)
            if not rings:
                skipped += 1
                continue
            bb = bbox_of_rings(rings)
            if already_have(bb, kept):
                duped += 1
                continue
            base, ok = add_rings(rings, all_verts, all_idx, base)
            if ok:
                used += 1
                n_here += 1
                kept.append(bb)
            else:
                skipped += 1
        from_src[src.name] = n_here

    extra_n = 0
    if EXTRA.exists():
        import json
        extra = json.loads(EXTRA.read_text())
        for lake in extra:
            for rings in lake.get("rings") or []:
                if not rings:
                    skipped += 1
                    continue
                bb = bbox_of_rings(rings)
                if already_have(bb, kept):
                    duped += 1
                    continue
                base, ok = add_rings(rings, all_verts, all_idx, base)
                if ok:
                    used += 1
                    extra_n += 1
                    kept.append(bb)
                else:
                    skipped += 1
    from_src[EXTRA.name] = extra_n

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
        f"wrote {OUT.name}: {used} lakes, skipped {skipped}, dup {duped}, "
        f"{len(verts)} verts, {len(idx) // 3} tris, {OUT.stat().st_size} bytes"
    )
    for k, v in from_src.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
