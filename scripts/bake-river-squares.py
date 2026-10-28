#!/usr/bin/env python3
"""Split rivers so the phone only keeps the water it can see.

rivers-big.bin   reaches at or above 1000 m3/s, the whole Earth
rivers-mid/      20–1000 m3/s, eight by four squares (same grid as tiles-16)
rivers-close/    every smaller HydroRIVERS reach, forty by twenty squares
                 (same grid as tiles-86). The big stems stay in rivers-big.bin.

A reach that crosses a square is cut on the square edge so the pieces meet.
"""
from __future__ import annotations

import math
import struct
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_BIN = ROOT / "rivers-10m.bin"
BIG_OUT = ROOT / "rivers-big.bin"
MID_DIR = ROOT / "rivers-mid"
CLOSE_DIR = ROOT / "rivers-close"
BIG_FLOW = 1000.0

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


def split_ranked_bin():
    """The file already on disk is every reach at or above 20 m3/s."""
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
        if rank <= 1:
            big.append((1, coords))
        else:
            mid.add_clipped(coords, 12)
    write_big(big)
    mid.write()


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


def bake_close():
    close = Squares(CLOSE_DIR, 40, 20)
    kept = 0
    skipped_big = 0
    for folder in regions():
        t0 = time.time()
        shps = list(folder.glob("*.shp"))
        if not shps:
            raise SystemExit(f"no shapefile in {folder}")
        shp_path = shps[0]
        header_len, rec_len, (flow_off, flow_len) = fields_of(shp_path.with_suffix(".dbf"))
        region_kept = 0
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
                if flow >= BIG_FLOW:
                    skipped_big += 1
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
                    close.add_clipped(coords, 12)
                    region_kept += 1
                    kept += 1
        print(
            f"  {shp_path.name}: {region_kept} smaller reaches in {time.time() - t0:.0f}s",
            flush=True,
        )
    print(f"  close kept {kept}, left {skipped_big} big stems in the zoomed-out file", flush=True)
    close.write()


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
    print("big and mid from the 20 m3/s file", flush=True)
    split_ranked_bin()
    print("close from HydroRIVERS", flush=True)
    bake_close()


if __name__ == "__main__":
    main()
