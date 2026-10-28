#!/usr/bin/env python3
"""Cut the 86,400 day and night pictures into the closest squares.

Each source piece is 21600×21600. Ten squares of 2160 fit across a piece.
Eight pieces cover the earth: 40 columns by 20 rows.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parents[1]
PIECE = 2160
ACROSS = 10
QUAD = {
    "A1": (0, 0),
    "B1": (1, 0),
    "C1": (2, 0),
    "D1": (3, 0),
    "A2": (0, 1),
    "B2": (1, 1),
    "C2": (2, 1),
    "D2": (3, 1),
}


def cut_dir(src_dir: Path, pattern: str, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for name, (qx, qy) in QUAD.items():
        matches = sorted(src_dir.glob(pattern.format(quad=name)))
        if not matches:
            raise SystemExit(f"missing {name} in {src_dir}")
        path = matches[0]
        print(f"  {path.name}", flush=True)
        im = Image.open(path).convert("RGB")
        if im.size != (21600, 21600):
            raise SystemExit(f"{path.name} is {im.size}, expected 21600x21600")
        for ly in range(ACROSS):
            for lx in range(ACROSS):
                c = qx * ACROSS + lx
                r = qy * ACROSS + ly
                tile = im.crop((lx * PIECE, ly * PIECE, (lx + 1) * PIECE, (ly + 1) * PIECE))
                dest = out_dir / f"c{c}r{r}.jpg"
                tile.save(dest, "JPEG", quality=90, progressive=True)
                tile.close()
                n += 1
        im.close()
        print(f"    {n} squares", flush=True)
    print(f"wrote {n} into {out_dir.name}")


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    if which in ("night", "both"):
        print("night")
        cut_dir(
            ROOT / ".texture-src" / "blackmarble-2016",
            "BlackMarble_2016_{quad}.jpg",
            ROOT / "night-tiles-86",
        )
    if which in ("day", "both"):
        print("day")
        cut_dir(
            ROOT / ".texture-src" / "bmng-500m",
            "world.200407.3x21600x21600.{quad}.jpg",
            ROOT / "tiles-86",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
