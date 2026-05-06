#!/usr/bin/env python3
"""Normalize transparent icon sprite sheets into centered square cells.

The generated icon artwork can arrive with uneven transparent padding or with
the visible artwork too close to a cell edge. This script treats every grid cell
as an individual icon, detects the non-transparent bounds, places that crop on a
square canvas, scales it to a safe inner size, and pastes it back into a
same-sized transparent cell.

The output sheet keeps exactly the same pixel dimensions and grid layout as the
input sheet, so existing CSS background-position mappings keep working.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - only exercised on misconfigured machines.
    raise SystemExit(
        "Pillow is required to normalize sprite sheets. Install it with: python -m pip install Pillow"
    ) from exc


@dataclass(frozen=True)
class Bounds:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top


def alpha_bounds(cell: Image.Image, threshold: int, bleed: int) -> Bounds | None:
    """Return alpha bounds for pixels above threshold, expanded by bleed."""
    alpha = cell.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return None

    left, top, right, bottom = bbox
    return Bounds(
        max(0, left - bleed),
        max(0, top - bleed),
        min(cell.width, right + bleed),
        min(cell.height, bottom + bleed),
    )


def normalize_cell(cell: Image.Image, padding: int, threshold: int, bleed: int) -> Image.Image:
    """Center one icon cell after trimming transparent bounds."""
    cell = cell.convert("RGBA")
    bounds = alpha_bounds(cell, threshold=threshold, bleed=bleed)
    normalized = Image.new("RGBA", cell.size, (0, 0, 0, 0))
    if bounds is None:
        return normalized

    crop = cell.crop((bounds.left, bounds.top, bounds.right, bounds.bottom))
    square_size = max(bounds.width, bounds.height)
    square = Image.new("RGBA", (square_size, square_size), (0, 0, 0, 0))
    square.paste(
        crop,
        ((square_size - bounds.width) // 2, (square_size - bounds.height) // 2),
    )

    target_size = cell.width - (padding * 2)
    if target_size <= 0:
        raise ValueError(f"padding {padding} leaves no drawable area in {cell.width}px cell")

    if square_size != target_size:
        square = square.resize((target_size, target_size), Image.Resampling.LANCZOS)

    normalized.paste(square, ((cell.width - target_size) // 2, (cell.height - target_size) // 2), square)
    return normalized


def normalize_sheet(path: Path, grid: int, padding: int, threshold: int, bleed: int) -> None:
    image = Image.open(path).convert("RGBA")
    width, height = image.size
    if width != height:
        raise ValueError(f"{path}: expected a square sheet, got {width}x{height}")
    if width % grid != 0:
        raise ValueError(f"{path}: {width}px is not divisible by {grid} grid cells")

    cell_size = width // grid
    if padding * 2 >= cell_size:
        raise ValueError(f"{path}: padding {padding}px is too large for {cell_size}px cells")

    output = Image.new("RGBA", image.size, (0, 0, 0, 0))
    for row in range(grid):
        for col in range(grid):
            left = col * cell_size
            top = row * cell_size
            cell = image.crop((left, top, left + cell_size, top + cell_size))
            output.paste(
                normalize_cell(cell, padding=padding, threshold=threshold, bleed=bleed),
                (left, top),
            )

    tmp_path = path.with_name(f"{path.stem}.tmp{path.suffix}")
    output.save(tmp_path, optimize=True)
    tmp_path.replace(path)
    print(f"normalized {path} ({width}x{height}, grid={grid}, cell={cell_size}, padding={padding})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sheets", nargs="+", type=Path, help="Transparent sprite sheet PNGs to normalize")
    parser.add_argument("--grid", type=int, default=5, help="number of cells per row/column")
    parser.add_argument("--padding", type=int, default=12, help="transparent padding to keep around each icon")
    parser.add_argument("--alpha-threshold", type=int, default=8, help="alpha threshold used when detecting bounds")
    parser.add_argument("--bleed", type=int, default=1, help="pixels to expand detected bounds before squaring")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    for sheet in args.sheets:
        normalize_sheet(
            sheet,
            grid=args.grid,
            padding=args.padding,
            threshold=args.alpha_threshold,
            bleed=args.bleed,
        )


if __name__ == "__main__":
    main()
