#!/usr/bin/env python3
"""Vectorize the generated 5x5 UI icon sheet into per-icon SVGs.

The source artwork uses a chroma-green background. This script:

1. Splits the source sheet into a 5x5 grid, allowing for non-divisible source
   dimensions.
2. Removes the green background.
3. Detects true alpha bounds per icon.
4. Centers each icon on a square transparent canvas with a fixed safe padding.
5. Writes normalized PNG cells and colour-traced SVGs.
6. Rebuilds the 640x640 CSS sprite sheet from the normalized cells.

The rebuilt sheet keeps the same 5x5 layout and CSS background-position mapping.
The per-icon SVGs are meant to be manually tweakable if a later pass needs
hand-polishing.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - only exercised on misconfigured machines.
    raise SystemExit("Pillow is required. Install it with: python -m pip install Pillow") from exc

try:
    import vtracer
except ImportError as exc:  # pragma: no cover - only exercised on misconfigured machines.
    raise SystemExit("vtracer is required. Install it with: python -m pip install vtracer") from exc

try:
    import cv2
except ImportError as exc:  # pragma: no cover - only exercised on misconfigured machines.
    raise SystemExit("OpenCV is required. Install it with: python -m pip install opencv-python") from exc


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


def grid_edges(size: int, grid: int) -> list[int]:
    """Return rounded grid edges for source sheets not divisible by grid."""
    return [round(i * size / grid) for i in range(grid + 1)]


def _rgb_to_hsv_arrays(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vectorized RGB->HSV. rgb is float32 0..1, returns hue 0..360, sat 0..1, val 0..1."""
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    cmax = np.maximum(np.maximum(r, g), b)
    cmin = np.minimum(np.minimum(r, g), b)
    delta = cmax - cmin

    hue = np.zeros_like(cmax)
    nonzero = delta > 1e-6
    rmax = (cmax == r) & nonzero
    gmax = (cmax == g) & nonzero & ~rmax
    bmax = nonzero & ~rmax & ~gmax
    safe_delta = np.where(nonzero, delta, 1.0)
    hue[rmax] = (60.0 * ((g[rmax] - b[rmax]) / safe_delta[rmax])) % 360.0
    hue[gmax] = 60.0 * ((b[gmax] - r[gmax]) / safe_delta[gmax]) + 120.0
    hue[bmax] = 60.0 * ((r[bmax] - g[bmax]) / safe_delta[bmax]) + 240.0

    sat = np.where(cmax > 1e-6, delta / np.where(cmax > 1e-6, cmax, 1.0), 0.0)
    val = cmax
    return hue, sat, val


def remove_green_background(cell: Image.Image) -> Image.Image:
    """Erase the chroma-green backdrop without eating dark navy outlines.

    The generated sheet places cream/navy icons over a saturated green plane.
    A naive g-dominance check kills antialiased edge pixels that are still
    "green-leaning" but actually form the visible navy stroke, flattening the
    icons into cream silhouettes. Detect green via hue + saturation in HSV
    instead so that navy hues (~210-240) survive even when their AA edge
    pixel happens to look greenish in RGB.
    """
    rgba = np.array(cell.convert("RGBA"), dtype=np.uint8)
    rgb = rgba[:, :, :3].astype(np.float32) / 255.0
    hue, sat, val = _rgb_to_hsv_arrays(rgb)

    green_hue = (hue >= 80.0) & (hue <= 165.0)
    saturated = sat >= 0.45
    bright_enough = val >= 0.18
    green_bg = green_hue & saturated & bright_enough

    rgba[green_bg, 3] = 0
    rgba[green_bg, 0:3] = 0

    # Neutralize lingering green chroma in surviving pixels (e.g. soft halos
    # along navy outlines) so vector tracing does not emit small green paths.
    alive = rgba[:, :, 3] > 0
    r = rgba[:, :, 0].astype(np.int16)
    g = rgba[:, :, 1].astype(np.int16)
    b = rgba[:, :, 2].astype(np.int16)
    max_rb = np.maximum(r, b)
    green_fringe = alive & (g > max_rb + 14)
    rgba[green_fringe, 1] = np.maximum(max_rb[green_fringe], 0).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def matte_rgb_before_resize(image: Image.Image, matte=(248, 246, 225)) -> Image.Image:
    """Avoid transparent-black halos when resizing RGBA artwork.

    Resizing antialiases transparent pixels with neighbouring colour values. If
    transparent pixels contain black RGB, the result gets dirty dark fringes.
    Fill fully transparent RGB with a light matte before resizing while keeping
    alpha unchanged.
    """
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    transparent = rgba[:, :, 3] == 0
    rgba[transparent, 0] = matte[0]
    rgba[transparent, 1] = matte[1]
    rgba[transparent, 2] = matte[2]
    return Image.fromarray(rgba, "RGBA")


