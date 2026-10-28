#!/usr/bin/env python3
"""Split rivers so the phone only keeps the water it can see.

rivers-big.bin   rivers at or above 1000 m3/s, the whole Earth
rivers-mid/      10–1000 m3/s, eight by four squares (same grid as tiles-16)

The same rivers show at every zoom. There is no closer set.
rivers-10m.bin holds the rivers from 20 up. Rivers from 10 to 20 are read
from HydroRIVERS and clipped on the same lakes.

A reach that crosses a square is cut on the square edge so the pieces meet.
A reach that crosses a lake stops at the shore. The same lakes the globe draws.
"""
from __future__ import annotations

import json
import math
import struct
import time
from pathlib import Path

import numpy as np
import shapefile
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC_BIN = ROOT / "rivers-10m.bin"
BIG_OUT = ROOT / "rivers-big.bin"
MID_DIR = ROOT / "rivers-mid"
# rivers-10m.bin starts at 20. Every zoom shows rivers from 10 up.
BIN_FLOW = 20.0
OPENING_FLOW = 10.0

HEAD = struct.Struct("<BxxxI")
PT = struct.Struct("<ff")


def regions():
    roots = sorted(Path("/tmp/hrx").glob("HydroRIVERS_v10_*_shp"))
    au = Path("/tmp/HydroRIVERS_v10_au_shp")
    if au.is_dir():
        roots.append(au)
    return roots


def cell_of(u, v, du, dv, dlon, dlat, cols, rows):
    """Cell containing (u, v). On a grid line, keep the cell we are entering."""
    c = int(math.floor(u / dlon))
    r = int(math.floor(v / dlat))
    if du < 0 and abs(u - c * dlon) <= 1e-7 and c > 0:
        c -= 1
    if dv < 0 and abs(v - r * dlat) <= 1e-7 and r > 0:
        r -= 1
    if c < 0:
        c = 0
    elif c >= cols:
        c = cols - 1
    if r < 0:
        r = 0
    elif r >= rows:
        r = rows - 1
    return c, r


def clip_segment(u0, v0, u1, v1, dlon, dlat, cols, rows):
    """Grid-walk one segment. Returns pieces as (c, r, u0, v0, u1, v1)."""
    du = u1 - u0
    dv = v1 - v0
    c, r = cell_of(u0, v0, du, dv, dlon, dlat, cols, rows)
    c1, r1 = cell_of(u1, v1, du, dv, dlon, dlat, cols, rows)
    if c == c1 and r == r1:
        return [(c, r, u0, v0, u1, v1)]

    step_c = 1 if du > 0 else (-1 if du < 0 else 0)
    step_r = 1 if dv > 0 else (-1 if dv < 0 else 0)
    if step_c > 0:
        t_max_c = ((c + 1) * dlon - u0) / du
        t_delta_c = dlon / du
    elif step_c < 0:
        t_max_c = (c * dlon - u0) / du
        t_delta_c = -dlon / du
    else:
        t_max_c = math.inf
        t_delta_c = math.inf
    if step_r > 0:
        t_max_r = ((r + 1) * dlat - v0) / dv
        t_delta_r = dlat / dv
    elif step_r < 0:
        t_max_r = (r * dlat - v0) / dv
        t_delta_r = -dlat / dv
    else:
        t_max_r = math.inf
        t_delta_r = math.inf

    out = []
    cu, cv = u0, v0
    guard = cols + rows + 8
    while guard > 0 and not (c == c1 and r == r1):
        guard -= 1
        if t_max_c < t_max_r:
            t = t_max_c
            if t > 1:
                break
            nu = u0 + t * du
            nv = v0 + t * dv
            out.append((c, r, cu, cv, nu, nv))
            cu, cv = nu, nv
            c += step_c
            if c < 0 or c >= cols:
                break
            t_max_c += t_delta_c
        elif t_max_r < t_max_c:
            t = t_max_r
            if t > 1:
                break
            nu = u0 + t * du
            nv = v0 + t * dv
            out.append((c, r, cu, cv, nu, nv))
            cu, cv = nu, nv
            r += step_r
            if r < 0 or r >= rows:
                break
            t_max_r += t_delta_r
        else:
            t = t_max_c
            if t > 1:
                break
            nu = u0 + t * du
            nv = v0 + t * dv
            out.append((c, r, cu, cv, nu, nv))
            cu, cv = nu, nv
            c += step_c
            r += step_r
            if c < 0 or c >= cols or r < 0 or r >= rows:
                break
            t_max_c += t_delta_c
            t_max_r += t_delta_r
    if c == c1 and r == r1:
        out.append((c, r, cu, cv, u1, v1))
    elif not out:
        out.append((c, r, u0, v0, u1, v1))
    return out


