#!/usr/bin/env python3
"""Render a side-by-side comparison: source PNG vs GPT-5.5 SVG vs Opus 4.7 SVG.

Each row shows one icon, with source PNG, GPT-5.5 polish, and Opus 4.7 polish
each rendered at 18 / 32 / 64 / 128 px so the user can decide which polish set
they prefer per icon.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path

import cairosvg
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
]


def render_svg(svg_path: Path, size: int) -> Image.Image:
    raw = cairosvg.svg2png(url=str(svg_path), output_width=size, output_height=size)
    return Image.open(BytesIO(raw)).convert("RGBA")


def make_grid(
    png_dir: Path,
    gpt_dir: Path,
    opus_dir: Path,
    output: Path,
) -> None:
    cell = 100
    label_w = 180
    section_gap = 18
    sizes = [128, 32, 18]

    cols_per_section = len(sizes)
    sections = 3  # png, gpt, opus
    width = label_w + sections * (cols_per_section * cell + section_gap)
    rows = len(ICON_NAMES)
    header = 60
    height = header + rows * cell + 40

    canvas = Image.new("RGBA", (width, height), (12, 16, 22, 255))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("arial.ttf", 11)
        head = ImageFont.truetype("arial.ttf", 14)
        big = ImageFont.truetype("arial.ttf", 18)
    except OSError:
        font = head = big = ImageFont.load_default()

    section_titles = [("source PNG", (140, 200, 255)),
                      ("GPT-5.5", (220, 180, 100)),
                      ("Opus 4.7", (140, 240, 180))]

    for s, (title, color) in enumerate(section_titles):
        x0 = label_w + s * (cols_per_section * cell + section_gap)
        draw.rectangle([x0 - 4, 4, x0 + cols_per_section * cell, 28], fill=(20, 26, 32, 255))
        draw.text((x0 + 8, 8), title, fill=color + (255,), font=big)
        for i, sz in enumerate(sizes):
            sx = x0 + i * cell + 8
            draw.text((sx, 32), f"{sz}px", fill=(150, 170, 195, 255), font=font)

    for r, name in enumerate(ICON_NAMES):
        y = header + r * cell
        draw.text((8, y + cell // 2 - 6), f"{r:02d} {name}", fill=(225, 235, 245, 255), font=font)

        # Source PNG section
        src = Image.open(png_dir / f"{r:02d}-{name}.png").convert("RGBA")
        for i, sz in enumerate(sizes):
            ratio = min(sz / src.width, sz / src.height)
            scaled = src.resize((max(1, int(src.width * ratio)), max(1, int(src.height * ratio))), Image.Resampling.LANCZOS)
            cx = label_w + i * cell + (cell - scaled.width) // 2
            cy = y + (cell - scaled.height) // 2
            canvas.paste(scaled, (cx, cy), scaled)

        # GPT-5.5 section
        gpt_offset = label_w + cols_per_section * cell + section_gap
        gpt_svg = gpt_dir / f"{r:02d}-{name}.svg"
        for i, sz in enumerate(sizes):
            img = render_svg(gpt_svg, sz)
            cx = gpt_offset + i * cell + (cell - img.width) // 2
            cy = y + (cell - img.height) // 2
            canvas.paste(img, (cx, cy), img)

        # Opus 4.7 section
        opus_offset = label_w + 2 * (cols_per_section * cell + section_gap)
        opus_svg = opus_dir / f"{r:02d}-{name}.svg"
        for i, sz in enumerate(sizes):
            img = render_svg(opus_svg, sz)
            cx = opus_offset + i * cell + (cell - img.width) // 2
            cy = y + (cell - img.height) // 2
            canvas.paste(img, (cx, cy), img)

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, optimize=True)
    print(f"wrote {output} ({canvas.width}x{canvas.height})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--png-dir", type=Path, default=Path("assets/ui-icons/normalized-png"))
    parser.add_argument("--gpt-dir", type=Path, default=Path("_compare/svg-gpt55"))
    parser.add_argument("--opus-dir", type=Path, default=Path("assets/ui-icons/svg"))
    parser.add_argument("--output", type=Path, default=Path("_compare_grid.png"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    make_grid(args.png_dir, args.gpt_dir, args.opus_dir, args.output)


if __name__ == "__main__":
    main()
