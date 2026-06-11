#!/usr/bin/env python3
"""Clean scanned pages while preserving grayscale illustrations.

Layers (each toggleable via params):
  1. Illumination flatten — divide by a morphological background estimate;
     removes gutter shadow and scanner vignetting without touching mid-tones.
  2. Border kill — hard white margins plus removal of dark blobs that touch
     the page border and intrude only a limited distance.
  3. Margin despeckle — tiny specks removed only inside a margin band.
  4. smart-binarize mode — soft Sauvola threshold for text (pure black ink,
     pure white paper, anti-aliased glyph edges) with detected illustration
     regions composited back as untouched grayscale.
"""
import argparse
import json
import os

import cv2
import numpy as np
from PIL import Image


def flatten_illumination(gray, kernel_px):
    small = cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    k = max(3, (kernel_px // 4) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    bg_small = cv2.morphologyEx(small, cv2.MORPH_CLOSE, kernel)
    bg_small = cv2.GaussianBlur(bg_small, (0, 0), k / 4)
    bg = cv2.resize(bg_small, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
    bg = np.maximum(bg, 1)
    out = np.clip(gray.astype(np.float32) / bg.astype(np.float32) * 255.0, 0, 255)
    return out.astype(np.uint8), bg


def white_margins(img, margins):
    h, w = img.shape
    out = img.copy()
    out[: margins["top"], :] = 255
    out[h - margins["bottom"]:, :] = 255
    out[:, : margins["left"]] = 255
    out[:, w - margins["right"]:] = 255
    return out


def kill_border(img, margins, max_intrusion):
    h, w = img.shape
    out = white_margins(img, margins)
    # Dark components touching the border with limited intrusion.
    dark = (out < 128).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    for i in range(1, n):
        x, y, bw, bh, _area = stats[i]
        touches = x == 0 or y == 0 or x + bw == w or y + bh == h
        if not touches:
            continue
        intrusion = 0
        if x == 0:
            intrusion = max(intrusion, x + bw)
        if x + bw == w:
            intrusion = max(intrusion, w - x)
        if y == 0:
            intrusion = max(intrusion, y + bh)
        if y + bh == h:
            intrusion = max(intrusion, h - y)
        if intrusion <= max_intrusion:
            out[labels == i] = 255
    return out


def despeckle_margins(img, band_px, min_area):
    h, w = img.shape
    out = img.copy()
    band = np.zeros((h, w), np.uint8)
    band[:band_px, :] = 1
    band[h - band_px:, :] = 1
    band[:, :band_px] = 1
    band[:, w - band_px:] = 1
    dark = ((out < 200) & (band == 1)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    for i in range(1, n):
        if stats[i][4] < min_area:
            out[labels == i] = 255
    return out


def detect_picture_regions(gray, params):
    """Mask (0..1 float, full res) of halftone/illustration regions."""
    ds = cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    mid = ((ds > params["picMidLow"]) & (ds < params["picMidHigh"])).astype(np.float32)
    k = max(3, (params["picWindowPx"] // 4) | 1)
    density = cv2.boxFilter(mid, -1, (k, k))
    mask = (density > params["picDensity"]).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    # Drop small regions.
    min_area_ds = params["picMinAreaPx"] / 16.0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    for i in range(1, n):
        if stats[i][4] < min_area_ds:
            mask[labels == i] = 0
    mask_full = cv2.resize(mask, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_NEAREST)
    feather = params["picFeatherPx"]
    if feather > 0:
        mask_full = cv2.GaussianBlur(mask_full.astype(np.float32), (0, 0), feather)
        mask_full = np.clip(mask_full, 0, 1)
    return mask_full.astype(np.float32)


def soft_sauvola(gray, params):
    """Sauvola threshold surface + smoothstep tone curve around it."""
    win = params["sauvolaWindowPx"] | 1
    k = params["sauvolaK"]
    img = gray.astype(np.float32)
    mean = cv2.boxFilter(img, -1, (win, win))
    sq_mean = cv2.boxFilter(img * img, -1, (win, win))
    std = np.sqrt(np.maximum(sq_mean - mean * mean, 0))
    threshold = mean * (1.0 + k * (std / 128.0 - 1.0))
    # Inside large solid black areas the local window is uniform and Sauvola
    # would hollow them out — floor the threshold so dark pixels stay ink.
    threshold = np.maximum(threshold, float(params.get("sauvolaDarkFloor", 100)))
    s = max(1.0, float(params["edgeSoftness"]))
    t = np.clip((img - (threshold - s)) / (2.0 * s), 0, 1)
    t = t * t * (3 - 2 * t)  # smoothstep: anti-aliased glyph edges
    return (t * 255.0).astype(np.uint8)


def save_png(arr, path, dpi):
    Image.fromarray(arr).save(path, dpi=(dpi, dpi))


def save_jpg(arr, path, width=1000):
    h, w = arr.shape[:2]
    scale = width / float(w)
    vis = cv2.resize(arr, (width, int(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(path, vis, [cv2.IMWRITE_JPEG_QUALITY, 80])


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
    for fname in pages:
        page_id = fname[5:9]
        gray = cv2.imread(os.path.join(args.input_dir, fname), cv2.IMREAD_GRAYSCALE)
        original = gray.copy()

        if p.get("flatten", True):
            gray, bg = flatten_illumination(gray, p["bgKernelPx"])
            save_jpg(bg, os.path.join(args.debug_dir, f"background-page-{page_id}.jpg"))

        gray = kill_border(gray, p["margins"], p["maxBorderIntrusionPx"])
        gray = despeckle_margins(gray, p["despeckleBandPx"], p["minSpeckArea"])

        if p.get("mode", "smart-binarize") == "smart-binarize":
            # Detect on the PRE-flatten image (flattening brightens halftones
            # out of the mid-tone band) and keep illustration regions from the
            # original so their tones survive untouched.
            pic_mask = detect_picture_regions(original, p)
            illus_layer = white_margins(original, p["margins"])
            text_layer = soft_sauvola(gray, p)
            out = (pic_mask * illus_layer.astype(np.float32) +
                   (1.0 - pic_mask) * text_layer.astype(np.float32))
            out = np.clip(out, 0, 255).astype(np.uint8)
            # Debug: detected illustration regions in blue.
            vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR).astype(np.float32)
            vis[..., 0] = np.clip(vis[..., 0] + pic_mask * 120, 0, 255)
            vis[..., 1] -= pic_mask * 40
            vis[..., 2] -= pic_mask * 40
            save_jpg(np.clip(vis, 0, 255).astype(np.uint8),
                     os.path.join(args.debug_dir, f"regions-page-{page_id}.jpg"))
        else:
            wp = float(p["whitePoint"])
            img = gray.astype(np.float32)
            ramp = np.clip((img - (wp - 20)) / 20.0, 0, 1)
            out = np.clip(img + ramp * (255 - img), 0, 255).astype(np.uint8)

        save_png(out, os.path.join(args.output_dir, fname), args.dpi)

        # Debug: before/after + changed-pixel mask (red).
        side = np.hstack([original, out])
        save_jpg(side, os.path.join(args.debug_dir, f"before-after-page-{page_id}.jpg"), width=1600)
        changed = (np.abs(out.astype(np.int16) - original.astype(np.int16)) > 8)
        vis = cv2.cvtColor(original, cv2.COLOR_GRAY2BGR)
        vis[changed] = (0, 0, 255)
        save_jpg(vis, os.path.join(args.debug_dir, f"changed-page-{page_id}.jpg"))
        print(f"clean: page {page_id} done ({int(changed.mean() * 100)}% pixels changed)")


if __name__ == "__main__":
    main()