def remove_small_alpha_components(image: Image.Image, min_area: int) -> Image.Image:
    """Remove isolated transparent-mask components before tracing."""
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    alpha_mask = (rgba[:, :, 3] > 8).astype(np.uint8)
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(alpha_mask, connectivity=8)
    keep = np.zeros(alpha_mask.shape, dtype=bool)
    for label in range(1, component_count):
        if stats[label, cv2.CC_STAT_AREA] >= min_area:
            keep |= labels == label
    rgba[~keep, 3] = 0
    rgba[~keep, 0:3] = 0
    return Image.fromarray(rgba, "RGBA")


def keep_main_blob_neighborhood(image: Image.Image, margin_ratio: float = 0.30) -> Image.Image:
    """Drop components that look like cross-cell bleed-through.

    Source sheet rows/columns aren't perfectly aligned, so each cell crop can
    include a thin strip of a neighbouring icon. Those strips have a clear
    signature: they touch a cell edge AND sit entirely above/below/beside
    the main icon (no bbox overlap on the perpendicular axis). This filter:

    * Anchors on the largest component (the icon body).
    * Drops any component whose bbox is entirely outside an expanded ROI
      (``margin_ratio`` of the main's longest side) — far-away noise.
    * Additionally drops components that touch a cell border on an axis
      where they don't overlap the main bbox at all — classic row/column
      bleed-through.
    """
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    alpha_mask = (rgba[:, :, 3] > 8).astype(np.uint8)
    height, width = alpha_mask.shape
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(alpha_mask, connectivity=8)
    if component_count <= 1:
        return image

    areas = stats[1:, cv2.CC_STAT_AREA]
    main_label = 1 + int(np.argmax(areas))
    mx = int(stats[main_label, cv2.CC_STAT_LEFT])
    my = int(stats[main_label, cv2.CC_STAT_TOP])
    mw = int(stats[main_label, cv2.CC_STAT_WIDTH])
    mh = int(stats[main_label, cv2.CC_STAT_HEIGHT])
    margin = int(max(mw, mh) * margin_ratio)
    roi_l, roi_t = mx - margin, my - margin
    roi_r, roi_b = mx + mw + margin, my + mh + margin

    keep = np.zeros(alpha_mask.shape, dtype=bool)
    for label in range(1, component_count):
        if label == main_label:
            keep |= labels == main_label
            continue
        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        w = int(stats[label, cv2.CC_STAT_WIDTH])
        h = int(stats[label, cv2.CC_STAT_HEIGHT])

        in_roi = (x + w >= roi_l) and (x <= roi_r) and (y + h >= roi_t) and (y <= roi_b)
        if not in_roi:
            continue

        h_overlap = max(0, min(x + w, mx + mw) - max(x, mx))
        v_overlap = max(0, min(y + h, my + mh) - max(y, my))
        touches_top = y <= 0
        touches_bottom = y + h >= height - 1
        touches_left = x <= 0
        touches_right = x + w >= width - 1

        # Bleed-through signature: a component touching a cell edge but with
        # zero overlap with the main blob along the perpendicular axis.
        if (touches_top or touches_bottom) and v_overlap <= 0:
            continue
        if (touches_left or touches_right) and h_overlap <= 0:
            continue

        keep |= labels == label
    rgba[~keep, 3] = 0
    rgba[~keep, 0:3] = 0
    return Image.fromarray(rgba, "RGBA")


def alpha_bounds(image: Image.Image, threshold: int = 8, bleed: int = 2) -> Bounds | None:
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return Bounds(
        max(0, left - bleed),
        max(0, top - bleed),
        min(image.width, right + bleed),
        min(image.height, bottom + bleed),
    )