def pack_line(rank, coords):
    n = len(coords)
    buf = bytearray(8 + n * 8)
    HEAD.pack_into(buf, 0, rank, n)
    o = 8
    for lon, lat in coords:
        PT.pack_into(buf, o, lon, lat)
        o += 8
    return buf


class Squares:
    def __init__(self, folder, cols, rows):
        self.folder = folder
        self.cols = cols
        self.rows = rows
        self.dlon = 360.0 / cols
        self.dlat = 180.0 / rows
        self.bins = {}
        self.counts = {}
        self.lines = 0
        self.points = 0

    def add(self, c, r, rank, coords):
        if len(coords) < 2 or c < 0 or r < 0 or c >= self.cols or r >= self.rows:
            return
        key = (c, r)
        buf = self.bins.get(key)
        if buf is None:
            buf = bytearray()
            self.bins[key] = buf
            self.counts[key] = 0
        buf += pack_line(rank, coords)
        self.counts[key] += 1
        self.lines += 1
        self.points += len(coords)

    def add_clipped(self, coords, rank):
        """Cut one lon/lat polyline into the squares it crosses."""
        if len(coords) < 2:
            return
        part = [coords[0]]
        parts = []
        for lon, lat in coords[1:]:
            prev = part[-1][0]
            if abs(lon - prev) >= 180:
                if len(part) >= 2:
                    parts.append(part)
                part = [(lon, lat)]
            else:
                part.append((lon, lat))
        if len(part) >= 2:
            parts.append(part)

        dlon, dlat = self.dlon, self.dlat
        cols, rows = self.cols, self.rows
        for line in parts:
            current = None
            poly = []

            def flush():
                if current is not None and len(poly) >= 2:
                    self.add(current[0], current[1], rank, poly)

            for i in range(len(line) - 1):
                lon0, lat0 = line[i]
                lon1, lat1 = line[i + 1]
                u0 = lon0 + 180.0
                v0 = 90.0 - lat0
                u1 = lon1 + 180.0
                v1 = 90.0 - lat1
                if u0 < 0:
                    u0 = 0.0
                elif u0 > 360:
                    u0 = 360.0
                if u1 < 0:
                    u1 = 0.0
                elif u1 > 360:
                    u1 = 360.0
                # 360 sits on the date line, which is column 0's other edge.
                if u0 >= 360:
                    u0 = 359.999
                if u1 >= 360:
                    u1 = 359.999
                v0 = min(180.0, max(0.0, v0))
                v1 = min(180.0, max(0.0, v1))
                if v0 >= 180:
                    v0 = 179.999
                if v1 >= 180:
                    v1 = 179.999
                for c, r, ua, va, ub, vb in clip_segment(
                    u0, v0, u1, v1, dlon, dlat, cols, rows
                ):
                    pa = (ua - 180.0, 90.0 - va)
                    pb = (ub - 180.0, 90.0 - vb)
                    if current != (c, r):
                        flush()
                        current = (c, r)
                        poly = [pa, pb]
                    else:
                        poly.append(pb)
            flush()

    def write(self):
        if self.folder.exists():
            for old in self.folder.glob("*.bin"):
                old.unlink()
        self.folder.mkdir(parents=True, exist_ok=True)
        biggest = 0
        biggest_name = ""
        for (c, r), body in self.bins.items():
            path = self.folder / f"c{c}r{r}.bin"
            with open(path, "wb") as f:
                f.write(b"RV10")
                f.write(struct.pack("<I", self.counts[(c, r)]))
                f.write(body)
            size = path.stat().st_size
            if size > biggest:
                biggest = size
                biggest_name = path.name
        print(
            f"  {self.folder.name}: {len(self.bins)} squares, {self.lines} pieces, "
            f"{self.points} points, largest {biggest_name} {biggest / 1e6:.2f} MB",
            flush=True,
        )


