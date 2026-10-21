#!/usr/bin/env python3
"""Bake SuperEarth night wraps + zoom tiles from NASA Black Marble 2016 500m.

Source: eight 21600×21600 JPEG quadrants (A1–D2) → virtual 86400×43200 globe.
Assemble at each target size by pasting one quadrant at a time (memory-safe),
then cut the day-matching grids: night-tiles-16 (8×4), night-tiles-32 (16×8).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / ".texture-src" / "blackmarble-2016"
QUAD_ORDER = ("A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2")
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
SRC_TILE = 21600
Q = 85


def quad_path(name: str) -> Path:
    return SRC_DIR / f"BlackMarble_2016_{name}.jpg"


def assemble(width: int, height: int) -> Image.Image:
    """Build equirect at width×height from the eight 500m quads."""
    assert width % 4 == 0 and height % 2 == 0, (width, height)
    tw, th = width // 4, height // 2
    canvas = Image.new("RGB", (width, height))
    for name in QUAD_ORDER:
        cx, ry = QUAD[name]
        p = quad_path(name)
        print(f"  {name} → {tw}x{th}")
        q = Image.open(p).convert("RGB")
        if q.size != (SRC_TILE, SRC_TILE):
            raise ValueError(f"{p.name} expected {SRC_TILE}x{SRC_TILE}, got {q.size}")
        piece = q.resize((tw, th), Image.Resampling.LANCZOS)
        q.close()
        canvas.paste(piece, (cx * tw, ry * th))
        piece.close()
    return canvas


def save_jpeg(im: Image.Image, path: Path, quality: int = Q) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    mb = path.stat().st_size / 1e6
    print(f"  wrote {path.relative_to(ROOT)}  {mb:.2f}MB  {im.size[0]}x{im.size[1]}")


def cut_grid(im: Image.Image, cols: int, rows: int, out_dir: Path) -> None:
    w, h = im.size
    tw, th = w // cols, h // rows
    if out_dir.exists():
        for p in out_dir.glob("*.jpg"):
            p.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    n = cols * rows
    i = 0
    for r in range(rows):
        for c in range(cols):
            tile = im.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th))
            path = out_dir / f"c{c}r{r}.jpg"
            tile.save(path, "JPEG", quality=Q, optimize=True, progressive=True)
            total += path.stat().st_size
            tile.close()
            i += 1
            print(f"  {out_dir.name} {i}/{n}", end="\r")
    print(f"  {out_dir.name} total {total / 1e6:.1f}MB  tile {tw}x{th}          ")


def bake_wraps() -> None:
    print("assemble 8k wrap…")
    im8 = assemble(8192, 4096)
    save_jpeg(im8, ROOT / "earth-night-8k.jpg", Q)
    im2 = im8.resize((2048, 1024), Image.Resampling.LANCZOS)
    im8.close()
    save_jpeg(im2, ROOT / "earth-night-2k.jpg", 82)
    im2.close()


def bake_tiles16() -> None:
    print("assemble tiles-16 master (16384×8192)…")
    mid = assemble(16384, 8192)
    cut_grid(mid, 8, 4, ROOT / "night-tiles-16")
    mid.close()


def bake_tiles32() -> None:
    print("assemble tiles-32 master (32768×16384)…")
    close = assemble(32768, 16384)
    cut_grid(close, 16, 8, ROOT / "night-tiles-32")
    close.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wraps-only", action="store_true")
    ap.add_argument("--tiles16-only", action="store_true")
    ap.add_argument("--tiles32-only", action="store_true")
    args = ap.parse_args()

    missing = [n for n in QUAD_ORDER if not quad_path(n).is_file()]
    if missing:
        print("Missing source tiles:", ", ".join(missing), file=sys.stderr)
        return 1

    if args.wraps_only:
        bake_wraps()
    elif args.tiles16_only:
        bake_tiles16()
    elif args.tiles32_only:
        bake_tiles32()
    else:
        bake_wraps()
        bake_tiles16()
        bake_tiles32()
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
