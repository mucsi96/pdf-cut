#!/usr/bin/env python3
"""
pdf_fix.py — OpenCV/LaMa helper for pdf-cut stages.

Operations (selected with --op, items supplied as a JSON manifest):

  clean   Detect scanner residue (dark edge bars / blobs) with a morphological
          opening — text strokes are thin and vanish from the opened image, so
          residue is isolated as solid masses that are painted white IN PLACE
          (no flood fill that can leak into touching text). Also reports the
          content bounding box built from glyph-sized components.

  holes   Detect punch holes — solid, roughly circular, dark blobs within a
          physical size range — and inpaint them with LaMa on a small crop
          around each hole.

  --check verifies imports so the Node side can fall back gracefully.

Manifest: [{"key": "...", "input": "...png", "output": "...png"}, ...]
Results:  one JSON object per line on stdout: {"key", ...op specific...}
"""
import argparse
import json
import os
import sys


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def do_check(need_lama):
    missing = []
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception as exc:  # pragma: no cover - env dependent
        missing.append(f"opencv/numpy/pillow ({exc})")
    if need_lama:
        try:
            import torch  # noqa: F401
            from simple_lama_inpainting import SimpleLama  # noqa: F401
        except Exception as exc:  # pragma: no cover - env dependent
            missing.append(f"torch/simple-lama-inpainting ({exc})")
    if missing:
        eprint("pdf_fix unavailable: " + "; ".join(missing))
        return 3
    print("ok")
    return 0


def content_box(text_mask, glyph_min_area, margin_pad):
    """Bounding rectangle of the genuine text: connected components large
    enough to be glyphs (specks ignored), page-spanning blobs excluded."""
    import cv2

    h, w = text_mask.shape
    n, _, stats, _ = cv2.connectedComponentsWithStats(text_mask)
    x0, y0, x1, y1 = w, h, 0, 0
    found = False
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < glyph_min_area:
            continue
        if bw > 0.6 * w and bh > 0.6 * h:  # page-spanning blob, not a glyph
            continue
        found = True
        x0, y0 = min(x0, x), min(y0, y)
        x1, y1 = max(x1, x + bw), max(y1, y + bh)
    if not found:
        return None
    x0 = max(0, x0 - margin_pad)
    y0 = max(0, y0 - margin_pad)
    x1 = min(w, x1 + margin_pad)
    y1 = min(h, y1 + margin_pad)
    return (x0, y0, x1, y1)


def _mostly_outside(rect, box):
    x, y, bw, bh = rect
    bx0, by0, bx1, by1 = box
    ix0, iy0 = max(x, bx0), max(y, by0)
    ix1, iy1 = min(x + bw, bx1), min(y + bh, by1)
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    return inter < 0.5 * (bw * bh)


def detect_residue(gray, args):
    """Mask (255 = paint white) of scanner residue plus the content box.

    A morphological opening keeps only thick solid masses (text strokes and
    rules vanish). A mass is residue when it is large, elongated (a bar), or
    lies mostly outside the text region. Compact in-text blobs (punch holes)
    are left for the hole/LaMa stage."""
    import cv2
    import numpy as np

    h, w = gray.shape
    px = args.dpi / 25.4
    dark = cv2.threshold(gray, args.residue_threshold, 255, cv2.THRESH_BINARY_INV)[1]

    radius = max(2, int(args.residue_thick_mm * px / 2))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    opened = cv2.morphologyEx(dark, cv2.MORPH_OPEN, kernel)

    min_area = (args.residue_min_mm * px) ** 2
    big_area = (args.residue_big_mm * px) ** 2

    n, labels, stats, _ = cv2.connectedComponentsWithStats(opened)
    text = dark.copy()
    candidates = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < min_area:
            continue
        candidates.append((i, x, y, bw, bh, area))
        text[labels == i] = 0  # remove solid masses so the text box is clean

    glyph_min_area = (args.glyph_min_mm * px) ** 2
    margin_pad = int(args.margin_pad_mm * px)
    box = content_box(text, glyph_min_area, margin_pad)

    mask = np.zeros((h, w), np.uint8)
    for (i, x, y, bw, bh, area) in candidates:
        aspect = max(bw, bh) / max(1, min(bw, bh))
        outside = box is None or _mostly_outside((x, y, bw, bh), box)
        if area >= big_area or aspect >= args.residue_aspect or outside:
            mask[labels == i] = 255

    # The opening shrank each mass; regrow within the original dark pixels and
    # add a small safety margin so no dark fringe is left behind.
    mask = cv2.bitwise_and(cv2.dilate(mask, kernel), dark)
    pad = max(1, int(args.residue_pad_mm * px))
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * pad + 1, 2 * pad + 1)))
    return mask, box


