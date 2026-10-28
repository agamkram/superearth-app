#!/usr/bin/env python3
"""Bake one world river set from HydroRIVERS.

Keeps a reach when its own average flow is at least 20.
Rank 1 is a big river (1000 and up) and is drawn as a strip.
Rank 12 is everything else we keep, drawn as a 1 pixel line.
"""
from __future__ import annotations

import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "rivers-10m.bin"
MIN_FLOW = 20.0
BIG_FLOW = 1000.0


def regions():
    roots = sorted(Path("/tmp/hrx").glob("HydroRIVERS_v10_*_shp"))
    au = Path("/tmp/HydroRIVERS_v10_au_shp")
    if au.is_dir():
        roots.append(au)
    return roots


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


def read_lines(shp_path, dbf_path):
    header_len, rec_len, (flow_off, flow_len) = fields_of(dbf_path)
    lines = []
    big = 0
    small = 0
    pts = 0
    with open(shp_path, "rb") as shp, open(dbf_path, "rb") as dbf:
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
            typ = struct.unpack_from("<i", content, 0)[0]
            if typ != 3:
                continue
            try:
                flow = float(raw.strip() or "0")
            except ValueError:
                flow = 0.0
            if flow < MIN_FLOW:
                continue
            nparts, npts = struct.unpack_from("<ii", content, 36)
            if nparts < 1 or npts < 2:
                continue
            parts_at = 44
            xy_at = parts_at + 4 * nparts
            parts = struct.unpack_from("<" + "i" * nparts, content, parts_at)
            ends = list(parts[1:]) + [npts]
            rank = 1 if flow >= BIG_FLOW else 12
            for a, b in zip(parts, ends):
                if b - a < 2:
                    continue
                coords = []
                base = xy_at + a * 16
                for k in range(b - a):
                    lon, lat = struct.unpack_from("<dd", content, base + k * 16)
                    coords.append((lon, lat))
                lines.append((rank, coords))
                pts += len(coords)
                if rank == 1:
                    big += 1
                else:
                    small += 1
    return lines, big, small, pts


def write_bin(path, lines):
    tmp = path.with_suffix(".bin.tmp")
    with open(tmp, "wb") as f:
        f.write(b"RV10")
        f.write(struct.pack("<I", len(lines)))
        for rank, line in lines:
            f.write(struct.pack("<BxxxI", rank, len(line)))
            f.write(b"".join(struct.pack("<ff", lon, lat) for lon, lat in line))
    tmp.replace(path)


def main():
    all_lines = []
    for folder in regions():
        shps = list(folder.glob("*.shp"))
        if not shps:
            raise SystemExit(f"no shapefile in {folder}")
        shp = shps[0]
        dbf = shp.with_suffix(".dbf")
        lines, big, small, pts = read_lines(shp, dbf)
        all_lines.extend(lines)
        print(f"{shp.name}: {big} big, {small} smaller, {pts} points", flush=True)
    write_bin(OUT, all_lines)
    big_pts = sum(len(line) for rank, line in all_lines if rank == 1)
    small_pts = sum(len(line) for rank, line in all_lines if rank != 1)
    print(
        f"wrote {len(all_lines)} reaches, {big_pts} big points, {small_pts} smaller points, "
        f"{OUT.stat().st_size / 1e6:.1f} MB"
    )


if __name__ == "__main__":
    main()
