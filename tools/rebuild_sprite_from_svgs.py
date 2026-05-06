#!/usr/bin/env python3
"""Rebuild the 640x640 CSS sprite from the polished per-icon SVGs.

The vectorize pipeline already builds the sprite from the normalized PNGs,
but per-icon hand polish can drift the SVGs ahead of the PNG source. Re-run
this script after editing SVGs to refresh the sprite that the app actually
loads at runtime.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image


ICON_NAMES = [
    "status-open",
    "status-restricted",
    "status-closed",
    "status-estimated",
    "status-unknown",
    "poi-generic",
    "not-by-car",
    "poi-mountain-summit",
    "poi-alpine-lake",
    "poi-waterfall-gorge",
    "poi-glacier",
    "poi-old-town",
    "poi-castle-fortress",
    "poi-monastery-church",
    "poi-scenic-railway",
    "poi-bridge-engineering",
    "poi-village",
    "poi-national-park",
    "poi-spa-wellness",
    "poi-viewpoint-panorama",
    "poi-museum-cultural",
    "poi-geology-cave",
    "poi-wine-region",
    "poi-special-experience",
    "pass-generic",
]


def render_svg_cell(svg_path: Path, cell_size: int) -> Image.Image:
    raw = cairosvg.svg2png(url=str(svg_path), output_width=cell_size, output_height=cell_size)
    return Image.open(BytesIO(raw)).convert("RGBA")


def build_sprite(svg_dir: Path, sprite_path: Path, cell_size: int = 128, grid: int = 5) -> None:
    sprite = Image.new("RGBA", (grid * cell_size, grid * cell_size), (0, 0, 0, 0))
    for index, name in enumerate(ICON_NAMES):
        row, col = divmod(index, grid)
        svg_path = svg_dir / f"{index:02d}-{name}.svg"
        if not svg_path.exists():
            raise FileNotFoundError(svg_path)
        cell = render_svg_cell(svg_path, cell_size)
        sprite.paste(cell, (col * cell_size, row * cell_size), cell)

    sprite_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = sprite_path.with_name(f"{sprite_path.stem}.tmp{sprite_path.suffix}")
    sprite.save(tmp, optimize=True)
    tmp.replace(sprite_path)
    print(f"wrote {sprite_path} ({sprite.width}x{sprite.height}) from {len(ICON_NAMES)} SVGs")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--svg-dir", type=Path, default=Path("assets/ui-icons/svg"))
    parser.add_argument("--sprite", type=Path, default=Path("assets/ui-icons/alpine-ui-icons.png"))
    parser.add_argument("--cell-size", type=int, default=128)
    parser.add_argument("--grid", type=int, default=5)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    build_sprite(args.svg_dir, args.sprite, cell_size=args.cell_size, grid=args.grid)


if __name__ == "__main__":
    main()
