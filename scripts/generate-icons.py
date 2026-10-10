#!/usr/bin/env python3
"""PWA icons: Earth as a globe on black, same family as Sun, Mars, and Moon."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MAP = ROOT / "earth-8k.jpg"
# Geographic longitude at the center of the disk. Africa sits near 20°E.
LON0 = 18.0
# #4da6ff, the globe's atmosphere shell.
AIR = np.array([77.0, 166.0, 255.0], dtype=np.float32)


def _sample_equirect(src: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    h, w = src.shape[:2]
    x = u * (w - 1)
    y = np.clip(v * (h - 1), 0, h - 1)
    x0 = np.floor(x).astype(np.int32) % w
    y0 = np.floor(y).astype(np.int32)
    x1 = (x0 + 1) % w
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = (x - np.floor(x))[..., None]
    fy = (y - np.floor(y))[..., None]
    c00 = src[y0, x0].astype(np.float32)
    c10 = src[y0, x1].astype(np.float32)
    c01 = src[y1, x0].astype(np.float32)
    c11 = src[y1, x1].astype(np.float32)
    return (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy


def render_globe(size: int, *, maskable: bool = False) -> Image.Image:
    src = np.asarray(Image.open(MAP).convert("RGB"))
    yy, xx = np.indices((size, size), dtype=np.float32)
    cx = cy = (size - 1) * 0.5
    # Same margins as Sun/Mars/Moon. Maskable sits smaller so the crop keeps the limb.
    r_disk = size * (0.32 if maskable else 0.40)
    nx = (xx - cx) / r_disk
    ny = -(yy - cy) / r_disk
    rr = nx * nx + ny * ny
    front = rr <= 1.0
    nz = np.zeros_like(nx)
    nz[front] = np.sqrt(np.clip(1.0 - rr[front], 0, 1))

    lon_deg = np.degrees(np.arctan2(nx, np.maximum(nz, 1e-6)))
    lat_deg = np.degrees(np.arcsin(np.clip(ny, -1.0, 1.0)))
    # Day texture: longitude 0 is the center column.
    u = ((180.0 + LON0 + lon_deg) / 360.0) % 1.0
    v = np.clip(0.5 - lat_deg / 180.0, 0.0, 1.0)

    col = np.zeros((size, size, 3), dtype=np.float32)
    col[front] = _sample_equirect(src, u[front], v[front])

    # The day map is flatly lit. A soft limb falloff makes it a sphere.
    shade = np.where(front, 0.58 + 0.42 * nz, 0.0)
    col *= shade[..., None]

    # Thin blue air, about the globe's 5% atmosphere shell.
    r = np.sqrt(rr)
    span = 0.06
    h = np.clip((r - 1.0) / span, 0.0, 1.0)
    outside = np.where(r >= 1.0, np.power(1.0 - h, 0.75), 0.0)
    limb = np.where(front, np.power(1.0 - nz, 1.8), 0.0)
    col += AIR * (outside * 0.62 + limb * 0.28)[..., None]

    rng = np.random.default_rng(180)
    n_stars = 18 if not maskable else 10
    for _ in range(n_stars):
        sx = int(rng.integers(0, size))
        sy = int(rng.integers(0, size))
        dx = (sx - cx) / r_disk
        dy = (sy - cy) / r_disk
        if dx * dx + dy * dy < 1.22:
            continue
        bright = float(rng.uniform(90, 180))
        rad = 0 if size < 64 else (1 if rng.random() < 0.7 else 0)
        y0, y1 = max(0, sy - rad), min(size, sy + rad + 1)
        x0, x1 = max(0, sx - rad), min(size, sx + rad + 1)
        col[y0:y1, x0:x1] = np.maximum(col[y0:y1, x0:x1], bright)

    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8))


def save_icons() -> None:
    hi = render_globe(1024)
    icon_512 = hi.resize((512, 512), Image.Resampling.LANCZOS)
    icon_512.save(ROOT / "icon-512.png", "PNG")
    render_globe(1024, maskable=True).resize((512, 512), Image.Resampling.LANCZOS).save(
        ROOT / "icon-maskable-512.png", "PNG"
    )
    icon_512.resize((192, 192), Image.Resampling.LANCZOS).save(ROOT / "icon-192.png", "PNG")
    apple = icon_512.resize((180, 180), Image.Resampling.LANCZOS).convert("RGBA")
    apple.save(ROOT / "apple-touch-icon.png", "PNG")
    apple.save(ROOT / "apple-touch-icon-precomposed.png", "PNG")
    apple.save(ROOT / "apple-touch-icon-180x180.png", "PNG")
    icon_64 = icon_512.resize((64, 64), Image.Resampling.LANCZOS)
    icon_32 = icon_512.resize((32, 32), Image.Resampling.LANCZOS)
    icon_64.save(ROOT / "favicon-64.png", "PNG")
    icon_32.save(ROOT / "favicon-32.png", "PNG")
    icon_32.convert("RGBA").save(
        ROOT / "favicon.ico", format="ICO", sizes=[(32, 32), (16, 16)]
    )
    print("Wrote globe icons in", ROOT)


if __name__ == "__main__":
    save_icons()
