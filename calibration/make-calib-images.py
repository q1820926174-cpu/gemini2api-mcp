#!/usr/bin/env python3
"""Generate calibration images with exactly-known target centers.

Used to measure how a vision model reports pixel coordinates. Each image is a
dark canvas with high-contrast labeled circles/squares; the truth table is
printed to stdout so answers can be scored automatically.

Sizes cover 4:3 / 2:1 / 16:9 aspect ratios. Requires Pillow.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BASE = Path(__file__).resolve().parent

try:
    FONT = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)
except OSError:
    try:
        FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
    except OSError:
        FONT = ImageFont.load_default()

CIRCLE = "#00e0ff"
LABEL = "#ffe000"


def draw_circles(path, size, spots, radius=18):
    path = BASE / path
    img = Image.new("RGB", size, (32, 32, 32))
    d = ImageDraw.Draw(img)
    for label, x, y in spots:
        d.ellipse([x - radius, y - radius, x + radius, y + radius], outline=CIRCLE, width=3)
        bb = d.textbbox((0, 0), label, font=FONT)
        d.text((x - (bb[2] - bb[0]) / 2, y - (bb[3] - bb[1]) / 2 - bb[1]), label, fill=LABEL, font=FONT)
    img.save(path)
    return {label: [x, y] for label, x, y in spots}


def draw_squares(path, size, spots, half=16):
    path = BASE / path
    img = Image.new("RGB", size, (32, 32, 32))
    d = ImageDraw.Draw(img)
    for label, x, y in spots:
        d.rectangle([x - half, y - half, x + half, y + half], outline=CIRCLE, width=3)
        bb = d.textbbox((0, 0), label, font=FONT)
        d.text((x - (bb[2] - bb[0]) / 2, y - (bb[3] - bb[1]) / 2 - bb[1]), label, fill=LABEL, font=FONT)
    img.save(path)
    return {label: [x, y] for label, x, y in spots}


def draw_grid(path, size, rows=3, cols=3):
    path = BASE / path
    w, h = size
    img = Image.new("RGB", size, (32, 32, 32))
    d = ImageDraw.Draw(img)
    truth = {}
    for r in range(rows):
        for c in range(cols):
            x, y = int((c + 0.5) * w / cols), int((r + 0.5) * h / rows)
            label = str(r * cols + c + 1)
            d.rectangle([x - 45, y - 45, x + 45, y + 45], outline=CIRCLE, width=3)
            bb = d.textbbox((0, 0), label, font=FONT)
            d.text((x - (bb[2] - bb[0]) / 2, y - (bb[3] - bb[1]) / 2 - bb[1]), label, fill=LABEL, font=FONT)
            truth[label] = [x, y]
    img.save(path)
    return truth


def main():
    truth = {
        "images/circles-800x600.png": draw_circles("images/circles-800x600.png", (800, 600), [
            ("A", 100, 100), ("B", 700, 100), ("C", 100, 500), ("D", 700, 500),
            ("E", 400, 300), ("F", 50, 300), ("G", 750, 300)]),
        "images/squares-1000x500.png": draw_squares("images/squares-1000x500.png", (1000, 500), [
            ("P", 97, 61), ("Q", 503, 249), ("R", 901, 439), ("S", 251, 451), ("T", 755, 55)]),
        "images/grid-1920x1080.png": draw_grid("images/grid-1920x1080.png", (1920, 1080)),
        "images/circles9-640x360.png": draw_circles("images/circles9-640x360.png", (640, 360), [
            ("H", 213, 50), ("I", 426, 50), ("J", 596, 50), ("K", 320, 175), ("L", 106, 175),
            ("M", 533, 175), ("N", 320, 310), ("O", 106, 310), ("P", 533, 310)]),
    }
    json.dump(truth, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
