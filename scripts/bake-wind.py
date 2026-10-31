#!/usr/bin/env python3
"""Bake the latest NOAA GFS analysis into wind.bin.

Two fields, both on the public 0.25° grid:
  0  wind 10 m above the ground
  1  wind at 175 hPa (the jet)

With no arguments, writes wind.bin in the app folder.
With a folder argument, writes wind.bin and CYCLE there for publishing.
If that forecast is already published, writes SKIP and does not download.
"""

import json
import os
import struct
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

_mac_eccodes = os.path.expanduser(
    "~/Library/Python/3.9/lib/python/site-packages/ecmwflibs"
)
if os.path.isdir(_mac_eccodes):
    os.environ.setdefault("ECCODES_HOME", _mac_eccodes)

import eccodes  # noqa: E402

BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
READY = "https://raw.githubusercontent.com/agamkram/superearth-app/wind-data/ready.json"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "wind.bin")
NLON = 1440
NLAT = 721
SCALE = 100

# (file tag, shortName, typeOfLevel, level) -> slot 0 surface, 1 jet
WANTED = {
    ("10u", "heightAboveGround", 10): ("u", 0),
    ("10v", "heightAboveGround", 10): ("v", 0),
    ("u", "isobaricInhPa", 175): ("u", 1),
    ("v", "isobaricInhPa", 175): ("v", 1),
}


def get(url, extra=None):
    req = urllib.request.Request(url, headers=extra or {"User-Agent": "superearth-bake-wind"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def latest_cycle():
    now = datetime.now(timezone.utc)
    for back in range(0, 3):
        day = now - timedelta(days=back)
        ymd = day.strftime("%Y%m%d")
        for cc in ("18", "12", "06", "00"):
            url = f"{BASE}/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.pgrb2.0p25.f000.idx"
            try:
                urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30).close()
            except Exception:
                continue
            return ymd, cc
    raise SystemExit("no GFS cycle found")


def idx_rows(text):
    rows = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) < 6:
            continue
        rows.append((int(parts[1]), parts[3], parts[4]))
    return rows


def range_of(rows, name, level):
    for i, (start, short, lev) in enumerate(rows):
        if short == name and lev == level:
            end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
            return start, end
    raise SystemExit(f"missing {name} {level}")


def messages(ymd, cc):
    blobs = []
    specs = [
        ("pgrb2.0p25", [("UGRD", "10 m above ground"), ("VGRD", "10 m above ground")]),
        ("pgrb2b.0p25", [("UGRD", "175 mb"), ("VGRD", "175 mb")]),
    ]
    for tag, want in specs:
        idx_url = f"{BASE}/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.{tag}.f000.idx"
        rows = idx_rows(get(idx_url).decode("ascii"))
        grib_url = f"{BASE}/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.{tag}.f000"
        for name, level in want:
            start, end = range_of(rows, name, level)
            print(f"  {tag} {name} {level} bytes {start}-{end}", flush=True)
            blob = get(grib_url, {"Range": f"bytes={start}-{end}", "User-Agent": "superearth-bake-wind"})
            blobs.append(blob)
    return b"".join(blobs)


def field_from(gid):
    ni = eccodes.codes_get(gid, "Ni")
    nj = eccodes.codes_get(gid, "Nj")
    lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
    lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
    jpos = eccodes.codes_get(gid, "jScansPositively")
    if (ni, nj) != (NLON, NLAT):
        raise SystemExit(f"unexpected grid {ni}x{nj}")
    if abs(lat1 - 90) > 0.01 or abs(lon1) > 0.01 or jpos != 0:
        raise SystemExit(f"unexpected scan lat0={lat1} lon0={lon1} jpos={jpos}")
    vals = np.array(eccodes.codes_get_values(gid), dtype=np.float64)
    if vals.size != NLON * NLAT:
        raise SystemExit(f"unexpected count {vals.size}")
    missing = eccodes.codes_get(gid, "missingValue")
    vals[vals == missing] = 0.0
    return vals.reshape(NLAT, NLON)


def published_cycle():
    try:
        req = urllib.request.Request(
            READY + "?t=" + str(int(time.time())),
            headers={"User-Agent": "SuperEarth"},
        )
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read().decode())
        return str(data.get("cycle") or "")
    except Exception:
        return ""


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    ymd, cc = latest_cycle()
    cycle = f"{ymd}{cc}"
    print(f"GFS {ymd} {cc}z", flush=True)
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        for old in out_dir.iterdir():
            if old.is_file():
                old.unlink()
        if published_cycle() == cycle:
            (out_dir / "SKIP").write_text(cycle)
            print("already published", cycle)
            return
    raw = messages(ymd, cc)
    planes = {("u", 0): None, ("v", 0): None, ("u", 1): None, ("v", 1): None}
    tmp = tempfile.NamedTemporaryFile(suffix=".grib", delete=False)
    tmp.write(raw)
    tmp.close()
    try:
        with open(tmp.name, "rb") as bio:
            while True:
                gid = eccodes.codes_grib_new_from_file(bio)
                if gid is None:
                    break
                key = (
                    eccodes.codes_get(gid, "shortName"),
                    eccodes.codes_get(gid, "typeOfLevel"),
                    int(eccodes.codes_get(gid, "level")),
                )
                slot = WANTED.get(key)
                if slot:
                    planes[slot] = field_from(gid)
                eccodes.codes_release(gid)
    finally:
        os.remove(tmp.name)
    for key, arr in planes.items():
        if arr is None:
            raise SystemExit(f"did not decode {key}")

    def at(arr, lat, lon):
        if lon < 0:
            lon += 360
        col = int(round(lon / 0.25)) % NLON
        row = int(round((90 - lat) / 0.25))
        return float(arr[row, col])

    def row_mean(arr, lat):
        row = int(round((90 - lat) / 0.25))
        return float(arr[row].mean())

    trade_u = at(planes[("u", 0)], 15, -40)
    trade_band = row_mean(planes[("u", 0)], 15)
    jet_u = at(planes[("u", 1)], 40, -70)
    jet_v = at(planes[("v", 1)], 40, -70)
    print(f"  15N surface zonal u={trade_band:.1f}  15N 40W u={trade_u:.1f}")
    print(f"  jet 40N 70W u={jet_u:.1f} v={jet_v:.1f} m/s")
    # Trades along 15°N blow from the east. The jet sample should be a real wind.
    if trade_band >= 0:
        raise SystemExit("15°N wind is not from the east; grid may be flipped")
    if (jet_u ** 2 + jet_v ** 2) ** 0.5 < 12:
        raise SystemExit("jet sample is too calm to be 175 hPa")

    yyyymmddhh = int(ymd) * 100 + int(cc)
    header = struct.pack("<4sHHHH I", b"WND1", NLON, NLAT, 2, SCALE, yyyymmddhh)
    dest = out_dir / "wind.bin" if out_dir is not None else Path(OUT)
    with open(dest, "wb") as f:
        f.write(header)
        for lev in (0, 1):
            for comp in ("u", "v"):
                scaled = np.rint(planes[(comp, lev)] * SCALE).astype(np.int32)
                np.clip(scaled, -32767, 32767).astype("<i2").tofile(f)
    if out_dir is not None:
        (out_dir / "CYCLE").write_text(cycle)
    print(f"wrote {dest} ({dest.stat().st_size} bytes) cycle {yyyymmddhh}")


if __name__ == "__main__":
    main()
