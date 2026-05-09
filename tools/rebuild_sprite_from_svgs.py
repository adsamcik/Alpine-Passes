#!/usr/bin/env python3
"""Rebuild the CSS sprite from polished SVGs or generated PNG cells.

The vectorize pipeline already builds the sprite from normalized PNGs, but
per-icon polish can drift the SVGs ahead of the PNG source. Re-run this script
after editing SVGs or generated PNG cells to refresh the sprite that the app
actually loads at runtime.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path

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
    "poi-funicular",
]


def render_svg_cell(svg_path: Path, cell_size: int) -> Image.Image:
    import cairosvg

    raw = cairosvg.svg2png(url=str(svg_path), output_width=cell_size, output_height=cell_size)
    return Image.open(BytesIO(raw)).convert("RGBA")


def render_png_cell(png_path: Path, cell_size: int) -> Image.Image:
    image = Image.open(png_path).convert("RGBA")
    if image.size == (cell_size, cell_size):
        return image
    return image.resize((cell_size, cell_size), Image.Resampling.LANCZOS)


def build_sprite(
    svg_dir: Path,
    png_dir: Path,
    sprite_path: Path,
    cell_size: int = 128,
    cols: int = 5,
    rows: int = 6,
) -> None:
    sprite = Image.new("RGBA", (cols * cell_size, rows * cell_size), (0, 0, 0, 0))
    for index, name in enumerate(ICON_NAMES):
        row, col = divmod(index, cols)
        if row >= rows:
            raise ValueError(f"{len(ICON_NAMES)} icons do not fit in a {cols}x{rows} atlas")
        svg_path = svg_dir / f"{index:02d}-{name}.svg"
        png_path = png_dir / f"{index:02d}-{name}.png"
        if svg_path.exists():
            cell = render_svg_cell(svg_path, cell_size)
        elif png_path.exists():
            cell = render_png_cell(png_path, cell_size)
        else:
            raise FileNotFoundError(f"Missing SVG or PNG for {index:02d}-{name}")
        sprite.paste(cell, (col * cell_size, row * cell_size), cell)

    sprite_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = sprite_path.with_name(f"{sprite_path.stem}.tmp{sprite_path.suffix}")
    sprite.save(tmp, optimize=True)
    tmp.replace(sprite_path)
    print(f"wrote {sprite_path} ({sprite.width}x{sprite.height}) from {len(ICON_NAMES)} icons")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--svg-dir", type=Path, default=Path("assets/ui-icons/svg"))
    parser.add_argument("--png-dir", type=Path, default=Path("assets/ui-icons/normalized-png"))
    parser.add_argument("--sprite", type=Path, default=Path("assets/ui-icons/alpine-ui-icons.png"))
    parser.add_argument("--cell-size", type=int, default=128)
    parser.add_argument("--cols", type=int, default=5)
    parser.add_argument("--rows", type=int, default=6)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    build_sprite(args.svg_dir, args.png_dir, args.sprite, cell_size=args.cell_size, cols=args.cols, rows=args.rows)


if __name__ == "__main__":
    main()
