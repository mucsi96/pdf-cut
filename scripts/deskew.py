#!/usr/bin/env python3
"""Deskew book pages via projection-profile maximization.

Robust to ~0.05 deg: downsample, binarize, fuse words into text lines, then
sweep rotation angles and score the sharpness of the horizontal projection
profile. The full-resolution image is rotated exactly once (INTER_CUBIC).
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image


def projection_score(binary, angle):
    h, w = binary.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    rotated = cv2.warpAffine(binary, m, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
    profile = rotated.sum(axis=1).astype(np.float64)
    return float(np.var(profile))


def estimate_angle(gray, params):
    ds = params["downsample"]
    small = cv2.resize(gray, None, fx=1.0 / ds, fy=1.0 / ds, interpolation=cv2.INTER_AREA)
    # Threshold relative to the paper level rather than Otsu: on faintly
    # printed pages Otsu latches onto punch holes/edge residue and misses the
    # light-gray text entirely.
    hist = cv2.calcHist([small], [0], None, [256], [0, 256]).ravel()
    paper = int(np.argmax(hist[128:]) + 128)
    binary = (small < paper - params.get("contentDelta", 25)).astype(np.uint8)
    # Fuse characters into text lines so the profile has sharp peaks.
    binary = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 1)))
    # Drop tall components (illustrations, punch holes, gutter shadows): only
    # text lines should drive the projection profile.
    max_h = params.get("lineMaxHeightPx", 30)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    for i in range(1, n):
        if stats[i][3] > max_h:
            binary[labels == i] = 0

    max_angle = params["maxAngle"]
    coarse = params["coarseStep"]
    fine = params["fineStep"]

    angles = np.arange(-max_angle, max_angle + 1e-9, coarse)
    scores = [projection_score(binary, a) for a in angles]
    best = float(angles[int(np.argmax(scores))])

    fine_angles = np.arange(best - 0.3, best + 0.3 + 1e-9, fine)
    fine_scores = [projection_score(binary, a) for a in fine_angles]
    best_fine = float(fine_angles[int(np.argmax(fine_scores))])

    return best_fine, {
        "coarse": {f"{a:.2f}": s for a, s in zip(angles.tolist(), scores)},
        "fine": {f"{a:.2f}": s for a, s in zip(fine_angles.tolist(), fine_scores)},
    }


def save_png(arr, path, dpi):
    Image.fromarray(arr).save(path, dpi=(dpi, dpi))


def debug_overlay(rotated, angle, path):
    h, w = rotated.shape
    vis = cv2.cvtColor(rotated, cv2.COLOR_GRAY2BGR)
    for y in range(0, h, max(1, h // 12)):
        cv2.line(vis, (0, y), (w, y), (0, 200, 0), 3)
    cv2.putText(vis, f"angle: {angle:+.2f} deg", (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 4, (0, 0, 255), 10)
    scale = 1000.0 / w
    vis = cv2.resize(vis, (1000, int(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(path, vis, [cv2.IMWRITE_JPEG_QUALITY, 80])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--debug-dir", required=True)
    ap.add_argument("--dpi", type=int, default=600)
    ap.add_argument("--params", required=True)
    args = ap.parse_args()
    params = json.loads(args.params)
    overrides = params.get("overrides") or {}

    pages = sorted(f for f in os.listdir(args.input_dir) if f.startswith("page-") and f.endswith(".png"))
    if not pages:
        print("deskew: no pages found in input dir", file=sys.stderr)
        sys.exit(1)

    all_angles = {}
    for fname in pages:
        page_id = fname[5:9]
        gray = cv2.imread(os.path.join(args.input_dir, fname), cv2.IMREAD_GRAYSCALE)

        if page_id in overrides:
            angle = float(overrides[page_id])
            sweep = None
            print(f"deskew: page {page_id} angle {angle:+.2f} (override)")
        else:
            angle, sweep = estimate_angle(gray, params)
            print(f"deskew: page {page_id} angle {angle:+.2f}")

        h, w = gray.shape
        if abs(angle) < 1e-4:
            rotated = gray
        else:
            m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
            rotated = cv2.warpAffine(gray, m, (w, h), flags=cv2.INTER_CUBIC,
                                     borderMode=cv2.BORDER_CONSTANT, borderValue=255)

        save_png(rotated, os.path.join(args.output_dir, fname), args.dpi)
        debug_overlay(rotated, angle, os.path.join(args.debug_dir, f"grid-page-{page_id}.jpg"))
        all_angles[page_id] = {"angle": angle, "override": page_id in overrides}
        if sweep:
            all_angles[page_id]["bestCoarseScore"] = max(sweep["coarse"].values())

    with open(os.path.join(args.debug_dir, "angles.json"), "w") as f:
        json.dump(all_angles, f, indent=2)


if __name__ == "__main__":
    main()
