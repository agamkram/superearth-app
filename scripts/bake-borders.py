#!/usr/bin/env python3
"""Bake Natural Earth 50m polylines into SuperEarth's lon/lat bin.

uint32 nLines
for each line:
  uint32 nPoints
  nPoints × (float32 lon, float32 lat)

Country+coast: ne_50m_admin_0_boundary_lines_land + ne_50m_coastline
  (existing borders-50m.bin — this script only (re)bakes states).

States: ne_50m_admin_1_states_provinces_lines
"""
import struct
import sys
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "states-50m.bin"


def polylines(shp_path):
    r = shapefile.Reader(str(shp_path))
    lines = []
    for shp in r.iterShapes():
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for a, b in zip(parts, parts[1:]):
            ring = pts[a:b]
            if len(ring) >= 2:
                lines.append([(float(x), float(y)) for x, y in ring])
    return lines


def write_bin(path, lines):
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(lines)))
        for line in lines:
            f.write(struct.pack("<I", len(line)))
            for lon, lat in line:
                f.write(struct.pack("<ff", lon, lat))


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        "/tmp/ne-states/ne_50m_admin_1_states_provinces_lines.shp"
    )
    if not src.exists():
        sys.stderr.write(f"missing {src}\n")
        sys.exit(1)
    lines = polylines(src)
    write_bin(OUT, lines)
    npts = sum(len(x) for x in lines)
    print(f"wrote {OUT.name}: {len(lines)} lines, {npts} points, {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
