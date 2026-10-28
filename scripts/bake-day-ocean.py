#!/usr/bin/env python3
"""Put the older day picture's water onto the closest day squares.

Land stays the July 2004 picture. Water is copied from the 43,200-wide
older day picture. Ocean is where the elevation file is 0, which leaves
the Great Lakes on land.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / ".texture-src" / "tiles-86-july"
OUT = ROOT / "tiles-86"
OLD_PATH = ROOT / ".texture-src" / "day-nextgen-42k.jpg"
ELEV_PATH = ROOT / ".texture-src" / "nasa-elev-21k.png"
COLS = 40
ROWS = 20
TILE = 2160


def load_sources():
    print("loading older day picture", flush=True)
    old = np.asarray(Image.open(OLD_PATH).convert("RGB"))
    print("loading elevation", flush=True)
    elev = np.asarray(Image.open(ELEV_PATH))
    if old.shape != (21600, 43200, 3):
        raise SystemExit(f"older picture is {old.shape}, expected 21600x43200")
    if elev.shape != (10800, 21600):
        raise SystemExit(f"elevation is {elev.shape}, expected 10800x21600")
    return old, elev


def water_mask(elev_tile: np.ndarray) -> np.ndarray:
    small = Image.fromarray(np.where(elev_tile == 0, np.uint8(255), np.uint8(0)))
    big = small.resize((TILE, TILE), Image.Resampling.BILINEAR)
    return np.asarray(big) >= 128


def upscale(old_tile: np.ndarray) -> np.ndarray:
    return np.asarray(
        Image.fromarray(old_tile).resize((TILE, TILE), Image.Resampling.LANCZOS)
    )


def main() -> int:
    if not SRC.is_dir() or not any(SRC.glob("c0r0.jpg")):
        raise SystemExit(f"missing July squares in {SRC}")
    old, elev = load_sources()
    done = 0
    changed = 0
    for r in range(ROWS):
        for c in range(COLS):
            ev = elev[r * 540 : (r + 1) * 540, c * 540 : (c + 1) * 540]
            done += 1
            if ev.min() > 0:
                continue
            src_path = SRC / f"c{c}r{r}.jpg"
            tile = np.asarray(Image.open(src_path).convert("RGB"))
            water_src = old[r * 1080 : (r + 1) * 1080, c * 1080 : (c + 1) * 1080]
            water = upscale(water_src)
            if ev.max() == 0:
                out = water
            else:
                mask = water_mask(ev)
                out = tile.copy()
                out[mask] = water[mask]
            dest = OUT / f"c{c}r{r}.jpg"
            Image.fromarray(out).save(
                dest, "JPEG", quality=92, progressive=True, subsampling=0
            )
            changed += 1
            if changed == 1:
                # one coast, full size, so the edge can be checked
                coast = Image.fromarray(out).crop((0, 0, 900, 700))
                coast.save("/tmp/ocean-fix/first-square.jpg", quality=92)
                print("first square written", flush=True)
            if changed % 25 == 0:
                print(f"{changed} squares with water, {done}/{COLS * ROWS}", flush=True)
    print(f"updated {changed} squares, left land-only squares alone", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
