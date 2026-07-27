#!/usr/bin/env python3
"""Build the Itinera v2 UI icon cells and runtime atlas.

The image generator produces eight 4x2 transparent source sheets. This tool
uses the checked-in manifest as the single source of truth, crops every source
cell, removes any residual chroma pixels, normalizes optical scale without
distorting aspect ratio, and writes the 63 128px runtime cells plus the 5x13
atlas consumed by CSS and WebGL.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = REPO_ROOT / "assets/ui-icons/icon-manifest.v2.json"
DEFAULT_CELLS_DIR = REPO_ROOT / "assets/ui-icons/normalized-png"
DEFAULT_ATLAS = REPO_ROOT / "assets/ui-icons/alpine-ui-icons.png"
DEFAULT_SOURCE_ATLAS = REPO_ROOT / "assets/ui-icons/alpine-ui-icons-source.png"
DEFAULT_RESERVE_DIR = REPO_ROOT / "assets/ui-icons/reserve"
DEFAULT_PREVIEW = REPO_ROOT / "docs/design/icon-system-v2-preview.png"
DEFAULT_REPORT = REPO_ROOT / "assets/ui-icons/icon-quality-report.v2.json"

ALPHA_BOUNDS_THRESHOLD = 16
INNER_SIZE = 104
MAGENTA_RED_MIN = 160
MAGENTA_BLUE_MIN = 130
MAGENTA_GREEN_MAX = 105


def flattened_pixels(image: Image.Image):
    getter = getattr(image, "get_flattened_data", None)
    return getter() if getter is not None else image.getdata()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    icons = manifest.get("icons", [])
    atlas = manifest.get("atlas", {})
    source = manifest.get("sourceSheets", {})
    capacity = int(atlas["columns"]) * int(atlas["rows"])

    if len(icons) != 63:
        raise ValueError(f"manifest must define exactly 63 runtime icons, found {len(icons)}")
    if capacity < len(icons):
        raise ValueError(f"atlas capacity {capacity} is smaller than {len(icons)} icons")
    if [entry["index"] for entry in icons] != list(range(len(icons))):
        raise ValueError("manifest icon indices must be contiguous and sorted from 0")
    ids = [entry["id"] for entry in icons]
    if len(ids) != len(set(ids)):
        raise ValueError("manifest icon ids must be unique")

    source_capacity = int(source["columns"]) * int(source["rows"])
    for entry in icons:
        if not 0 <= int(entry["cell"]) < source_capacity:
            raise ValueError(f"{entry['id']} source cell is outside the source-sheet grid")
    reserve = manifest.get("reserve")
    if reserve and not 0 <= int(reserve["cell"]) < source_capacity:
        raise ValueError("reserve source cell is outside the source-sheet grid")
    return manifest


def projection_runs(values: list[int], minimum: int = 5) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate([*values, 0]):
        if value >= minimum and start is None:
            start = index
        elif value < minimum and start is not None:
            runs.append((start, index))
            start = None
    return runs


def merge_runs_to_count(
    runs: list[tuple[int, int]], expected: int
) -> list[tuple[int, int]]:
    merged = list(runs)
    while len(merged) > expected:
        gaps = [merged[index + 1][0] - merged[index][1] for index in range(len(merged) - 1)]
        merge_at = min(range(len(gaps)), key=gaps.__getitem__)
        merged[merge_at : merge_at + 2] = [
            (merged[merge_at][0], merged[merge_at + 1][1])
        ]
    if len(merged) != expected:
        raise ValueError(f"detected {len(merged)} content bands, expected {expected}")
    return merged


def detect_content_boxes(
    image: Image.Image, columns: int, rows: int, padding: int = 24
) -> list[tuple[int, int, int, int]]:
    """Find complete glyph bounds from transparent gaps between generated icons."""
    cleaned = remove_residual_chroma(image)
    alpha = cleaned.getchannel("A")
    pixels = alpha.load()
    y_projection = [
        sum(pixels[x, y] > ALPHA_BOUNDS_THRESHOLD for x in range(alpha.width))
        for y in range(alpha.height)
    ]
    row_runs = merge_runs_to_count(projection_runs(y_projection), rows)
    boxes: list[tuple[int, int, int, int]] = []

    for row_top, row_bottom in row_runs:
        x_projection = [
            sum(
                pixels[x, y] > ALPHA_BOUNDS_THRESHOLD
                for y in range(row_top, row_bottom)
            )
            for x in range(alpha.width)
        ]
        column_runs = merge_runs_to_count(projection_runs(x_projection), columns)
        for column_left, column_right in column_runs:
            search_box = (
                max(0, column_left - padding),
                max(0, row_top - padding),
                min(cleaned.width, column_right + padding),
                min(cleaned.height, row_bottom + padding),
            )
            search = cleaned.crop(search_box)
            left, top, right, bottom = alpha_bounds(search)
            boxes.append(
                (
                    max(0, search_box[0] + left - padding),
                    max(0, search_box[1] + top - padding),
                    min(cleaned.width, search_box[0] + right + padding),
                    min(cleaned.height, search_box[1] + bottom + padding),
                )
            )

    if len(boxes) != columns * rows:
        raise ValueError(f"detected {len(boxes)} content cells, expected {columns * rows}")
    return boxes


def source_crop_metrics(image: Image.Image) -> dict[str, Any]:
    alpha = image.getchannel("A")
    bounds = alpha.point(
        lambda value: 255 if value > ALPHA_BOUNDS_THRESHOLD else 0
    ).getbbox()
    if bounds is None:
        raise ValueError("source crop is empty")
    left, top, right, bottom = bounds
    margins = [left, top, image.width - right, image.height - bottom]
    edge_pixels = 0
    for x in range(image.width):
        edge_pixels += int(alpha.getpixel((x, 0)) > ALPHA_BOUNDS_THRESHOLD)
        edge_pixels += int(alpha.getpixel((x, image.height - 1)) > ALPHA_BOUNDS_THRESHOLD)
    for y in range(1, image.height - 1):
        edge_pixels += int(alpha.getpixel((0, y)) > ALPHA_BOUNDS_THRESHOLD)
        edge_pixels += int(alpha.getpixel((image.width - 1, y)) > ALPHA_BOUNDS_THRESHOLD)
    return {"sourceMargins": margins, "sourceEdgePixels": edge_pixels}

def remove_residual_chroma(image: Image.Image) -> Image.Image:
    """Remove magenta pixels that survived soft chroma-key extraction."""
    cleaned = image.copy().convert("RGBA")
    pixels = cleaned.load()
    for y in range(cleaned.height):
        for x in range(cleaned.width):
            red, green, blue, alpha = pixels[x, y]
            if (
                alpha
                and red >= MAGENTA_RED_MIN
                and blue >= MAGENTA_BLUE_MIN
                and green <= MAGENTA_GREEN_MAX
            ):
                pixels[x, y] = (0, 0, 0, 0)
            elif alpha <= 2:
                pixels[x, y] = (0, 0, 0, 0)
    return cleaned


def alpha_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    mask = image.getchannel("A").point(
        lambda value: 255 if value > ALPHA_BOUNDS_THRESHOLD else 0
    )
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError("source cell has no visible pixels")
    return bounds


def normalize_icon(source_cell: Image.Image, cell_size: int) -> Image.Image:
    cleaned = remove_residual_chroma(source_cell)
    left, top, right, bottom = alpha_bounds(cleaned)
    bleed = max(2, round(max(right - left, bottom - top) * 0.012))
    crop = cleaned.crop(
        (
            max(0, left - bleed),
            max(0, top - bleed),
            min(cleaned.width, right + bleed),
            min(cleaned.height, bottom + bleed),
        )
    )
    scale = min(INNER_SIZE / crop.width, INNER_SIZE / crop.height)
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    crop = crop.resize((width, height), Image.Resampling.LANCZOS)

    normalized = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
    x = (cell_size - width) // 2
    y = (cell_size - height) // 2
    normalized.alpha_composite(crop, (x, y))
    return remove_residual_chroma(normalized)


def icon_metrics(image: Image.Image) -> dict[str, Any]:
    alpha = image.getchannel("A")
    bounds = alpha.point(lambda value: 255 if value > 16 else 0).getbbox()
    if bounds is None:
        raise ValueError("normalized icon is empty")
    visible = sum(value > 16 for value in flattened_pixels(alpha))
    coverage = visible / (image.width * image.height)

    tiny_metrics: dict[str, Any] = {}
    for size in (12, 16, 24):
        tiny = image.resize((size, size), Image.Resampling.LANCZOS)
        tiny_alpha = tiny.getchannel("A")
        tiny_visible = sum(value > 24 for value in flattened_pixels(tiny_alpha))
        tiny_opaque = sum(value > 160 for value in flattened_pixels(tiny_alpha))
        tiny_metrics[str(size)] = {
            "visiblePixels": tiny_visible,
            "opaquePixels": tiny_opaque,
            "coverage": round(tiny_visible / (size * size), 4),
        }

    chroma_pixels = 0
    for red, green, blue, alpha_value in flattened_pixels(image):
        if (
            alpha_value > 16
            and red >= MAGENTA_RED_MIN
            and blue >= MAGENTA_BLUE_MIN
            and green <= MAGENTA_GREEN_MAX
        ):
            chroma_pixels += 1

    return {
        "coverage128": round(coverage, 4),
        "bounds128": list(bounds),
        "chromaPixels": chroma_pixels,
        "tiny": tiny_metrics,
    }


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)


def preview_font(size: int) -> ImageFont.ImageFont:
    for font_name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(font_name, size=size)
        except OSError:
            pass
    return ImageFont.load_default()


def build_preview(
    icons: list[tuple[dict[str, Any], Image.Image]],
    columns: int,
    rows: int,
    output: Path,
) -> None:
    tile_width = 224
    tile_height = 152
    preview = Image.new(
        "RGB",
        (columns * tile_width, rows * tile_height),
        (10, 18, 24),
    )
    draw = ImageDraw.Draw(preview)
    title_font = preview_font(14)
    meta_font = preview_font(11)

    for entry, icon in icons:
        row, column = divmod(int(entry["index"]), columns)
        x = column * tile_width
        y = row * tile_height
        draw.rounded_rectangle(
            (x + 5, y + 5, x + tile_width - 5, y + tile_height - 5),
            radius=14,
            fill=(17, 29, 37),
            outline=(47, 69, 80),
            width=1,
        )
        main = icon.resize((72, 72), Image.Resampling.LANCZOS)
        preview.paste(main.convert("RGB"), (x + 13, y + 12), main)
        tiny24 = icon.resize((24, 24), Image.Resampling.LANCZOS)
        tiny16 = icon.resize((16, 16), Image.Resampling.LANCZOS)
        tiny12 = icon.resize((12, 12), Image.Resampling.LANCZOS)
        preview.paste(tiny24.convert("RGB"), (x + 17, y + 101), tiny24)
        preview.paste(tiny16.convert("RGB"), (x + 53, y + 105), tiny16)
        preview.paste(tiny12.convert("RGB"), (x + 79, y + 107), tiny12)
        draw.text((x + 97, y + 17), entry["id"], font=title_font, fill=(239, 247, 249))
        draw.text(
            (x + 97, y + 43),
            f"{entry['family']} · #{entry['index']:02d}",
            font=meta_font,
            fill=(143, 169, 181),
        )
        draw.text((x + 15, y + 130), "24   16   12 px", font=meta_font, fill=(143, 169, 181))

    save_png(preview.convert("RGBA"), output)


def build(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest)
    atlas_config = manifest["atlas"]
    source_config = manifest["sourceSheets"]
    atlas_columns = int(atlas_config["columns"])
    atlas_rows = int(atlas_config["rows"])
    cell_size = int(atlas_config["cellSize"])
    source_columns = int(source_config["columns"])
    source_rows = int(source_config["rows"])
    source_dir = REPO_ROOT / source_config["directory"]

    source_cache: dict[str, Image.Image] = {}
    source_box_cache: dict[str, list[tuple[int, int, int, int]]] = {}
    source_hashes: dict[str, str] = {}
    normalized_icons: list[tuple[dict[str, Any], Image.Image]] = []
    quality_icons: list[dict[str, Any]] = []

    for entry in manifest["icons"]:
        sheet_name = entry["sheet"]
        source_path = source_dir / sheet_name
        if sheet_name not in source_cache:
            if not source_path.exists():
                raise FileNotFoundError(f"missing transparent source sheet: {source_path}")
            source_cache[sheet_name] = Image.open(source_path).convert("RGBA")
            source_box_cache[sheet_name] = detect_content_boxes(
                source_cache[sheet_name], source_columns, source_rows
            )
            source_hashes[sheet_name] = sha256(source_path)

        source_box = source_box_cache[sheet_name][int(entry["cell"])]
        source_cell = source_cache[sheet_name].crop(source_box).convert("RGBA")
        source_metrics = source_crop_metrics(source_cell)
        normalized = normalize_icon(source_cell, cell_size)
        normalized_path = args.cells_dir / f"{entry['index']:02d}-{entry['id']}.png"
        save_png(normalized, normalized_path)
        metrics = icon_metrics(normalized)
        metrics.update(
            {
                "index": int(entry["index"]),
                "id": entry["id"],
                "family": entry["family"],
                "sourceSheet": sheet_name,
                "sourceCell": int(entry["cell"]),
                "sourceCropBox": list(source_box),
                **source_metrics,
                "fileSha256": sha256(normalized_path),
            }
        )
        if metrics["sourceEdgePixels"]:
            raise ValueError(f"{entry['id']} touches its detected source crop edge")
        if min(metrics["sourceMargins"]) < 16:
            raise ValueError(f"{entry['id']} source crop has insufficient safety margin")
        if metrics["chromaPixels"]:
            raise ValueError(f"{entry['id']} retains {metrics['chromaPixels']} chroma pixels")
        if not 0.08 <= metrics["coverage128"] <= 0.62:
            raise ValueError(
                f"{entry['id']} coverage {metrics['coverage128']} is outside the readable range"
            )
        if metrics["tiny"]["12"]["opaquePixels"] < 8:
            raise ValueError(f"{entry['id']} is not sufficiently legible at 12px")
        normalized_icons.append((entry, normalized))
        quality_icons.append(metrics)

    atlas = Image.new(
        "RGBA",
        (atlas_columns * cell_size, atlas_rows * cell_size),
        (0, 0, 0, 0),
    )
    for entry, icon in normalized_icons:
        row, column = divmod(int(entry["index"]), atlas_columns)
        atlas.alpha_composite(icon, (column * cell_size, row * cell_size))
    save_png(atlas, args.atlas)
    save_png(atlas, args.source_atlas)

    reserve = manifest.get("reserve")
    if reserve:
        source_path = source_dir / reserve["sheet"]
        source_image = source_cache.get(reserve["sheet"])
        if source_image is None:
            source_image = Image.open(source_path).convert("RGBA")
            source_hashes[reserve["sheet"]] = sha256(source_path)
        reserve_boxes = source_box_cache.get(reserve["sheet"])
        if reserve_boxes is None:
            reserve_boxes = detect_content_boxes(source_image, source_columns, source_rows)
        reserve_cell = source_image.crop(
            reserve_boxes[int(reserve["cell"])]
        ).convert("RGBA")
        reserve_icon = normalize_icon(reserve_cell, cell_size)
        save_png(reserve_icon, args.reserve_dir / f"{reserve['id']}.png")

    build_preview(
        normalized_icons,
        columns=atlas_columns,
        rows=atlas_rows,
        output=args.preview,
    )

    report = {
        "manifestVersion": manifest["version"],
        "style": manifest["style"],
        "sourceHashes": source_hashes,
        "atlas": {
            "path": str(args.atlas.relative_to(REPO_ROOT)).replace("\\", "/"),
            "sha256": sha256(args.atlas),
            "width": atlas.width,
            "height": atlas.height,
            "cellSize": cell_size,
            "columns": atlas_columns,
            "rows": atlas_rows,
        },
        "icons": quality_icons,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        f"built {len(normalized_icons)} icons, {args.atlas.name}, "
        f"{args.preview.name}, and {args.report.name}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cells-dir", type=Path, default=DEFAULT_CELLS_DIR)
    parser.add_argument("--atlas", type=Path, default=DEFAULT_ATLAS)
    parser.add_argument("--source-atlas", type=Path, default=DEFAULT_SOURCE_ATLAS)
    parser.add_argument("--reserve-dir", type=Path, default=DEFAULT_RESERVE_DIR)
    parser.add_argument("--preview", type=Path, default=DEFAULT_PREVIEW)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


if __name__ == "__main__":
    build(parse_args())
