#!/usr/bin/env python3
"""Bake wind for the same hour as the cloud picture.

Four fields, all on the public 0.25° grid:
  0  33 feet above the ground
  1  850 mb, about 5,000 feet
  2  15,000 feet above the sea
  3  250 mb, about 34,000 feet, the jet stream

The hour comes from the published cloud picture. The finished look at that
hour is used when it is posted. Until then, the latest earlier run's
forecast for that hour is used. A later better file for the same hour
replaces it.

Writes wind-0.bin to wind-3.bin, one per height, plus CYCLE, RUN, FHOUR,
and FORMAT into the folder given (default .tmp/wind-data in the app folder).
Each file is the WND2 layout: a 16 byte header, then u and v as int16
tenths of a m/s, each row stored as steps from the cell to its west.
If that same file is already published, writes SKIP and does not download.
With --check, stops after that test and downloads nothing.
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

np = None
eccodes = None

BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
READY = "https://raw.githubusercontent.com/agamkram/superearth-app/wind-data/ready.json"
CLOUD_READY = "https://raw.githubusercontent.com/agamkram/superearth-app/cloud-tiles/ready.json"
OUT_DIR = Path(__file__).resolve().parent.parent / ".tmp" / "wind-data"
NLON = 1440
NLAT = 721
SCALE = 10
NLEV = 4
FORMAT = "2"


def load_decoder():
    """numpy and the GRIB decoder load only when a file is baked."""
    global np, eccodes
    import numpy

    mac_eccodes = os.path.expanduser("~/Library/Python/3.9/lib/python/site-packages/ecmwflibs")
    if os.path.isdir(mac_eccodes):
        os.environ.setdefault("ECCODES_HOME", mac_eccodes)
    elif "ECCODES_HOME" not in os.environ:
        # The GitHub runner has no system decoder. The bundled file name is hashed,
        # so expose it under the plain name the importer looks for.
        try:
            import ecmwflibs

            bundled = ecmwflibs.find("eccodes")
        except Exception:
            bundled = None
        if bundled:
            home = tempfile.mkdtemp(prefix="eccodes-home-")
            libdir = os.path.join(home, "lib")
            os.makedirs(libdir)
            os.symlink(bundled, os.path.join(libdir, "libeccodes.so"))
            os.environ["ECCODES_HOME"] = home
            dep = os.path.dirname(bundled)
            prev = os.environ.get("LD_LIBRARY_PATH", "")
            os.environ["LD_LIBRARY_PATH"] = dep if not prev else dep + ":" + prev

    import eccodes as decoder

    np = numpy
    eccodes = decoder

# Decoded message -> (component, level).
WANTED = {
    ("10u", "heightAboveGround", 10): ("u", 0),
    ("10v", "heightAboveGround", 10): ("v", 0),
    ("u", "isobaricInhPa", 850): ("u", 1),
    ("v", "isobaricInhPa", 850): ("v", 1),
    ("u", "heightAboveSea", 4572): ("u", 2),
    ("v", "heightAboveSea", 4572): ("v", 2),
    ("u", "isobaricInhPa", 250): ("u", 3),
    ("v", "isobaricInhPa", 250): ("v", 3),
}

FETCH = [
    (
        "pgrb2.0p25",
        [
            ("UGRD", "10 m above ground"),
            ("VGRD", "10 m above ground"),
            ("UGRD", "850 mb"),
            ("VGRD", "850 mb"),
            ("UGRD", "250 mb"),
            ("VGRD", "250 mb"),
        ],
    ),
    (
        "pgrb2b.0p25",
        [
            ("UGRD", "4572 m above mean sea level"),
            ("VGRD", "4572 m above mean sea level"),
        ],
    ),
]


def get(url, extra=None):
    req = urllib.request.Request(url, headers=extra or {"User-Agent": "superearth-bake-wind"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def cloud_hour():
    """The hour of the cloud picture that is actually published."""
    try:
        data = json.loads(get(CLOUD_READY + "?t=" + str(int(time.time()))))
        stamp = int(data["stamp"])
        return datetime.fromtimestamp(stamp * 3 * 3600, timezone.utc)
    except Exception:
        now = datetime.now(timezone.utc)
        secs = int(now.timestamp()) // (3 * 3600) * (3 * 3600)
        return datetime.fromtimestamp(secs, timezone.utc)


def idx_url(ymd, cc, tag, fhour):
    return f"{BASE}/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.{tag}.f{fhour:03d}.idx"


def have_run(ymd, cc, fhour):
    for tag, _want in FETCH:
        url = idx_url(ymd, cc, tag, fhour)
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "superearth-bake-wind"})
        try:
            urllib.request.urlopen(req, timeout=30).close()
        except Exception:
            return False
    return True


def best_source(valid):
    """Newest run that already has this hour. The finished file wins when it exists."""
    hour = (valid.hour // 6) * 6
    run = valid.replace(hour=hour, minute=0, second=0, microsecond=0)
    for _ in range(12):
        fhour = int((valid - run).total_seconds() // 3600)
        if 0 <= fhour <= 36:
            ymd = run.strftime("%Y%m%d")
            cc = run.strftime("%H")
            if have_run(ymd, cc, fhour):
                return ymd, cc, fhour
        run -= timedelta(hours=6)
    raise SystemExit("no wind for the cloud hour")


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


def messages(ymd, cc, fhour):
    blobs = []
    for tag, want in FETCH:
        rows = idx_rows(get(idx_url(ymd, cc, tag, fhour)).decode("ascii"))
        grib_url = f"{BASE}/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.{tag}.f{fhour:03d}"
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


def published_info():
    try:
        data = json.loads(get(READY + "?t=" + str(int(time.time()))))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def main():
    check_only = "--check" in sys.argv[1:]
    args = [a for a in sys.argv[1:] if a != "--check"]
    out_dir = Path(args[0]) if args else OUT_DIR
    valid = cloud_hour()
    ymd, cc, fhour = best_source(valid)
    cycle = valid.strftime("%Y%m%d%H")
    run = f"{ymd}{cc}"
    print(f"cloud hour {cycle} from {run} f{fhour:03d}", flush=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.iterdir():
        if old.is_file():
            old.unlink()
    have = published_info()
    if (
        str(have.get("cycle") or "") == cycle
        and str(have.get("run") or "") == run
        and str(have.get("fhour") or "") == str(fhour)
        and str(have.get("v") or "") == FORMAT
    ):
        (out_dir / "SKIP").write_text(cycle)
        print("already published", cycle)
        return
    if check_only:
        print("needs publishing", cycle)
        return
    load_decoder()
    raw = messages(ymd, cc, fhour)
    planes = {}
    for comp in ("u", "v"):
        for lev in range(4):
            planes[(comp, lev)] = None
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

    trade_band = row_mean(planes[("u", 0)], 15)
    jet_u = at(planes[("u", 3)], 40, -70)
    jet_v = at(planes[("v", 3)], 40, -70)
    print(f"  15N ground zonal u={trade_band:.1f}")
    print(f"  jet 40N 70W u={jet_u:.1f} v={jet_v:.1f} m/s")
    # Trades along 15°N blow from the east. The jet sample should be a real wind.
    if trade_band >= 0:
        raise SystemExit("15°N wind is not from the east; grid may be flipped")
    if (jet_u ** 2 + jet_v ** 2) ** 0.5 < 12:
        raise SystemExit("jet sample is too calm to be 34,000 feet")

    total = 0
    for lev in range(NLEV):
        header = struct.pack("<4sHHHHI", b"WND2", NLON, NLAT, lev, SCALE, int(cycle))
        dest = out_dir / f"wind-{lev}.bin"
        with open(dest, "wb") as f:
            f.write(header)
            for comp in ("u", "v"):
                scaled = np.clip(np.rint(planes[(comp, lev)] * SCALE), -32767, 32767).astype(np.int32)
                steps = np.diff(scaled, axis=1, prepend=0)
                if np.abs(steps).max() > 32767:
                    raise SystemExit(f"wind step too large at height {lev}")
                steps.astype("<i2").tofile(f)
        total += dest.stat().st_size
    (out_dir / "CYCLE").write_text(cycle)
    (out_dir / "RUN").write_text(run)
    (out_dir / "FHOUR").write_text(str(fhour))
    (out_dir / "FORMAT").write_text(FORMAT)
    print(f"wrote {out_dir} ({total} bytes) hour {cycle} from {run} f{fhour:03d}")


if __name__ == "__main__":
    main()
