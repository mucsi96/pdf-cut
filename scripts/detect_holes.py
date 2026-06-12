#!/usr/bin/env python3
"""Detect filing punch holes and emit LaMa inpainting masks.

Key idea: a punch machine hits (nearly) the same spot on every page, so the
detector works in two passes:
  1. gather hole-like dark-blob candidates per page (size/shape gated),
  2. cluster the well-formed candidates across ALL pages; clusters present on
     enough pages are real punch positions. Every page then gets a mask at
     each cluster — using its own refined candidate when one exists, or the
     cluster's median position when the hole is hidden inside artwork/text or
     too deformed to detect on that page.
With fewer than `minPagesForCluster` pages, candidates are accepted directly
(old behavior) since there is nothing to vote with.

All physical parameters are in mm; detection runs at ~150 dpi regardless of
scan resolution.
"""
import argparse
import json
import math
import os

import cv2
import numpy as np
from PIL import Image


SIDES = {}


def page_is_left(page_id):
    """Binding side from the split manifest; falls back to page-number parity
    (even = left/verso) when no side info exists."""
    side = SIDES.get(page_id)
    if side:
        return side == "left"
    return int(page_id) % 2 == 0


def search_regions(p, w, h, page_id):
    """Union of full-res regions where hole centers may sit: a top band
    (top-margin punching) and a gutter strip (ring binders)."""
    regs = []
    top = p.get("searchTopFrac", 0.18)
    if top > 0:
        regs.append((0, 0, w, h * top))
    inner = p.get("searchInnerWidthFrac", 0.18)
    if inner > 0:
        if page_is_left(page_id):
            regs.append((w * (1.0 - inner), 0, w, h))
        else:
            regs.append((0, 0, w * inner, h))
    return regs


def in_any_region(regs, x, y):
    return any(rx0 <= x <= rx1 and ry0 <= y <= ry1 for rx0, ry0, rx1, ry1 in regs)


def gather_candidates(gray, page_id, p, dpi):
    """Hole-like dark blobs on one page, coordinates in full-res px."""
    h, w = gray.shape
    ds = max(1, round(dpi / 150.0))
    small = cv2.resize(gray, None, fx=1.0 / ds, fy=1.0 / ds, interpolation=cv2.INTER_AREA) if ds > 1 else gray
    sh, sw = small.shape

    px_per_mm = dpi / 25.4 / ds
    min_r = p["minDiamMm"] / 2.0 * px_per_mm
    max_r = p["maxDiamMm"] / 2.0 * px_per_mm

    dark = (small < p["darkThreshold"]).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    # Strip thin attachments (text strokes, rules) so a hole punched through
    # text keeps its disc shape; structures thinner than ~the minimum hole
    # diameter vanish, solid discs survive.
    k_open = max(3, int(min_r) | 1)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_open, k_open)))

    regs = search_regions(p, sw, sh, page_id)
    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cands = []
    for c in contours:
        area = cv2.contourArea(c)
        if area <= 0:
            continue
        r_eq = math.sqrt(area / math.pi)
        if not (min_r * 0.5 <= r_eq <= max_r * 1.6):
            continue
        m = cv2.moments(c)
        if m["m00"] == 0:
            continue
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        perim = cv2.arcLength(c, True)
        circ = 4 * math.pi * area / (perim * perim) if perim > 0 else 0
        if circ < 0.25:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        touches_edge = x <= 0 or y <= 0 or x + bw >= sw or y + bh >= sh
        in_region = in_any_region(regs, cx, cy)
        size_ok = min_r <= r_eq <= max_r
        circ_ok = circ >= (p["edgeCircularityMin"] if touches_edge else p["circularityMin"])
        # Voters define cluster positions and must be unambiguous discs.
        voter = in_region and size_ok and circ >= (
            p["edgeCircularityMin"] if touches_edge else p.get("voterCircularityMin", 0.78))
        cands.append({
            "cx": cx * ds, "cy": cy * ds, "r": r_eq * ds,
            "circularity": round(circ, 3), "touchesEdge": touches_edge,
            "inRegion": in_region, "sizeOk": size_ok, "circOk": circ_ok, "voter": voter,
        })
    full_regs = [(x0 * ds, y0 * ds, x1 * ds, y1 * ds) for x0, y0, x1, y1 in regs]
    return cands, full_regs


