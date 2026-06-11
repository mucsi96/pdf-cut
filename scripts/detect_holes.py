#!/usr/bin/env python3
"""Detect filing punch holes on deskewed pages and emit LaMa inpainting masks.

Holes are solid black discs (~6 mm) near the gutter edge; the split can clip
them, so circularity is relaxed for blobs touching the inner edge. Output per
page with detections: mask-page-NNNN.png (white dilated discs on black,
iopaint convention) + entry in holes.json. Debug overlays show the search
region (green), accepted holes (red) and rejected candidates (yellow, with
the rejection reason) — tune thresholds off these.
"""
import argparse
import json
import math
import os

import cv2
import numpy as np
from PIL import Image

DS = 4  # detection downsample factor


def page_is_left(page_id):
    """Even book pages are left pages (verso) → gutter on the RIGHT side."""
    return int(page_id) % 2 == 0


def detect(gray, page_id, p, dpi):
    h, w = gray.shape
    small = cv2.resize(gray, None, fx=1.0 / DS, fy=1.0 / DS, interpolation=cv2.INTER_AREA)
    sh, sw = small.shape

    dark = (small < p["darkThreshold"]).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, kernel)

    min_r = p["minDiamMm"] / 25.4 * dpi / 2.0 / DS
    max_r = p["maxDiamMm"] / 25.4 * dpi / 2.0 / DS

    inner_frac = p["searchInnerWidthFrac"]
    if page_is_left(page_id):
        region = (sw * (1.0 - inner_frac), 0, sw, sh)  # right strip
    else:
        region = (0, 0, sw * inner_frac, sh)  # left strip

    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    accepted, rejected = [], []
    for c in contours:
        area = cv2.contourArea(c)
        if area < math.pi * min_r * min_r * 0.25:
            continue  # far too small to even report
        m = cv2.moments(c)
        if m["m00"] == 0:
            continue
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        r_eq = math.sqrt(area / math.pi)
        perim = cv2.arcLength(c, True)
        circularity = 4 * math.pi * area / (perim * perim) if perim > 0 else 0
        x, y, bw, bh = cv2.boundingRect(c)
        touches_inner = (x == 0 and not page_is_left(page_id)) or (x + bw >= sw and page_is_left(page_id))
        circ_min = p["edgeCircularityMin"] if touches_inner else p["circularityMin"]

        cand = {"cx": cx * DS, "cy": cy * DS, "r": r_eq * DS, "circularity": round(circularity, 3)}
        if not (region[0] <= cx <= region[2] and region[1] <= cy <= region[3]):
            cand["reason"] = "outside search region"
            rejected.append(cand)
        elif r_eq < min_r:
            cand["reason"] = f"too small (r={r_eq * DS:.0f}px < {min_r * DS:.0f}px)"
            rejected.append(cand)
        elif r_eq > max_r:
            cand["reason"] = f"too large (r={r_eq * DS:.0f}px > {max_r * DS:.0f}px)"
            rejected.append(cand)
        elif circularity < circ_min:
            cand["reason"] = f"not circular ({circularity:.2f} < {circ_min})"
            rejected.append(cand)
        else:
            accepted.append(cand)

    return accepted, rejected, region


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--debug-dir", required=True)
    ap.add_argument("--dpi", type=int, default=600)
    ap.add_argument("--params", required=True)
    args = ap.parse_args()
    p = json.loads(args.params)

    pages = sorted(f for f in os.listdir(args.input_dir) if f.startswith("page-") and f.endswith(".png"))
    holes_all, rejected_all = {}, {}
    for fname in pages:
        page_id = fname[5:9]
        gray = cv2.imread(os.path.join(args.input_dir, fname), cv2.IMREAD_GRAYSCALE)
        h, w = gray.shape

        accepted, rejected, region = detect(gray, page_id, p, args.dpi)
        if accepted:
            holes_all[page_id] = accepted
        if rejected:
            rejected_all[page_id] = rejected

        if accepted:
            mask = np.zeros((h, w), np.uint8)
            for hole in accepted:
                radius = int(round(hole["r"] + p["maskDilatePx"]))
                cv2.circle(mask, (int(hole["cx"]), int(hole["cy"])), radius, 255, -1)
            Image.fromarray(mask).save(os.path.join(args.output_dir, f"mask-page-{page_id}.png"))

        # Debug overlay.
        vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        rx0, ry0, rx1, ry1 = [int(v * DS) for v in region]
        cv2.rectangle(vis, (rx0, ry0), (rx1 - 1, ry1 - 1), (0, 200, 0), 8)
        for hole in accepted:
            cv2.circle(vis, (int(hole["cx"]), int(hole["cy"])), int(hole["r"]), (0, 0, 255), 10)
            cv2.putText(vis, f"r={hole['r']:.0f} c={hole['circularity']}",
                        (int(hole["cx"]) + 30, int(hole["cy"])), cv2.FONT_HERSHEY_SIMPLEX, 2.5, (0, 0, 255), 6)
        for cand in rejected:
            cv2.circle(vis, (int(cand["cx"]), int(cand["cy"])), max(20, int(cand["r"])), (0, 220, 220), 6)
            cv2.putText(vis, cand["reason"], (int(cand["cx"]) + 30, int(cand["cy"]) + 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 220, 220), 5)
        scale = 1000.0 / w
        vis = cv2.resize(vis, (1000, int(h * scale)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(args.debug_dir, f"overlay-page-{page_id}.jpg"), vis,
                    [cv2.IMWRITE_JPEG_QUALITY, 80])
        print(f"detect-holes: page {page_id}: {len(accepted)} hole(s), {len(rejected)} rejected")

    with open(os.path.join(args.output_dir, "holes.json"), "w") as f:
        json.dump(holes_all, f, indent=2)
    with open(os.path.join(args.debug_dir, "rejected.json"), "w") as f:
        json.dump(rejected_all, f, indent=2)


if __name__ == "__main__":
    main()
