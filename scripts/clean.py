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


def flatten_illumination(gray, kernel_px, bg_floor=128):
    small = cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    k = max(3, (kernel_px // 4) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    bg_small = cv2.morphologyEx(small, cv2.MORPH_CLOSE, kernel)
    bg_small = cv2.GaussianBlur(bg_small, (0, 0), k / 4)
    bg = cv2.resize(bg_small, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
    # Dark blobs larger than the closing kernel (punch holes, solid black
    # fills) leak into the background estimate; dividing by it would hollow
    # them out. Shadows/vignetting are far lighter than ink, so flooring the
    # estimate keeps shadow removal while leaving real ink untouched.
    bg = np.maximum(bg, bg_floor)
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


def find_paper_level(img):
    hist = cv2.calcHist([img], [0], None, [256], [0, 256]).ravel()
    return int(np.argmax(hist[128:]) + 128)


def trim_vertical_borders(img, paper, p, dpi):
    """Column-profile border trim (unpaper-style): scan-edge residue (page
    edge shadow, neighboring page) forms columns whose ink density is far
    above anything text produces (~5%). Walk inward from the left/right
    edges, whiten dirty columns, stop at a clean run. Vertical edges only:
    a horizontal variant would eat header/footer rules."""
    h, w = img.shape
    max_trim = int(p.get("borderTrimMaxMm", 12.0) / 25.4 * dpi)
    dirty_frac = p.get("borderTrimDirtyFrac", 0.10)
    clean_run = max(2, int(1.5 / 25.4 * dpi))
    out = img.copy()
    fracs = (img < paper - 20).mean(axis=0)
    trims = {}
    for side in ("left", "right"):
        rng = range(0, min(max_trim, w)) if side == "left" else range(w - 1, max(w - max_trim, -1), -1)
        clean, cut = 0, None
        for idx, pos in enumerate(rng):
            if fracs[pos] > dirty_frac:
                cut, clean = idx, 0
            elif (clean := clean + 1) >= clean_run:
                break
        if cut is not None:
            n = cut + 1
            trims[side] = n
            if side == "left":
                out[:, :n] = 255
            else:
                out[:, w - n:] = 255
    return out, trims


def preserve_clean(original, p):
    """Content-preserving mode: detect content blocks (text, illustrations,
    anything meaningfully darker than paper), keep every content pixel exactly
    as scanned, and whiten everything else — border residue, isolated specks,
    shadows between blocks, and the paper tint (soft highlight clip only,
    far above the ink level, so glyphs are never touched)."""
    h, w = original.shape
    paper = find_paper_level(original)
    clip_hi = max(200, paper - p.get("paperMargin", 15))

    original, trims = trim_vertical_borders(original, paper, p, p["_dpi"])
    if trims:
        print(f"clean: border trim {trims}")

    # Soft highlight clip: paper -> white; ink (anything below clip_hi-soft)
    # is mathematically unchanged.
    img = original.astype(np.float32)
    soft = 12.0
    t = np.clip((img - (clip_hi - soft)) / (2.0 * soft), 0, 1)
    t = t * t * (3 - 2 * t)
    base = np.clip(img + t * (255.0 - img), 0, 255).astype(np.uint8)

    # Content mask on a 1/4 downsample.
    small = cv2.resize(original, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    sh, sw = small.shape
    ink = (small < paper - p.get("contentDelta", 25)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    keep = np.zeros_like(ink)
    max_intrusion = p["maxBorderIntrusionPx"] / 4.0
    min_area = p["minSpeckArea"] / 16.0
    # Residue often sits a few mm INSIDE the page edge (deskew pads the border
    # white): drop components fully contained in a narrow edge band, and small
    # specks inside a wider margin band. Real content near the edge (page
    # numbers, running heads) is far larger than despeckleMaxAreaMm2, while
    # sentence periods deep in the text block are never touched.
    px_per_mm = p["_dpi"] / 25.4 / 4.0
    edge_band = p.get("edgeBandMm", 6.0) * px_per_mm
    despeckle_band = p.get("despeckleBandMm", 10.0) * px_per_mm
    speck_max = p.get("despeckleMaxAreaMm2", 1.0) * px_per_mm * px_per_mm
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        touches = x == 0 or y == 0 or x + bw == sw or y + bh == sh
        if touches:
            intrusion = max(
                x + bw if x == 0 else 0, sw - x if x + bw == sw else 0,
                y + bh if y == 0 else 0, sh - y if y + bh == sh else 0)
            if intrusion <= max_intrusion:
                continue  # border residue
        def fully_within(band):
            return (x + bw <= band or x >= sw - band or
                    y + bh <= band or y >= sh - band)
        if fully_within(edge_band):
            continue  # residue near the page edge
        # Tall, narrow blobs hugging a vertical edge are scan residue (page
        # edge shadow / neighboring page): no book content looks like that.
        # Horizontal edges are exempt — header/footer rules are content.
        strip_band = p.get("edgeStripBandMm", 10.0) * px_per_mm
        if (x + bw <= strip_band or x >= sw - strip_band) and bh >= 0.25 * sh:
            continue  # vertical residue strip
        if area < speck_max and fully_within(despeckle_band):
            continue  # speck in the margin band
        if area < min_area:
            continue  # isolated speck
        keep[labels == i] = 1

    # Merge glyphs into blocks and add a safety halo around all content.
    dil = max(1, int(p.get("contentDilatePx", 60) / 4))
    keep = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dil + 1, 2 * dil + 1)))
    mask = cv2.resize(keep, (w, h), interpolation=cv2.INTER_NEAREST).astype(np.float32)
    feather = p.get("contentFeatherPx", 8)
    if feather > 0:
        mask = np.clip(cv2.GaussianBlur(mask, (0, 0), feather), 0, 1)

    out = np.clip(mask * base.astype(np.float32) + (1.0 - mask) * 255.0, 0, 255).astype(np.uint8)
    out = white_margins(out, p["margins"])
    return out, mask, paper


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


def auto_levels(img, p):
    """Per-page contrast normalization: map the ink level to black and the
    paper peak to white. Faintly printed pages (light-gray text) would
    otherwise sit above the Sauvola threshold and be erased."""
    hist = cv2.calcHist([img], [0], None, [256], [0, 256]).ravel()
    paper = int(np.argmax(hist[128:]) + 128)
    dark = img[img < paper - 30]
    if dark.size < 500:
        return img, None  # effectively blank page
    ink = int(np.percentile(dark, p.get("inkPercentile", 5)))
    hi = paper - p.get("paperMargin", 15)
    if hi - ink < 30:
        return img, None
    out = np.clip((img.astype(np.float32) - ink) / float(hi - ink), 0, 1)
    return (out * 255).astype(np.uint8), {"ink": ink, "paper": paper}


def soft_sauvola(gray, params):
    """Sauvola threshold surface + smoothstep tone curve around it.
    Returns (text_layer, threshold_surface)."""
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
    return (t * 255.0).astype(np.uint8), threshold.astype(np.uint8)


def save_png(arr, path, dpi):
    Image.fromarray(arr).save(path, dpi=(dpi, dpi))


def save_jpg(arr, path, width=1000):
    h, w = arr.shape[:2]
    scale = width / float(w)
    vis = cv2.resize(arr, (width, int(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(path, vis, [cv2.IMWRITE_JPEG_QUALITY, 80])


def scale_params(p, dpi):
    """All pixel-based defaults were tuned at 600 dpi — scale them to the
    actual scan resolution (areas scale quadratically)."""
    s = dpi / 600.0
    q = dict(p)
    for k, d in (("bgKernelPx", 81), ("despeckleBandPx", 350), ("sauvolaWindowPx", 61),
                 ("contentDilatePx", 60), ("contentFeatherPx", 8), ("picWindowPx", 51),
                 ("maxBorderIntrusionPx", 250)):
        q[k] = max(1, int(round(q.get(k, d) * s)))
    q["minSpeckArea"] = max(1, int(round(q.get("minSpeckArea", 60) * s * s)))
    q["picMinAreaPx"] = max(1, int(round(q.get("picMinAreaPx", 40000) * s * s)))
    margins = q.get("margins", {"top": 60, "bottom": 60, "left": 60, "right": 60})
    q["margins"] = {side: max(0, int(round(v * s))) for side, v in margins.items()}
    return q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--debug-dir", required=True)
    ap.add_argument("--dpi", type=int, default=600)
    ap.add_argument("--params", required=True)
    args = ap.parse_args()
    p = scale_params(json.loads(args.params), args.dpi)
    p["_dpi"] = args.dpi

    pages = sorted(f for f in os.listdir(args.input_dir) if f.startswith("page-") and f.endswith(".png"))
    for fname in pages:
        page_id = fname[5:9]
        gray = cv2.imread(os.path.join(args.input_dir, fname), cv2.IMREAD_GRAYSCALE)
        original = gray.copy()
        mode = p.get("mode", "preserve")

        if mode == "preserve":
            out, content_mask, paper = preserve_clean(original, p)
            print(f"clean: page {page_id} paper level {paper}, "
                  f"content {content_mask.mean() * 100:.0f}% of page")
            # Debug: kept content tinted blue (same artifact name the report
            # shows in its regions column).
            vis = cv2.cvtColor(original, cv2.COLOR_GRAY2BGR).astype(np.float32)
            vis[..., 0] = np.clip(vis[..., 0] + content_mask * 120, 0, 255)
            vis[..., 1] -= content_mask * 40
            vis[..., 2] -= content_mask * 40
            save_jpg(np.clip(vis, 0, 255).astype(np.uint8),
                     os.path.join(args.debug_dir, f"regions-page-{page_id}.jpg"))
            save_changed_debug(original, out, args.debug_dir, page_id)
            save_png(out, os.path.join(args.output_dir, fname), args.dpi)
            side = np.hstack([original, out])
            save_jpg(side, os.path.join(args.debug_dir, f"before-after-page-{page_id}.jpg"), width=1600)
            continue

        if p.get("flatten", True):
            gray, bg = flatten_illumination(gray, p["bgKernelPx"], p.get("bgFloor", 128))
            save_jpg(bg, os.path.join(args.debug_dir, f"background-page-{page_id}.jpg"))

        gray = kill_border(gray, p["margins"], p["maxBorderIntrusionPx"])
        gray = despeckle_margins(gray, p["despeckleBandPx"], p["minSpeckArea"])

        if mode == "smart-binarize":
            # Detect on the PRE-flatten image (flattening brightens halftones
            # out of the mid-tone band) and keep illustration regions from the
            # original so their tones survive untouched.
            pic_mask = detect_picture_regions(original, p)
            illus_layer = white_margins(original, p["margins"])
            norm = gray
            levels = None
            if p.get("autoLevels", True):
                norm, levels = auto_levels(gray, p)
            text_layer, threshold = soft_sauvola(norm, p)
            out = (pic_mask * illus_layer.astype(np.float32) +
                   (1.0 - pic_mask) * text_layer.astype(np.float32))
            out = np.clip(out, 0, 255).astype(np.uint8)
            if levels:
                print(f"clean: page {page_id} auto-levels ink={levels['ink']} paper={levels['paper']}")
            # Debug: normalized input | Sauvola threshold surface | binarized
            # result — shows exactly why a stroke survived or vanished.
            save_jpg(np.hstack([norm, threshold, text_layer]),
                     os.path.join(args.debug_dir, f"binarize-page-{page_id}.jpg"), width=2100)
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

        side = np.hstack([original, out])
        save_jpg(side, os.path.join(args.debug_dir, f"before-after-page-{page_id}.jpg"), width=1600)
        save_changed_debug(original, out, args.debug_dir, page_id)


def save_changed_debug(original, out, debug_dir, page_id):
    """Content-change mask: red = ink removed (watch for content loss!),
    blue = ink added. Background whitening is ignored on purpose — it would
    flag nearly every pixel."""
    delta = out.astype(np.int16) - original.astype(np.int16)
    removed = (delta > 50) & (original < 210)  # catches faint ink too
    added = (delta < -50) & (original > 150)
    vis = cv2.cvtColor(out, cv2.COLOR_GRAY2BGR)
    vis[removed] = (0, 0, 255)
    vis[added] = (255, 0, 0)
    save_jpg(vis, os.path.join(debug_dir, f"changed-page-{page_id}.jpg"))
    print(f"clean: page {page_id} done "
          f"(ink removed {removed.mean() * 100:.2f}%, added {added.mean() * 100:.2f}%)")


if __name__ == "__main__":
    main()