def cluster_voters(all_cands, tol_px, min_frac):
    """Cluster voters separately per binding side: recto/verso pages mirror
    the punch position, so left and right pages get their own clusters."""
    qualified = []
    for side_left in (True, False):
        pages_p = [pid for pid in all_cands if page_is_left(pid) == side_left]
        need = max(2, math.ceil(min_frac * len(pages_p)))
        clusters = []
        for page_id in pages_p:
            for c in all_cands[page_id]:
                if not c["voter"]:
                    continue
                hit = None
                for cl in clusters:
                    if math.hypot(cl["cx"] - c["cx"], cl["cy"] - c["cy"]) <= tol_px:
                        hit = cl
                        break
                if hit:
                    hit["members"].append((page_id, c))
                    xs = [m[1]["cx"] for m in hit["members"]]
                    ys = [m[1]["cy"] for m in hit["members"]]
                    hit["cx"], hit["cy"] = float(np.median(xs)), float(np.median(ys))
                else:
                    clusters.append({"cx": c["cx"], "cy": c["cy"], "left": side_left,
                                     "members": [(page_id, c)]})
        for cl in clusters:
            pages = {m[0] for m in cl["members"]}
            if len(pages) >= need:
                cl["r"] = float(np.median([m[1]["r"] for m in cl["members"]]))
                cl["pages"] = len(pages)
                cl["pagesTotal"] = len(pages_p)
                qualified.append(cl)
    return qualified


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--debug-dir", required=True)
    ap.add_argument("--dpi", type=int, default=600)
    ap.add_argument("--sides", default="{}", help='{"0002": "left"|"right", ...} from the split manifest')
    ap.add_argument("--params", required=True)
    args = ap.parse_args()
    p = json.loads(args.params)
    SIDES.update(json.loads(args.sides))
    px_per_mm = args.dpi / 25.4

    pages = sorted(f for f in os.listdir(args.input_dir) if f.startswith("page-") and f.endswith(".png"))
    page_ids = [f[5:9] for f in pages]

    # Pass 1: candidates everywhere.
    all_cands, all_regs, shapes = {}, {}, {}
    for fname, page_id in zip(pages, page_ids):
        gray = cv2.imread(os.path.join(args.input_dir, fname), cv2.IMREAD_GRAYSCALE)
        shapes[page_id] = gray.shape
        all_cands[page_id], all_regs[page_id] = gather_candidates(gray, page_id, p, args.dpi)

    # Pass 2: cross-page clustering.
    tol_px = p.get("clusterTolMm", 8.0) * px_per_mm
    use_clusters = len(pages) >= p.get("minPagesForCluster", 4)
    clusters = []
    if use_clusters:
        clusters = cluster_voters(all_cands, tol_px, p.get("clusterMinFrac", 0.3))
        for cl in clusters:
            print(f"detect-holes: punch position ({'left' if cl['left'] else 'right'} pages) "
                  f"at ({cl['cx']:.0f},{cl['cy']:.0f}) r={cl['r']:.0f}px "
                  f"seen on {cl['pages']}/{cl['pagesTotal']} pages")
        if not clusters:
            print("detect-holes: no punch position confirmed across pages "
                  "— falling back to per-page detection")

    min_r = p["minDiamMm"] / 2.0 * px_per_mm
    max_r = p["maxDiamMm"] / 2.0 * px_per_mm
    dilate = p["maskDilatePx"] * args.dpi / 600.0

    # Pass 3: per-page holes + masks + overlays.
    holes_all, rejected_all = {}, {}
    for fname, page_id in zip(pages, page_ids):
        h, w = shapes[page_id]
        cands = all_cands[page_id]
        page_clusters = [cl for cl in clusters if cl["left"] == page_is_left(page_id)]
        holes = []
        if clusters:
            used = set()
            for cl in page_clusters:
                best, best_d = None, None
                for i, c in enumerate(cands):
                    if i in used or not c["inRegion"]:
                        continue
                    d = math.hypot(c["cx"] - cl["cx"], c["cy"] - cl["cy"])
                    if d <= tol_px and (best_d is None or d < best_d):
                        best, best_d = i, d
                if best is not None and cands[best]["r"] <= max_r * 1.2:
                    c = cands[best]
                    used.add(best)
                    holes.append({"cx": c["cx"], "cy": c["cy"],
                                  "r": float(np.clip(max(c["r"], cl["r"]), min_r, max_r)),
                                  "circularity": c["circularity"], "source": "detected"})
                else:
                    holes.append({"cx": cl["cx"], "cy": cl["cy"], "r": float(np.clip(cl["r"], min_r, max_r)),
                                  "source": "cluster"})
            rejected = [dict(c, reason=reject_reason(c)) for i, c in enumerate(cands)
                        if i not in used and c["voter"]]
        else:
            holes = [{"cx": c["cx"], "cy": c["cy"], "r": c["r"], "circularity": c["circularity"],
                      "source": "detected"}
                     for c in cands if c["inRegion"] and c["sizeOk"] and c["circOk"]]
            rejected = [dict(c, reason=reject_reason(c)) for c in cands
                        if not (c["inRegion"] and c["sizeOk"] and c["circOk"])]

        if holes:
            holes_all[page_id] = holes
            mask = np.zeros((h, w), np.uint8)
            for hole in holes:
                cv2.circle(mask, (int(hole["cx"]), int(hole["cy"])), int(round(hole["r"] + dilate)), 255, -1)
            Image.fromarray(mask).save(os.path.join(args.output_dir, f"mask-page-{page_id}.png"))
        if rejected:
            rejected_all[page_id] = rejected

        # Overlay: green search regions, magenta cluster positions, red holes,
        # yellow unused candidates.
        vis = cv2.cvtColor(cv2.imread(os.path.join(args.input_dir, fname), cv2.IMREAD_GRAYSCALE),
                           cv2.COLOR_GRAY2BGR)
        lw = max(2, int(w / 300))
        fs = w / 1500.0
        for x0, y0, x1, y1 in all_regs[page_id]:
            cv2.rectangle(vis, (int(x0), int(y0)), (int(x1) - 1, int(y1) - 1), (0, 200, 0), lw)
        for cl in page_clusters:
            cv2.circle(vis, (int(cl["cx"]), int(cl["cy"])), int(cl["r"] + dilate), (200, 0, 200), lw)
        for c in cands:
            cv2.circle(vis, (int(c["cx"]), int(c["cy"])), max(4, int(c["r"])), (0, 220, 220), max(1, lw // 2))
        for hole in holes:
            cv2.circle(vis, (int(hole["cx"]), int(hole["cy"])), int(hole["r"]), (0, 0, 255), lw)
            cv2.putText(vis, hole["source"], (int(hole["cx"]) + int(hole["r"]) + 4, int(hole["cy"])),
                        cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 255), max(1, lw // 2))
        scale = 1000.0 / w
        vis = cv2.resize(vis, (1000, int(h * scale)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(args.debug_dir, f"overlay-page-{page_id}.jpg"), vis,
                    [cv2.IMWRITE_JPEG_QUALITY, 80])
        print(f"detect-holes: page {page_id}: {len(holes)} hole(s)"
              + (f" ({sum(1 for x in holes if x['source'] == 'cluster')} from cluster position)" if holes else ""))

    with open(os.path.join(args.output_dir, "holes.json"), "w") as f:
        json.dump(holes_all, f, indent=2)
    with open(os.path.join(args.debug_dir, "rejected.json"), "w") as f:
        json.dump(rejected_all, f, indent=2)


def reject_reason(c):
    if not c["inRegion"]:
        return "outside search region"
    if not c["sizeOk"]:
        return f"size r={c['r']:.0f}px out of range"
    if not c["circOk"]:
        return f"not circular ({c['circularity']:.2f})"
    return "not matched to a punch position"


if __name__ == "__main__":
    main()
