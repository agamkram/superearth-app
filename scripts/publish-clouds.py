#!/usr/bin/env python3
"""Cut the current cloud photograph into eight lossless squares.

The globe keeps the previous set until this one is published whole.
Writes PNGs and a STAMP file into the directory given on the command line.
If that photograph is already published, writes SKIP and does not cut.
"""
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

READY = "https://raw.githubusercontent.com/agamkram/superearth-app/cloud-tiles/ready.json"
SOURCE = "https://clouds.matteason.co.uk/images/8192x4096/clouds-alpha.png"
COLS = 4
ROWS = 2


def stamp_now():
    return str(int(time.time() // (3 * 3600)))


def published_stamp():
    try:
        req = urllib.request.Request(READY + "?t=" + stamp_now(), headers={"User-Agent": "SuperEarth"})
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read().decode())
        return str(data.get("stamp") or "")
    except Exception:
        return ""


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
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():
        if old.is_file():
            old.unlink()
    stamp = stamp_now()
    if published_stamp() == stamp:
        (out / "SKIP").write_text(stamp)
        print("already published", stamp)
        return
    req = urllib.request.Request(SOURCE + "?t=" + stamp, headers={"User-Agent": "SuperEarth"})
    with urllib.request.urlopen(req, timeout=180) as res:
        raw = res.read()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("cloud picture was not a png")
    im = Image.open(io.BytesIO(raw))
    im.load()
    print("source", im.mode, im.size, "bytes", len(raw))
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
    print("cut", stamp, "bytes", sum(p.stat().st_size for p in out.glob("*.png")))


if __name__ == "__main__":
    main()
