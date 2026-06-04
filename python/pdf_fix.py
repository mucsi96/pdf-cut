#!/usr/bin/env python3
"""
pdf_fix.py — per-page "smart" stage of pdf-cut.

For each image in a JSON manifest it (optionally):
  1. Deskews using a robust text projection-profile method (not fooled by
     stray marks the way raw pixel-mass deskew is).
  2. Detects punch holes — solid, round, dark blobs — and inpaints them with
     LaMa (deep-learning inpainting), reconstructing the background/text.

It is invoked by the Node CLI. The Node side falls back to ImageMagick when
this helper or its dependencies are unavailable, so this script focuses purely
on the heavy image work.

Manifest format (JSON): [{"input": "...png", "output": "...png"}, ...]
"""
import argparse
import json
import sys


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def do_check(fill_holes):
    """Verify imports so the Node side can decide whether to use this stage."""
    missing = []
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception as exc:  # pragma: no cover - env dependent
        missing.append(f"opencv/numpy/pillow ({exc})")
    if fill_holes:
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


def rotate_bound_same(img, angle, border_value):
    import cv2

    h, w = img.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
    return cv2.warpAffine(
        img,
        matrix,
        (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border_value,
    )


def estimate_skew(gray, limit, step):
    """Projection-profile skew estimation: the true rotation maximizes the
    variance between adjacent row sums of the binarized text."""
    import cv2
    import numpy as np

    thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
    # Work on a downscaled copy for speed; angle is scale-invariant.
    scale = 1000.0 / max(thr.shape)
    if scale < 1.0:
        thr = cv2.resize(thr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    best_angle, best_score = 0.0, -1.0
    angle = -limit
    while angle <= limit + 1e-9:
        matrix = cv2.getRotationMatrix2D(
            (thr.shape[1] / 2.0, thr.shape[0] / 2.0), angle, 1.0
        )
        rotated = cv2.warpAffine(
            thr, matrix, (thr.shape[1], thr.shape[0]), flags=cv2.INTER_NEAREST
        )
        proj = np.sum(rotated, axis=1, dtype=np.float64)
        score = float(np.sum((proj[1:] - proj[:-1]) ** 2))
        if score > best_score:
            best_score, best_angle = score, angle
        angle += step
    return best_angle


def detect_holes(gray, args):
    """Return a mask (uint8, 255 = fill) covering punch holes: solid, roughly
    circular, dark blobs within the expected physical size range.

    A punch hole frequently overlaps text (e.g. a header), so the raw dark blob
    is not circular. We first apply a morphological OPENING with a disk kernel:
    that erases thin structures (text strokes, rules) while preserving solid
    blobs at least the kernel size, leaving the hole's round core isolated and
    easy to score by circularity/solidity."""
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


def inpaint_regions(lama, img_rgb, mask, boxes, context):
    """Run LaMa on a small crop around each hole and paste the result back,
    keeping inference fast and memory-light regardless of page resolution."""
    import numpy as np
    from PIL import Image

    h, w = mask.shape
    out = img_rgb.copy()
    for (bx, by, bw, bh) in boxes:
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
        sel = crop_mask > 0
        crop[sel] = result[sel]
        out[y0:y1, x0:x1] = crop
    return out


def main():
    parser = argparse.ArgumentParser(description="pdf-cut smart page stage")
    parser.add_argument("--manifest", help="JSON manifest of {input,output} pairs")
    parser.add_argument("--check", action="store_true", help="verify dependencies only")
    parser.add_argument("--dpi", type=float, default=300)
    parser.add_argument("--deskew", dest="deskew", action="store_true", default=True)
    parser.add_argument("--no-deskew", dest="deskew", action="store_false")
    parser.add_argument("--deskew-limit", type=float, default=8.0)
    parser.add_argument("--deskew-step", type=float, default=0.1)
    parser.add_argument("--fill-holes", dest="fill_holes", action="store_true", default=True)
    parser.add_argument("--no-fill-holes", dest="fill_holes", action="store_false")
    parser.add_argument("--hole-min-mm", type=float, default=3.0)
    parser.add_argument("--hole-max-mm", type=float, default=10.0)
    parser.add_argument("--hole-circularity", type=float, default=0.6)
    parser.add_argument("--hole-solidity", type=float, default=0.85)
    parser.add_argument("--hole-dilate", type=float, default=0.25)
    parser.add_argument("--dark-threshold", type=int, default=80)
    parser.add_argument("--context", type=int, default=96)
    parser.add_argument("--background", default="255,255,255")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    if args.check:
        return do_check(args.fill_holes)

    import cv2
    import numpy as np
    from PIL import Image

    border = tuple(int(c) for c in args.background.split(","))
    if len(border) == 1:
        border = border * 3

    lama = None
    if args.fill_holes:
        import torch
        from simple_lama_inpainting import SimpleLama

        device = torch.device(args.device)
        lama = SimpleLama(device=device)

    with open(args.manifest) as fh:
        items = json.load(fh)

    for idx, item in enumerate(items, 1):
        img = cv2.imread(item["input"], cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit(f"could not read image: {item['input']}")
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        if args.deskew:
            angle = estimate_skew(gray, args.deskew_limit, args.deskew_step)
            if abs(angle) > 1e-3:
                img = rotate_bound_same(img, angle, (border[2], border[1], border[0]))
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            eprint(f"  [{idx}/{len(items)}] deskew {angle:+.2f} deg")

        if args.fill_holes:
            mask, boxes = detect_holes(gray, args)
            if boxes:
                rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                rgb = inpaint_regions(lama, rgb, mask, boxes, args.context)
                img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                eprint(f"  [{idx}/{len(items)}] filled {len(boxes)} hole(s)")

        # Save via PIL so the DPI metadata is preserved for img2pdf page sizing.
        out_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        Image.fromarray(out_rgb).save(item["output"], dpi=(args.dpi, args.dpi))

    return 0


if __name__ == "__main__":
    sys.exit(main())