class LakeMask:
    """Water from the same lakes the globe draws. River lines stop at the shore."""

    def __init__(self):
        self.step = 0.02
        self.w = int(360 / self.step)
        self.h = int(180 / self.step)
        img = Image.new("L", (self.w, self.h), 0)
        draw = ImageDraw.Draw(img)
        ne = ROOT / ".texture-src" / "ne"
        for name in (
            "ne_10m_lakes_north_america.shp",
            "ne_10m_lakes_europe.shp",
            "ne_10m_lakes.shp",
        ):
            path = ne / name
            if not path.exists():
                raise SystemExit(f"missing {path}")
            reader = shapefile.Reader(str(path))
            for shp in reader.iterShapes():
                self._paint(draw, self._polygons(shp.points, shp.parts))
            reader.close()
        extra = ROOT / "scripts" / "extra-lakes.json"
        if extra.exists():
            for item in json.loads(extra.read_text()):
                self._paint(draw, item.get("rings") or [])
        self.mask = np.asarray(img, dtype=np.uint8)
        img.close()

    def _polygons(self, pts, parts):
        cuts = list(parts) + [len(pts)]
        rings = []
        for a, b in zip(cuts, cuts[1:]):
            ring = [(float(x), float(y)) for x, y in pts[a:b]]
            if len(ring) >= 4 and ring[0] == ring[-1]:
                ring = ring[:-1]
            if len(ring) >= 3:
                rings.append(ring)
        return [rings] if rings else []

    def _paint(self, draw, polygons):
        for rings in polygons:
            if not rings:
                continue
            signed = [self._area(ring) for ring in rings]
            shell = max(range(len(rings)), key=lambda i: abs(signed[i]))
            sign = 1 if signed[shell] >= 0 else -1
            # Shell first. A hole painted earlier would be filled back in.
            order = [shell] + [i for i in range(len(rings)) if i != shell]
            for i in order:
                ring = rings[i]
                area = signed[i]
                pix = [self._px(lon, lat) for lon, lat in ring]
                if len(pix) < 3:
                    continue
                fill = 0 if area * sign < 0 else 255
                draw.polygon(pix, fill=fill)

    def _area(self, ring):
        a = 0.0
        for i in range(len(ring)):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % len(ring)]
            a += x1 * y2 - x2 * y1
        return a * 0.5

    def _px(self, lon, lat):
        x = int((lon + 180.0) / 360.0 * (self.w - 1))
        y = int((90.0 - lat) / 180.0 * (self.h - 1))
        if x < 0:
            x = 0
        elif x >= self.w:
            x = self.w - 1
        if y < 0:
            y = 0
        elif y >= self.h:
            y = self.h - 1
        return (x, y)

    def inside(self, lon, lat):
        x, y = self._px(lon, lat)
        return self.mask[y, x] != 0

    def shore(self, outside, inside_pt):
        lo = outside
        hi = inside_pt
        for _ in range(14):
            mid = ((lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5)
            if self.inside(mid[0], mid[1]):
                hi = mid
            else:
                lo = mid
        return lo

    def cut(self, coords):
        """Drop the part of a line that runs across open lake water."""
        if len(coords) < 2:
            return []
        # A date-line jump is not a straight line across the world.
        out = []
        part = [coords[0]]
        for p in coords[1:]:
            if abs(p[0] - part[-1][0]) >= 180.0:
                if len(part) >= 2:
                    out.extend(self._cut_open(part))
                part = [p]
            else:
                part.append(p)
        if len(part) >= 2:
            out.extend(self._cut_open(part))
        return out

    def _cut_open(self, coords):
        out = []
        cur = []

        def flush():
            if len(cur) >= 2:
                out.append(list(cur))
            cur.clear()

        def push(p):
            if not cur or cur[-1] != p:
                cur.append(p)

        def walk(a, b):
            a_in = self.inside(a[0], a[1])
            b_in = self.inside(b[0], b[1])
            span = max(abs(a[0] - b[0]), abs(a[1] - b[1]))
            if not a_in and not b_in and span <= self.step:
                push(a)
                cur.append(b)
                return
            steps = max(1, int(math.ceil(span / self.step)))
            samples = []
            any_in = a_in or b_in
            for i in range(1, steps):
                t = i / steps
                p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                inn = self.inside(p[0], p[1])
                samples.append((p, inn))
                any_in = any_in or inn
            if not any_in:
                push(a)
                cur.append(b)
                return
            prev = a
            prev_in = a_in
            if not prev_in:
                push(a)
            for p, inn in samples + [(b, b_in)]:
                if not prev_in and not inn:
                    cur.append(p)
                elif not prev_in and inn:
                    cur.append(self.shore(prev, p))
                    flush()
                elif prev_in and not inn:
                    cur.append(self.shore(p, prev))
                    cur.append(p)
                prev, prev_in = p, inn

        for i in range(len(coords) - 1):
            walk(coords[i], coords[i + 1])
        flush()
        return out


LAKES = None


def lake_mask():
    global LAKES
    if LAKES is None:
        print("lakes", flush=True)
        LAKES = LakeMask()
        checks = (
            ("Superior", -87.0, 47.7, True),
            ("Erie", -81.2, 42.2, True),
            ("Chicago", -87.70, 41.88, False),
            ("Isle Royale", -88.887, 47.995, False),
            ("Manitoulin", -82.257, 45.798, False),
            ("Olkhon", 107.380, 53.173, False),
        )
        bad = []
        for name, lon, lat, want_water in checks:
            got = LAKES.inside(lon, lat)
            print(f"  {name} is water: {got}", flush=True)
            if got != want_water:
                bad.append(name)
        if bad:
            raise SystemExit("lake mask failed: " + ", ".join(bad))
        crossing = LAKES.cut([(-91.5, 47.7), (-84.8, 47.7)])
        if len(crossing) < 2:
            raise SystemExit("a line across Superior was not cut")
        for part in crossing:
            for lon, lat in part:
                if LAKES.inside(lon, lat):
                    raise SystemExit("a Superior crossing still has a point in the water")
        if not LAKES.cut([(-89.2, 47.995), (-88.6, 47.995)]):
            raise SystemExit("Isle Royale was clipped as if it were water")
        dry = LAKES.cut([(10.0, 23.0), (12.0, 23.0)])
        if len(dry) != 1 or len(dry[0]) != 2:
            raise SystemExit("a dry line was densified or cut")
        print("  lake clip ok", flush=True)
    return LAKES


def write_big(lines):
    tmp = BIG_OUT.with_suffix(".bin.tmp")
    with open(tmp, "wb") as f:
        f.write(b"RV10")
        f.write(struct.pack("<I", len(lines)))
        for rank, coords in lines:
            f.write(pack_line(rank, coords))
    tmp.replace(BIG_OUT)
    pts = sum(len(c) for _, c in lines)
    print(
        f"  {BIG_OUT.name}: {len(lines)} reaches, {pts} points, "
        f"{BIG_OUT.stat().st_size / 1e6:.2f} MB",
        flush=True,
    )


def load_squares(squares):
    """Read squares already written so a later write does not drop them."""
    if not squares.folder.is_dir():
        return
    for path in sorted(squares.folder.glob("c*r*.bin")):
        stem = path.stem
        c = int(stem.split("r")[0][1:])
        r = int(stem.split("r")[1])
        data = path.read_bytes()
        if data[:4] != b"RV10":
            raise SystemExit(f"{path.name} is not RV10")
        n = struct.unpack_from("<I", data, 4)[0]
        o = 8
        for _ in range(n):
            rank = data[o]
            o += 4
            np = struct.unpack_from("<I", data, o)[0]
            o += 4
            coords = []
            for _k in range(np):
                lon, lat = struct.unpack_from("<ff", data, o)
                o += 8
                coords.append((lon, lat))
            squares.add(c, r, rank, coords)


def add_flow_band(squares, lo, hi):
    """Add rivers whose flow is at least lo and below hi."""
    added = 0
    for folder in regions():
        t0 = time.time()
        shps = list(folder.glob("*.shp"))
        if not shps:
            raise SystemExit(f"no shapefile in {folder}")
        shp_path = shps[0]
        header_len, rec_len, (flow_off, flow_len) = fields_of(shp_path.with_suffix(".dbf"))
        region_added = 0
        with open(shp_path, "rb") as shp, open(shp_path.with_suffix(".dbf"), "rb") as dbf:
            shp.seek(100)
            i = 0
            while True:
                hdr = shp.read(8)
                if len(hdr) < 8:
                    break
                _rec, words = struct.unpack(">II", hdr)
                content = shp.read(words * 2)
                dbf.seek(header_len + i * rec_len)
                flag = dbf.read(1)
                raw = b""
                if flag and flag != b"*":
                    dbf.seek(header_len + i * rec_len + flow_off)
                    raw = dbf.read(flow_len)
                i += 1
                if not content or len(content) < 44:
                    continue
                if struct.unpack_from("<i", content, 0)[0] != 3:
                    continue
                try:
                    flow = float(raw.strip() or "0")
                except ValueError:
                    flow = 0.0
                if flow < lo or flow >= hi:
                    continue
                nparts, npts = struct.unpack_from("<ii", content, 36)
                if nparts < 1 or npts < 2:
                    continue
                parts_at = 44
                xy_at = parts_at + 4 * nparts
                parts = struct.unpack_from("<" + "i" * nparts, content, parts_at)
                ends = list(parts[1:]) + [npts]
                for a, b in zip(parts, ends):
                    if b - a < 2:
                        continue
                    coords = []
                    base = xy_at + a * 16
                    for k in range(b - a):
                        lon, lat = struct.unpack_from("<dd", content, base + k * 16)
                        coords.append((lon, lat))
                    for piece in lake_mask().cut(coords):
                        squares.add_clipped(piece, 12)
                    region_added += 1
                    added += 1
        print(
            f"  {shp_path.name}: {region_added} rivers from {lo:g} to {hi:g} "
            f"in {time.time() - t0:.0f}s",
            flush=True,
        )
    print(f"  added {added} rivers from {lo:g} to {hi:g}", flush=True)
    if added == 0:
        raise SystemExit(f"no rivers from {lo:g} to {hi:g}")
    return added


def extend_opening(lo=None, hi=None):
    """Add a band of rivers into the squares every zoom already draws."""
    if lo is None:
        lo = OPENING_FLOW
    if hi is None:
        hi = BIN_FLOW
    self_test()
    mid = Squares(MID_DIR, 8, 4)
    load_squares(mid)
    before = mid.lines
    print(f"opening squares already hold {before} rivers", flush=True)
    add_flow_band(mid, lo, hi)
    print(f"  opening squares {before} -> {mid.lines}", flush=True)
    mid.write()


def split_ranked_bin(write_mid=True):
    """The file already on disk is every river at or above 20 m3/s."""
    data = SRC_BIN.read_bytes()
    if data[:4] != b"RV10":
        raise SystemExit(f"{SRC_BIN.name} is not RV10")
    n = struct.unpack_from("<I", data, 4)[0]
    mid = Squares(MID_DIR, 8, 4)
    big = []
    o = 8
    for _ in range(n):
        rank = data[o]
        o += 4
        np = struct.unpack_from("<I", data, o)[0]
        o += 4
        coords = []
        for _k in range(np):
            lon, lat = struct.unpack_from("<ff", data, o)
            o += 8
            coords.append((lon, lat))
        kept = lake_mask().cut(coords)
        if rank <= 1:
            for piece in kept:
                big.append((1, piece))
        else:
            for piece in kept:
                mid.add_clipped(piece, 12)
    write_big(big)
    if write_mid:
        mid.write()
    return mid


def fields_of(dbf_path):
    with open(dbf_path, "rb") as f:
        f.seek(8)
        header_len, rec_len = struct.unpack("<HH", f.read(4))
        f.seek(32)
        off = 1
        found = None
        while f.tell() < header_len - 1:
            desc = f.read(32)
            if not desc or desc[0] == 0x0D:
                break
            name = desc[:11].split(b"\x00", 1)[0].decode()
            flen = desc[16]
            if name == "DIS_AV_CMS":
                found = (off, flen)
            off += flen
        if not found:
            raise SystemExit(f"no flow field in {dbf_path}")
        return header_len, rec_len, found


def self_test():
    # A segment crossing the prime meridian and the equator on the 8×4 grid.
    # Column edges are every 45°. u = lon+180, so lon 0 is u 180, the edge of column 4.
    dlon, dlat, cols, rows = 45.0, 45.0, 8, 4
    pieces = clip_segment(170, 40, 200, 50, dlon, dlat, cols, rows)
    cells = {(c, r) for c, r, *_ in pieces}
    if cells != {(3, 0), (4, 0), (4, 1)} and cells != {(3, 0), (4, 0), (4, 1), (3, 1)}:
        # 170,40 is col 3 row 1? v=40, row = 40/45 = 0. u=170, col = 170/45 = 3.
        # End u=200 col 4, v=50 row 1. Must visit both columns and both rows.
        pass
    cols_hit = {c for c, r, *_ in pieces}
    rows_hit = {r for c, r, *_ in pieces}
    if cols_hit != {3, 4} or rows_hit != {0, 1}:
        raise SystemExit(f"clip missed a square: {pieces}")
    # Inside one square.
    one = clip_segment(10, 10, 20, 20, dlon, dlat, cols, rows)
    if len(one) != 1 or one[0][0] != 0 or one[0][1] != 0:
        raise SystemExit(f"inside square failed: {one}")
    # The pieces of a clipped line meet at the boundary.
    sq = Squares(Path("/tmp/river-square-selftest"), 8, 4)
    sq.add_clipped([(-20, 10), (20, 10)], 12)
    if sq.lines < 2:
        raise SystemExit(f"line was not cut, pieces={sq.lines}")
    print("clip self-test ok", flush=True)


def main():
    self_test()
    print("big rivers, and the opening set from the 20 file", flush=True)
    mid = split_ranked_bin(write_mid=False)
    print("rivers from 10 to 20", flush=True)
    add_flow_band(mid, OPENING_FLOW, BIN_FLOW)
    mid.write()


if __name__ == "__main__":
    main()
