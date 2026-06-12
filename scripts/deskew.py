#!/usr/bin/env python3
"""Deskew + dewarp book pages.

1. Global angle via projection-profile maximization over text-line shaped
   components (robust to ~0.05 deg).
2. Optional dewarp: paper curvature leaves individual lines wavy/tilted even
   after the global rotation. Text baselines are traced per line, a smooth
   global displacement field dy(x,y) is fitted, and rotation + dewarp are
   applied to the full-resolution image in ONE resampling pass (INTER_CUBIC),
   preserving print quality.
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


def line_components(small, params):
    """Binary image containing only text-line-shaped components.

    Threshold relative to the paper level (Otsu misses faint pages), fuse
    glyphs into lines, then keep wide flat components with consistent height
    and near-maximal width — illustrations (keyboard rows, screen edges) and
    punch holes must not outvote the text.
    """
    hist = cv2.calcHist([small], [0], None, [256], [0, 256]).ravel()
    paper = int(np.argmax(hist[128:]) + 128)
    binary = (small < paper - params.get("contentDelta", 25)).astype(np.uint8)
    binary = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 1)))

    max_h = params.get("lineMaxHeightPx", 30)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    comp_h = [stats[i][3] for i in range(1, n) if stats[i][3] <= max_h and stats[i][2] >= 2 * stats[i][3]]
    med_h = float(np.median(comp_h)) if comp_h else 0
    line_idx = []
    for i in range(1, n):
        bw, bh = stats[i][2], stats[i][3]
        line_like = (bh <= max_h and bw >= 2 * bh
                     and (med_h == 0 or 0.5 * med_h <= bh <= 2.0 * med_h))
        if line_like:
            line_idx.append(i)
        else:
            binary[labels == i] = 0
    if line_idx:
        widths = [stats[i][2] for i in line_idx]
        wide = float(np.percentile(widths, 90))
        min_w = params.get("lineMinWidthFrac", 0.5) * wide
        kept = [i for i in line_idx if stats[i][2] >= min_w]
        if len(kept) >= 3:
            for i in line_idx:
                if stats[i][2] < min_w:
                    binary[labels == i] = 0
            line_idx = kept
    return binary, line_idx, labels, stats


def estimate_angle(gray, params, dpi):
    ds = max(1, round(dpi / params.get("estimateDpi", 150)))
    small = cv2.resize(gray, None, fx=1.0 / ds, fy=1.0 / ds, interpolation=cv2.INTER_AREA) if ds > 1 else gray
    binary, _, _, _ = line_components(small, params)

    if binary.sum() < params.get("minInkPx", 800):
        return 0.0, None, "too little text"

    max_angle = params["maxAngle"]
    angles = np.arange(-max_angle, max_angle + 1e-9, params["coarseStep"])
    scores = [projection_score(binary, a) for a in angles]
    best = float(angles[int(np.argmax(scores))])
    ratio = max(scores) / (float(np.median(scores)) + 1e-9)
    if ratio < params.get("minScoreRatio", 1.15):
        return 0.0, None, f"flat score surface (peak/median {ratio:.2f})"

    fine_angles = np.arange(best - 0.3, best + 0.3 + 1e-9, params["fineStep"])
    fine_scores = [projection_score(binary, a) for a in fine_angles]
    best_fine = float(fine_angles[int(np.argmax(fine_scores))])

    return best_fine, {
        "coarse": {f"{a:.2f}": s for a, s in zip(angles.tolist(), scores)},
        "fine": {f"{a:.2f}": s for a, s in zip(fine_angles.tolist(), fine_scores)},
    }, None


def fit_dewarp(small_rot, params, px_per_mm, debug_path=None):
    """Fit a smooth vertical displacement field dy(x,y) from text baselines on
    the (already rotated) working image. Returns normalized-coordinate poly
    coefficients with dy in working-scale px, or None when the page is rigid
    or there is too little text to trust a fit."""
    sh, sw = small_rot.shape
    binary, line_idx, labels, stats = line_components(small_rot, params)
    if len(line_idx) < params.get("dewarpMinLines", 4):
        return None, "too few text lines"

    anchors = []
    curves = []
    bin_w = 16
    for i in line_idx:
        x, y, w, h, _area = stats[i]
        if w < 3 * bin_w:
            continue
        sub = labels[y:y + h, x:x + w] == i
        pts = []
        for bx in range(0, w - bin_w + 1, bin_w):
            ys, _xs = np.nonzero(sub[:, bx:bx + bin_w])
            if len(ys) < 8:
                continue
            pts.append((x + bx + bin_w / 2.0, y + float(ys.mean())))
        if len(pts) < 4:
            continue
        pts = np.array(pts)
        coef = np.polyfit(pts[:, 0], pts[:, 1], 2)
        yfit = np.polyval(coef, pts[:, 0])
        target = float(np.median(yfit))
        curves.append((pts[:, 0], yfit, target))
        for px, yf in zip(pts[:, 0], yfit):
            anchors.append((px, target, yf - target))

    if len(anchors) < 12:
        return None, "too few baseline samples"
    A = np.array(anchors)
    max_dy = float(np.abs(A[:, 2]).max())
    if max_dy < params.get("dewarpMinMm", 0.25) * px_per_mm:
        return None, f"page is rigid (max dy {max_dy / px_per_mm:.2f} mm)"

    # Global smooth field: dy = c0 + c1 x + c2 y + c3 x^2 + c4 xy + c5 y^2
    xn, yn = A[:, 0] / sw, A[:, 1] / sh
    design = np.column_stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn])
    coeffs, *_ = np.linalg.lstsq(design, A[:, 2], rcond=None)

    if debug_path:
        vis = cv2.cvtColor(small_rot, cv2.COLOR_GRAY2BGR)
        for xs, yfit, target in curves:
            for px, yf in zip(xs, yfit):
                cv2.circle(vis, (int(px), int(yf)), 2, (0, 0, 255), -1)
            cv2.line(vis, (int(xs[0]), int(target)), (int(xs[-1]), int(target)), (0, 200, 0), 1)
        cv2.imwrite(debug_path, vis, [cv2.IMWRITE_JPEG_QUALITY, 85])

    return {"coeffs": coeffs.tolist(), "maxDyPx": max_dy, "lines": len(curves)}, None


def apply_transform(gray, angle, dewarp, ds, params, dpi):
    """One full-resolution resampling pass: dewarp displacement + rotation."""
    h, w = gray.shape
    if abs(angle) < 1e-4 and not dewarp:
        return gray
    xs = np.arange(w, dtype=np.float32)
    ys = np.arange(h, dtype=np.float32)
    map_x, map_y = np.meshgrid(xs, ys)
    if dewarp:
        c = dewarp["coeffs"]
        xn = map_x / w
        yn = map_y / h
        dy = (c[0] + c[1] * xn + c[2] * yn + c[3] * xn * xn + c[4] * xn * yn + c[5] * yn * yn) * ds
        cap = params.get("dewarpMaxMm", 2.0) / 25.4 * dpi
        np.clip(dy, -cap, cap, out=dy)
        map_y = map_y + dy.astype(np.float32)
    if abs(angle) >= 1e-4:
        # Inverse rotation: sample the source at R^-1 (x, y).
        r = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, 1.0)
        mx = r[0, 0] * map_x + r[0, 1] * map_y + r[0, 2]
        my = r[1, 0] * map_x + r[1, 1] * map_y + r[1, 2]
        map_x, map_y = mx.astype(np.float32), my.astype(np.float32)
    return cv2.remap(gray, map_x, map_y, interpolation=cv2.INTER_CUBIC,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=255)


def save_png(arr, path, dpi):
    Image.fromarray(arr).save(path, dpi=(dpi, dpi))


def debug_overlay(rotated, angle, dewarp_info, path):
    h, w = rotated.shape
    vis = cv2.cvtColor(rotated, cv2.COLOR_GRAY2BGR)
    for y in range(0, h, max(1, h // 12)):
        cv2.line(vis, (0, y), (w, y), (0, 200, 0), max(1, w // 700))
    label = f"angle: {angle:+.2f} deg"
    if dewarp_info:
        label += f"  dewarp: {dewarp_info['lines']} lines, max {dewarp_info['maxDyPx']:.1f}px"
    cv2.putText(vis, label, (30, int(h * 0.06)), cv2.FONT_HERSHEY_SIMPLEX, w / 800.0, (0, 0, 255), max(2, w // 500))
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

    ds = None
    all_angles = {}
    for fname in pages:
        page_id = fname[5:9]
        gray = cv2.imread(os.path.join(args.input_dir, fname), cv2.IMREAD_GRAYSCALE)
        ds = max(1, round(args.dpi / params.get("estimateDpi", 150)))

        if page_id in overrides:
            angle = float(overrides[page_id])
            sweep, low_conf = None, None
            print(f"deskew: page {page_id} angle {angle:+.2f} (override)")
        else:
            angle, sweep, low_conf = estimate_angle(gray, params, args.dpi)

        dewarp_info, dewarp_skip = None, "disabled"
        if params.get("dewarp", True) and not low_conf:
            small = cv2.resize(gray, None, fx=1.0 / ds, fy=1.0 / ds, interpolation=cv2.INTER_AREA) if ds > 1 else gray
            sh, sw = small.shape
            m = cv2.getRotationMatrix2D((sw / 2, sh / 2), angle, 1.0)
            small_rot = cv2.warpAffine(small, m, (sw, sh), flags=cv2.INTER_LINEAR, borderValue=255)
            px_per_mm = args.dpi / 25.4 / ds
            dewarp_info, dewarp_skip = fit_dewarp(
                small_rot, params, px_per_mm,
                debug_path=os.path.join(args.debug_dir, f"baselines-page-{page_id}.jpg"))

        msg = f"deskew: page {page_id} angle {angle:+.2f}"
        if low_conf:
            msg = f"deskew: page {page_id} angle 0.00 (low confidence: {low_conf})"
        if dewarp_info:
            msg += f", dewarp {dewarp_info['maxDyPx'] / (args.dpi / 25.4 / ds):.2f} mm over {dewarp_info['lines']} lines"
        elif dewarp_skip and dewarp_skip != "disabled":
            msg += f" (no dewarp: {dewarp_skip})"
        print(msg)

        result = apply_transform(gray, angle, dewarp_info, ds, params, args.dpi)
        save_png(result, os.path.join(args.output_dir, fname), args.dpi)
        debug_overlay(result, angle, dewarp_info, os.path.join(args.debug_dir, f"grid-page-{page_id}.jpg"))
        all_angles[page_id] = {"angle": angle, "override": page_id in overrides}
        if low_conf:
            all_angles[page_id]["lowConfidence"] = low_conf
        if dewarp_info:
            all_angles[page_id]["dewarp"] = {"lines": dewarp_info["lines"], "maxDyPx": dewarp_info["maxDyPx"]}
        elif dewarp_skip != "disabled":
            all_angles[page_id]["dewarpSkipped"] = dewarp_skip
        if sweep:
            all_angles[page_id]["bestCoarseScore"] = max(sweep["coarse"].values())

    with open(os.path.join(args.debug_dir, "angles.json"), "w") as f:
        json.dump(all_angles, f, indent=2)


if __name__ == "__main__":
    main()
