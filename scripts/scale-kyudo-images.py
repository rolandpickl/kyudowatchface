#!/usr/bin/env python3
"""
Scale kyudo-*.png for gabbro: cover + center-crop to OUT_W×OUT_H.

Smaller than full 260×260 to reduce decoded bitmap RAM — the PebbleBitmap runtime
keeps weak-cached decodes per resource id; six full-screen frames can OOM the heap.

PNG decode in gbitmap_png.c allocates extra working memory on top of the final bitmap;
if you see "PNG memory allocation failed" in logs, lower OUT_W/OUT_H and re-run.

After scaling, images are quantized to PALETTE_COLORS (default 256) when Pillow is
installed (`pip install pillow`). That yields indexed PNGs — smaller on disk and
typically cheaper for the watch to decode than full RGBA.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

# Gabbro display is 260×260; use a smaller decode size and center the bitmap in draw().
# 200×200 was still hitting PNG decode OOM on the emulator; 144×144 is ~52% the pixels.
OUT_W = 144
OUT_H = 144

# Indexed PNG (8-bit palette). Set to 0 to skip quantization even if Pillow is installed.
PALETTE_COLORS = 256

_warned_pillow = False

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IMAGES_DIR = os.path.abspath(os.path.join(ROOT, "..", "images"))
OUT_DIR = os.path.join(ROOT, "resources", "img")


def sips_size(path: str) -> tuple[int, int]:
    out = subprocess.check_output(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
        text=True,
    )
    w = h = 0
    for line in out.splitlines():
        if "pixelWidth" in line:
            w = int(line.split(":")[1].strip())
        if "pixelHeight" in line:
            h = int(line.split(":")[1].strip())
    return w, h


def indices_from_dir(dirpath: str) -> list[int]:
    if not os.path.isdir(dirpath):
        return []
    found: list[int] = []
    for name in os.listdir(dirpath):
        m = re.match(r"kyudo-(\d+)\.png$", name, re.I)
        if m:
            found.append(int(m.group(1)))
    return sorted(found)


def choose_input_dir() -> tuple[str, list[int]]:
    """Prefer project images/ when it contains any kyudo PNGs."""
    a = indices_from_dir(IMAGES_DIR)
    if a:
        return IMAGES_DIR, a
    b = indices_from_dir(OUT_DIR)
    if b:
        return OUT_DIR, b
    return IMAGES_DIR, []


def scale_cover_crop(src: str, dst: str, tw: int, th: int) -> None:
    """Uniform scale until image covers tw×th, then center-crop."""
    w, h = sips_size(src)
    scale = max(tw / w, th / h)
    nw = max(1, int(w * scale))
    nh = max(1, int(h * scale))

    fd, scaled = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        subprocess.check_call(["sips", "-z", str(nh), str(nw), src, "--out", scaled])
        off_y = max(0, (nh - th) // 2)
        off_x = max(0, (nw - tw) // 2)
        subprocess.check_call(
            [
                "sips",
                "--cropOffset",
                str(off_y),
                str(off_x),
                "--cropToHeightWidth",
                str(th),
                str(tw),
                scaled,
                "--out",
                dst,
            ]
        )
    finally:
        try:
            os.unlink(scaled)
        except OSError:
            pass


def quantize_png(path: str, colors: int) -> bool:
    """
    Rewrite PNG as an indexed (palette) image. Returns True if Pillow ran, False if skipped.
    """
    global _warned_pillow
    if colors <= 0:
        return False
    try:
        from PIL import Image
    except ImportError:
        if not _warned_pillow:
            print(
                "Note: install Pillow (`pip install pillow`) to emit 256-color PNGs.",
                file=sys.stderr,
            )
            _warned_pillow = True
        return False

    im = Image.open(path)
    if im.mode == "P":
        return True

    if im.mode in ("RGBA", "LA"):
        rgba = im.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        rgb = bg
    elif im.mode == "RGB":
        rgb = im
    else:
        rgb = im.convert("RGB")

    paletted = rgb.quantize(colors=colors)
    paletted.save(path, format="PNG", optimize=True)
    return True


def main() -> int:
    src_dir, indices = choose_input_dir()
    if not indices:
        print(
            "No kyudo-*.png files found. Add them under:\n"
            f"  {IMAGES_DIR}\n"
            "(e.g. kyudo-0.png … kyudo-5.png) then run this script again.",
            file=sys.stderr,
        )
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)

    for i in indices:
        src = os.path.join(src_dir, f"kyudo-{i}.png")
        if not os.path.isfile(src):
            print(f"Missing {src}", file=sys.stderr)
            return 1
        dst = os.path.join(OUT_DIR, f"kyudo-{i}.png")

        if os.path.abspath(src) == os.path.abspath(dst):
            fd, tmp_src = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            shutil.copy2(src, tmp_src)
            inp = tmp_src
        else:
            tmp_src = None
            inp = src

        try:
            scale_cover_crop(inp, dst, OUT_W, OUT_H)
        finally:
            if tmp_src:
                try:
                    os.unlink(tmp_src)
                except OSError:
                    pass

        q = ""
        if PALETTE_COLORS > 0 and quantize_png(dst, PALETTE_COLORS):
            q = f", {PALETTE_COLORS}-color palette"
        print(f"kyudo-{i}.png  ->  {OUT_W}×{OUT_H} (cover{q})")

    print(f"Wrote {len(indices)} file(s) to {OUT_DIR}")
    print(f"FRAME_COUNT={len(indices)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
