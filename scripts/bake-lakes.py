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
