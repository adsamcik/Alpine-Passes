#!/usr/bin/env python3
"""Render a single SVG at 18/32/64/128 px alongside its source PNG.

Used by per-icon polish subagents: they iterate on one SVG, run this script,
and view the resulting comparison strip to assess legibility at small sizes.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageFont


SIZES = [18, 32, 64, 128]


def _render_svg(svg_path: Path, size: int, scale: int = 1) -> Image.Image:
    raw = cairosvg.svg2png(
        url=str(svg_path),
        output_width=size * scale,
        output_height=size * scale,
    )
    return Image.open(BytesIO(raw)).convert("RGBA")


def render_strip(svg_path: Path, png_path: Path, output: Path, label: str) -> None:
    cell = 144
    cols = 1 + len(SIZES)
    width = cols * cell + 24
    height = cell + 80
    canvas = Image.new("RGBA", (width, height), (14, 20, 24, 255))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("arial.ttf", 12)
        head = ImageFont.truetype("arial.ttf", 16)
    except OSError:
        font = ImageFont.load_default()
        head = ImageFont.load_default()
    draw.text((12, 8), label, fill=(180, 220, 255, 255), font=head)

    src = Image.open(png_path).convert("RGBA")
    ratio = min(128 / src.width, 128 / src.height)
    src_resized = src.resize((int(src.width * ratio), int(src.height * ratio)), Image.Resampling.LANCZOS)
    src_x = 12 + (cell - src_resized.width) // 2
    src_y = 36 + (cell - src_resized.height) // 2
    canvas.paste(src_resized, (src_x, src_y), src_resized)
    draw.text((12, 36 + cell + 4), "source PNG (128)", fill=(140, 200, 255, 255), font=font)

    for i, size in enumerate(SIZES):
        scale = max(1, 128 // size) if size <= 64 else 1
        img = _render_svg(svg_path, size, scale=scale)
        x = 12 + (i + 1) * cell + (cell - img.width) // 2
        y = 36 + (cell - img.height) // 2
        canvas.paste(img, (x, y), img)
        draw.text(
            (12 + (i + 1) * cell, 36 + cell + 4),
            f"SVG @{size}px (shown {scale}x)" if scale > 1 else f"SVG @{size}px",
            fill=(140, 200, 255, 255),
            font=font,
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, optimize=True)
    print(f"wrote {output}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--svg", type=Path, required=True)
    parser.add_argument("--png", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", default="")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    label = args.label or args.svg.stem
    render_strip(args.svg, args.png, args.output, label)


if __name__ == "__main__":
    main()