def normalize_icon(cell: Image.Image, canvas_size: int, padding: int, min_component_area: int) -> Image.Image:
    cleaned = remove_small_alpha_components(remove_green_background(cell), min_area=min_component_area)
    transparent = keep_main_blob_neighborhood(cleaned)
    bounds = alpha_bounds(transparent)
    output = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    if bounds is None:
        return output

    crop = transparent.crop((bounds.left, bounds.top, bounds.right, bounds.bottom))
    square_size = max(bounds.width, bounds.height)
    square = Image.new("RGBA", (square_size, square_size), (0, 0, 0, 0))
    square.paste(crop, ((square_size - bounds.width) // 2, (square_size - bounds.height) // 2), crop)

    target = canvas_size - padding * 2
    if target <= 0:
        raise ValueError("padding leaves no drawable area")
    square = matte_rgb_before_resize(square).resize((target, target), Image.Resampling.LANCZOS)
    output.paste(square, ((canvas_size - target) // 2, (canvas_size - target) // 2), square)
    return output


def trace_svg(input_png: Path, output_svg: Path, canvas_size: int) -> None:
    # Tighter settings for crisp icon-style art with a small palette
    # (cream / navy / occasional grey/blue accent). Larger speckle filter
    # removes lonely AA pixels; lower path precision keeps SVGs small.
    vtracer.convert_image_to_svg_py(
        str(input_png),
        str(output_svg),
        colormode="color",
        hierarchical="stacked",
        mode="spline",
        filter_speckle=6,
        color_precision=5,
        layer_difference=24,
        corner_threshold=70,
        length_threshold=4.0,
        max_iterations=10,
        splice_threshold=45,
        path_precision=2,
    )
    _add_viewbox(output_svg, canvas_size)


def _add_viewbox(svg_path: Path, canvas_size: int) -> None:
    """Inject viewBox + preserveAspectRatio so the SVG scales cleanly in <img>."""
    text = svg_path.read_text(encoding="utf-8")
    if "viewBox=" in text:
        return
    needle = f'width="{canvas_size}" height="{canvas_size}"'
    replacement = (
        f'width="{canvas_size}" height="{canvas_size}" '
        f'viewBox="0 0 {canvas_size} {canvas_size}" '
        f'preserveAspectRatio="xMidYMid meet"'
    )
    if needle not in text:
        return
    svg_path.write_text(text.replace(needle, replacement, 1), encoding="utf-8")


def optimize_svgs_with_svgo(svg_dir: Path) -> bool:
    """Run svgo on the directory, halving file sizes without visible quality loss.

    Uses ``npx --yes svgo`` so the script works on any machine with Node.js
    installed without requiring a global svgo install. Returns True if svgo
    was found and ran successfully, False otherwise (callers should treat the
    optimization step as best-effort).
    """
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if npx is None:
        print("svgo skipped: npx not available on PATH")
        return False
    try:
        result = subprocess.run(
            [npx, "--yes", "svgo", "--multipass", "--precision=2", "-q", "-f", str(svg_dir)],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        print(f"svgo skipped: {exc}")
        return False
    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip()
        print(f"svgo failed (code {result.returncode}): {stderr[:200]}")
        return False
    print(f"svgo optimized {svg_dir}")
    return True


def vectorize_sheet(
    source: Path,
    source_copy: Path,
    png_dir: Path,
    svg_dir: Path,
    sprite_path: Path,
    grid: int,
    canvas_size: int,
    padding: int,
    min_component_area: int,
) -> None:
    png_dir.mkdir(parents=True, exist_ok=True)
    svg_dir.mkdir(parents=True, exist_ok=True)
    source_copy.parent.mkdir(parents=True, exist_ok=True)
    sprite_path.parent.mkdir(parents=True, exist_ok=True)

    if source.resolve() != source_copy.resolve():
        shutil.copyfile(source, source_copy)

    sheet = Image.open(source).convert("RGBA")
    x_edges = grid_edges(sheet.width, grid)
    y_edges = grid_edges(sheet.height, grid)
    sprite = Image.new("RGBA", (grid * canvas_size, grid * canvas_size), (0, 0, 0, 0))

    for index, name in enumerate(ICON_NAMES):
        row, col = divmod(index, grid)
        cell = sheet.crop((x_edges[col], y_edges[row], x_edges[col + 1], y_edges[row + 1]))
        normalized = normalize_icon(
            cell,
            canvas_size=canvas_size,
            padding=padding,
            min_component_area=min_component_area,
        )

        png_path = png_dir / f"{index:02d}-{name}.png"
        svg_path = svg_dir / f"{index:02d}-{name}.svg"
        normalized.save(png_path, optimize=True)
        trace_svg(png_path, svg_path, canvas_size)
        sprite.paste(normalized, (col * canvas_size, row * canvas_size), normalized)

    tmp_sprite = sprite_path.with_name(f"{sprite_path.stem}.tmp{sprite_path.suffix}")
    sprite.save(tmp_sprite, optimize=True)
    tmp_sprite.replace(sprite_path)
    print(f"wrote {sprite_path} ({sprite.width}x{sprite.height})")
    print(f"wrote {len(ICON_NAMES)} normalized PNGs to {png_dir}")
    print(f"wrote {len(ICON_NAMES)} SVGs to {svg_dir}")
    optimize_svgs_with_svgo(svg_dir)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="generated 5x5 green-background source PNG")
    parser.add_argument("--source-copy", type=Path, default=Path("assets/ui-icons/alpine-ui-icons-source.png"))
    parser.add_argument("--png-dir", type=Path, default=Path("assets/ui-icons/normalized-png"))
    parser.add_argument("--svg-dir", type=Path, default=Path("assets/ui-icons/svg"))
    parser.add_argument("--sprite", type=Path, default=Path("assets/ui-icons/alpine-ui-icons.png"))
    parser.add_argument("--grid", type=int, default=5)
    parser.add_argument("--canvas-size", type=int, default=128)
    parser.add_argument("--padding", type=int, default=12)
    parser.add_argument(
        "--min-component-area",
        type=int,
        default=18,
        help="minimum connected alpha component area kept before tracing",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    vectorize_sheet(
        source=args.source,
        source_copy=args.source_copy,
        png_dir=args.png_dir,
        svg_dir=args.svg_dir,
        sprite_path=args.sprite,
        grid=args.grid,
        canvas_size=args.canvas_size,
        padding=args.padding,
        min_component_area=args.min_component_area,
    )


if __name__ == "__main__":
    main()
