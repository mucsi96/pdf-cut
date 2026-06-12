#!/usr/bin/env python3
"""Generate a synthetic scanned-book test PDF that exhibits every defect the
pipeline must fix: 2-up landscape spreads, slight rotation, dark scanner
residue at the edges, and black punch holes overlapping text near the gutter.

Usage: python3 make_fixture.py [output.pdf]
"""
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

DPI = 600
# Two A6-ish pages side by side: 210 x 148 mm spread.
W, H = 4960, 3496

WORDS = ("Mister Micro dreht den Kopf und reibt sich die Augen. Es sieht so aus als ob "
         "wir zusammenarbeiten muessen wenn wir etwas ueber dieses Schiff herausfinden "
         "wollen sonst kommen wir nie zurueck nach Hause. ").split()


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def draw_text_page(draw, x0, page_num, seed, ink=0):
    rng = np.random.default_rng(seed)
    y = 320
    draw.text((x0 + 1100, 140), str(page_num), font=font(70), fill=ink)
    draw.line((x0 + 220, 260, x0 + 2150, 260), fill=ink, width=6)
    while y < H - 400:
        n = int(rng.integers(6, 10))
        line = " ".join(WORDS[int(rng.integers(0, len(WORDS) - 1))] for _ in range(n))
        draw.text((x0 + 240, y), line[:60], font=font(64), fill=ink)
        y += 110
    # A halftone-ish illustration block on some pages.
    if page_num % 3 == 0:
        gx0, gy0 = x0 + 400, H - 1400
        for yy in range(0, 800, 8):
            for xx in range(0, 1600, 8):
                v = int(120 + 100 * np.sin(xx / 60.0) * np.cos(yy / 45.0))
                draw.rectangle((gx0 + xx, gy0 + yy, gx0 + xx + 7, gy0 + yy + 7), fill=v)


def make_spread(left_page, angle_deg, seed, right_ink=0):
    img = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(img)
    draw_text_page(draw, 0, left_page, seed)
    # right_ink simulates a faintly printed page (light-gray text).
    draw_text_page(draw, W // 2, left_page + 1, seed + 1, ink=right_ink)
    # Punch holes: top-margin pair like a hanging-file punched book (one per
    # page, overlapping the header area), plus a pair at the gutter.
    for cx in (int(W * 0.37), int(W * 0.63)):
        cy = int(H * 0.06)
        draw.ellipse((cx - 72, cy - 72, cx + 72, cy + 72), fill=10)
    cy = H // 2
    draw.ellipse((W // 2 - 220, cy - 72, W // 2 - 76, cy + 72), fill=10)
    draw.ellipse((W // 2 + 80, cy + 180 - 72, W // 2 + 224, cy + 180 + 72), fill=10)
    # Slight rotation (the defect deskew must fix).
    img = img.rotate(angle_deg, resample=Image.BICUBIC, fillcolor=255)
    # Scanner residue: dark fuzzy strips on the outer edges + corner blob.
    arr = np.array(img, dtype=np.int16)
    rng = np.random.default_rng(seed)
    edge = rng.integers(0, 90, size=(H, 60))
    arr[:, :60] = np.minimum(arr[:, :60], edge)
    arr[:, -45:] = np.minimum(arr[:, -45:], rng.integers(0, 70, size=(H, 45)))
    arr[-35:, :] = np.minimum(arr[-35:, :], rng.integers(0, 60, size=(35, W)))
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def make_cover():
    img = Image.new("L", (W, H), 30)
    draw = ImageDraw.Draw(img)
    draw.rectangle((150, 150, W - 150, H - 150), outline=200, width=12)
    draw.text((W - 2100, 400), "Spectrum", font=font(220), fill=230)
    draw.text((W - 2100, 700), "BASIC-Abenteuer Band 1", font=font(90), fill=210)
    draw.text((400, 500), "mister micro", font=font(110), fill=220)
    draw.text((400, 900), "Der fremde Planet", font=font(95), fill=215)
    draw.rectangle((W // 2 - 60, 150, W // 2 + 60, H - 150), fill=80)
    return img


def main():
    out_pdf = sys.argv[1] if len(sys.argv) > 1 else "input/test.pdf"
    os.makedirs(os.path.dirname(out_pdf) or ".", exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        files = []
        pages = [make_cover(), make_spread(2, 0.6, 1), make_spread(4, -0.8, 2, right_ink=170), make_spread(6, 0.35, 3)]
        for i, page in enumerate(pages, 1):
            f = os.path.join(tmp, f"fixture-{i:02d}.png")
            page.save(f, dpi=(DPI, DPI))
            files.append(f)
        subprocess.run(["img2pdf", *files, "-o", out_pdf], check=True)
    print(f"wrote {out_pdf} ({len(files)} pages, {W}x{H} @ {DPI} DPI)")


if __name__ == "__main__":
    main()
