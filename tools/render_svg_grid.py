#!/usr/bin/env python3
"""Render the traced UI icons into a comparison grid for visual review.

For each icon emit a row showing the source 128x128 normalized PNG, then the
SVG rasterized at 64/32/18px (with 4x retina scale at 18px so a screenshot
preserves visible pixel detail).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


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


def render_svg(svg_path: Path, size: int, scale: int = 1) -> Image.Image:
    import cairosvg

    raw = cairosvg.svg2png(
        url=str(svg_path),
        output_width=size * scale,
        output_height=size * scale,
    )
    from io import BytesIO
    return Image.open(BytesIO(raw)).convert("RGBA")


def make_grid(
    png_dir: Path,
    svg_dir: Path,
    output: Path,
    sizes: list[int] = (128, 64, 32, 18),
) -> None:
    cell = 144
    cols = 1 + len(sizes)
    label_w = 200
    rows = len(ICON_NAMES)
    width = label_w + cols * cell
    height = rows * cell + 40
    canvas = Image.new("RGBA", (width, height), (14, 20, 24, 255))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("arial.ttf", 12)
        head = ImageFont.truetype("arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
        head = ImageFont.load_default()

    draw.text((label_w + 8, 8), "source PNG", fill=(120, 200, 255, 255), font=head)
    for i, size in enumerate(sizes):
        x = label_w + (i + 1) * cell + 8
        draw.text((x, 8), f"icon {size}px", fill=(120, 200, 255, 255), font=head)

    for r, name in enumerate(ICON_NAMES):
        y = 40 + r * cell
        draw.text((8, y + cell // 2 - 8), f"{r:02d} {name}", fill=(220, 230, 240, 255), font=font)
        png_path = png_dir / f"{r:02d}-{name}.png"
        svg_path = svg_dir / f"{r:02d}-{name}.svg"

        src = Image.open(png_path).convert("RGBA")
        ratio = min(128 / src.width, 128 / src.height)
        src_resized = src.resize((int(src.width * ratio), int(src.height * ratio)), Image.Resampling.LANCZOS)
        canvas.paste(src_resized, (label_w + (cell - src_resized.width) // 2, y + (cell - src_resized.height) // 2), src_resized)

        for ci, size in enumerate(sizes):
            scale = max(1, 128 // size) if size <= 32 else 1
            img = render_svg(svg_path, size, scale=scale) if svg_path.exists() else src.resize(
                (size * scale, size * scale),
                Image.Resampling.LANCZOS,
            )
            x = label_w + (ci + 1) * cell + (cell - img.width) // 2
            yy = y + (cell - img.height) // 2
            canvas.paste(img, (x, yy), img)

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, optimize=True)
    print(f"wrote {output} ({canvas.width}x{canvas.height})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--png-dir", type=Path, default=Path("assets/ui-icons/normalized-png"))
    parser.add_argument("--svg-dir", type=Path, default=Path("assets/ui-icons/svg"))
    parser.add_argument("--output", type=Path, default=Path("_svg_grid.png"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    make_grid(args.png_dir, args.svg_dir, args.output)


if __name__ == "__main__":
    main()