def detect_holes(gray, args):
    """Mask (255 = fill) + boxes covering punch holes: solid, roughly circular,
    dark blobs within the expected physical size range. A morphological
    OPENING first erases thin structures (text strokes, rules) so a hole that
    overlaps a header still presents its round core for circularity tests."""
    import cv2
    import numpy as np

    px_per_mm = args.dpi / 25.4
    min_d = args.hole_min_mm * px_per_mm
    max_d = args.hole_max_mm * px_per_mm
    min_area = np.pi * (min_d / 2.0) ** 2
    max_area = np.pi * (max_d / 2.0) ** 2

    dark = cv2.threshold(gray, args.dark_threshold, 255, cv2.THRESH_BINARY_INV)[1]
    radius = max(2, int(min_d * 0.3))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    opened = cv2.morphologyEx(dark, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(opened, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    mask = np.zeros(gray.shape, dtype=np.uint8)
    boxes = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue
        perimeter = cv2.arcLength(cnt, True)
        if perimeter == 0:
            continue
        circularity = 4.0 * np.pi * area / (perimeter * perimeter)
        if circularity < args.hole_circularity:
            continue
        hull = cv2.convexHull(cnt)
        hull_area = cv2.contourArea(hull)
        solidity = area / hull_area if hull_area > 0 else 0
        if solidity < args.hole_solidity:
            continue
        (cx, cy), rad = cv2.minEnclosingCircle(cnt)
        pad = int(rad * args.hole_dilate)
        cv2.circle(mask, (int(cx), int(cy)), int(rad) + pad, 255, -1)
        x0, y0 = int(cx - rad) - pad, int(cy - rad) - pad
        side = int(2 * rad) + 2 * pad
        boxes.append((x0, y0, side, side))
    return mask, boxes


def inpaint_regions(lama, img_rgb, mask, boxes, context, debug_prefix=None):
    """Run LaMa on a small crop around each hole and paste back only the
    masked pixels — fast, memory-light, and the rest of the page is untouched
    by construction."""
    import numpy as np
    from PIL import Image

    h, w = mask.shape
    out = img_rgb.copy()
    for idx, (bx, by, bw, bh) in enumerate(boxes):
        x0 = max(0, bx - context)
        y0 = max(0, by - context)
        x1 = min(w, bx + bw + context)
        y1 = min(h, by + bh + context)
        crop = out[y0:y1, x0:x1]
        crop_mask = mask[y0:y1, x0:x1]
        if crop_mask.max() == 0:
            continue
        result = lama(Image.fromarray(crop), Image.fromarray(crop_mask).convert("L"))
        result = np.array(result.convert("RGB"))
        if result.shape[:2] != crop.shape[:2]:
            result = result[: crop.shape[0], : crop.shape[1]]
        if debug_prefix:
            Image.fromarray(crop).save(f"{debug_prefix}-patch-{idx}.png")
            Image.fromarray(crop_mask).save(f"{debug_prefix}-mask-{idx}.png")
            Image.fromarray(result).save(f"{debug_prefix}-ai-{idx}.png")
        sel = crop_mask > 0
        crop[sel] = result[sel]
        out[y0:y1, x0:x1] = crop
    return out


def op_clean(items, args):
    import cv2

    for item in items:
        img = cv2.imread(item["input"], cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise SystemExit(f"could not read image: {item['input']}")
        mask, box = detect_residue(img, args)
        painted = int((mask > 0).sum())
        if painted:
            img[mask > 0] = 255
        cv2.imwrite(item["output"], img)
        print(json.dumps({
            "key": item["key"],
            "paintedPx": painted,
            "bbox": None if box is None else {
                "x": int(box[0]), "y": int(box[1]),
                "w": int(box[2] - box[0]), "h": int(box[3] - box[1])
            }
        }), flush=True)


def op_holes(items, args):
    import cv2
    import torch
    from simple_lama_inpainting import SimpleLama

    lama = SimpleLama(device=torch.device(args.device))
    for item in items:
        img = cv2.imread(item["input"], cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit(f"could not read image: {item['input']}")
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mask, boxes = detect_holes(gray, args)
        if boxes:
            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            rgb = inpaint_regions(
                lama, rgb, mask, boxes, args.context,
                debug_prefix=item.get("debugPrefix")
            )
            img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        cv2.imwrite(item["output"], img)
        print(json.dumps({
            "key": item["key"],
            "holes": [{"x": b[0], "y": b[1], "w": b[2], "h": b[3]} for b in boxes]
        }), flush=True)


def main():
    parser = argparse.ArgumentParser(description="pdf-cut OpenCV/LaMa helper")
    parser.add_argument("--op", choices=["clean", "holes"])
    parser.add_argument("--manifest")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--need-lama", action="store_true")
    parser.add_argument("--dpi", type=float, default=600)
    # holes
    parser.add_argument("--hole-min-mm", type=float, default=3.0)
    parser.add_argument("--hole-max-mm", type=float, default=10.0)
    parser.add_argument("--hole-circularity", type=float, default=0.6)
    parser.add_argument("--hole-solidity", type=float, default=0.85)
    parser.add_argument("--hole-dilate", type=float, default=0.25)
    parser.add_argument("--dark-threshold", type=int, default=80)
    parser.add_argument("--context", type=int, default=192)
    # clean
    parser.add_argument("--residue-threshold", type=int, default=110)
    parser.add_argument("--residue-thick-mm", type=float, default=1.5)
    parser.add_argument("--residue-min-mm", type=float, default=4.0)
    parser.add_argument("--residue-big-mm", type=float, default=12.0)
    parser.add_argument("--residue-aspect", type=float, default=3.0)
    parser.add_argument("--residue-pad-mm", type=float, default=1.0)
    parser.add_argument("--glyph-min-mm", type=float, default=0.6)
    parser.add_argument("--margin-pad-mm", type=float, default=3.0)
    parser.add_argument("--device", default=os.environ.get("PDFCUT_TORCH_DEVICE", "cpu"))
    args = parser.parse_args()

    if args.check:
        return do_check(args.need_lama)

    with open(args.manifest) as fh:
        items = json.load(fh)
    if args.op == "clean":
        op_clean(items, args)
    elif args.op == "holes":
        op_holes(items, args)
    else:
        raise SystemExit("--op required")
    return 0


if __name__ == "__main__":
    sys.exit(main())
