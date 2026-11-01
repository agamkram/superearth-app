#!/usr/bin/env python3
"""Build the newest EUMETSAT cloud picture and cut it into eight lossless squares.

The stamp is the satellite time of the picture, in 3-hour steps since 1970,
so the wind job bakes the same hour the clouds show.
The globe keeps the previous set until this one is published whole.
Writes PNGs, STAMP, and FORMAT into the directory given on the command line.
If that picture is already published, writes SKIP and does not build.
With --check, stops after that test and downloads nothing.
make-clouds.js needs node and jimp 0.22.10 next to it.
"""
import io
import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

Image = None

READY = "https://raw.githubusercontent.com/agamkram/superearth-app/cloud-tiles/ready.json"
CAPS = "https://view.eumetsat.int/geoserver/mumi/{}/ows?service=WMS&version=1.3.0&request=GetCapabilities"
LAYERS = ("worldcloudmap_ir108", "wideareacoverage_rgb_dust", "wideareacoverage_rgb_natural")
MAKE = Path(__file__).resolve().parent / "make-clouds.js"
FORMAT = "2"
COLS = 4
ROWS = 2


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "SuperEarth"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def newest_time():
    """Latest satellite time that all three layers have."""
    ends = []
    for name in LAYERS:
        text = get(CAPS.format(name)).decode("utf-8", "replace")
        m = re.search(r'<Dimension name="time"[^>]*>[^<]*/([0-9T:.\-]+)Z/PT3H', text)
        if not m:
            raise SystemExit(f"no time range for {name}")
        ends.append(datetime.strptime(m.group(1)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc))
    return min(ends)


def published():
    try:
        data = json.loads(get(READY + "?t=" + str(int(time.time() // 60)), timeout=30).decode())
        return str(data.get("stamp") or ""), str(data.get("v") or "")
    except Exception:
        return "", ""


def pack(tile):
    """Gray plus transparency stays gray plus transparency. Same pixels, smaller file."""
    if tile.mode == "LA":
        return tile
    if tile.mode == "RGBA":
        r, g, b, a = tile.split()
        if r.tobytes() == g.tobytes() == b.tobytes():
            return Image.merge("LA", (r, a))
        return tile
    raise SystemExit(f"unexpected cloud mode {tile.mode}")


def same_pixels(tile, blob):
    back = Image.open(io.BytesIO(blob))
    back.load()
    if back.mode != tile.mode or back.size != tile.size:
        return False
    return tile.tobytes() == back.tobytes()


def main():
    global Image
    check_only = "--check" in sys.argv[1:]
    out = Path([a for a in sys.argv[1:] if a != "--check"][0])
    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():
        if old.is_file():
            old.unlink()
    when = newest_time()
    stamp = str(int(when.timestamp()) // (3 * 3600))
    if published() == (stamp, FORMAT):
        (out / "SKIP").write_text(stamp)
        print("already published", stamp, when.isoformat())
        return
    if check_only:
        print("needs publishing", stamp, when.isoformat())
        return
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    with tempfile.TemporaryDirectory() as tmp:
        picture = Path(tmp) / "clouds-alpha.png"
        subprocess.run(["node", str(MAKE), when.strftime("%Y-%m-%dT%H:00:00Z"), str(picture)], check=True)
        im = Image.open(picture)
        im.load()
    print("picture", when.isoformat(), im.mode, im.size)
    tw, th = im.size[0] // COLS, im.size[1] // ROWS
    if tw * COLS != im.size[0] or th * ROWS != im.size[1]:
        raise SystemExit("cloud picture is not divisible into eight")
    for r in range(ROWS):
        for c in range(COLS):
            tile = pack(im.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th)))
            buf = io.BytesIO()
            tile.save(buf, "PNG", compress_level=6)
            blob = buf.getvalue()
            if not same_pixels(tile, blob):
                raise SystemExit(f"square c{c}r{r} changed a pixel")
            (out / f"{stamp}-c{c}r{r}.png").write_bytes(blob)
            tile.close()
    (out / "STAMP").write_text(stamp)
    (out / "FORMAT").write_text(FORMAT)
    print("cut", stamp, "bytes", sum(p.stat().st_size for p in out.glob("*.png")))


if __name__ == "__main__":
    main()
