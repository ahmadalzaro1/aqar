#!/usr/bin/env python3
"""Plan extractor: the lane where geometry is arithmetic.

Reads a *vector* drawing and reports the closed shapes it genuinely contains, plus
the text that sits inside them. Two formats matter here, because they are what
property managers in Amman are actually handed:

  DXF  — native AutoCAD exchange; the surveyor's and the draughtsman's output.
  PDF  — vector (not scanned); the consultant's stamped drawing.

What this program refuses to do:

  * guess a scale. A PDF has no absolute units: 350 points across the page could be
    35 m or 12 m. Without a calibration the areas are reported in points² and the
    result is marked `scale_unknown`, because a confident square metre count that
    is off by 30% is worse than no number.
  * read DWG. It is a proprietary container; ezdxf does not parse it. The honest
    answer is "convert it with ODA File Converter or ask for the DXF", and that is
    what the error says.
  * flatten curves into polygons. A curved boundary is a fixture, a title block or a
    detail bubble far more often than it is a room.

Output contract (stdout, UTF-8 JSON): see `docs/PLANS.md`.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any, Iterable

# $INSUNITS header code -> (unit, millimetres per unit)
INSUNITS: dict[int, tuple[str, float]] = {
    1: ("in", 25.4),
    2: ("ft", 304.8),
    4: ("mm", 1.0),
    5: ("cm", 10.0),
    6: ("m", 1000.0),
}
# Everything downstream reports millimetres unless told otherwise, because that is
# the unit AutoCAD itself defaults to and the one no conversion can drift in.
UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "ft": 304.8, "in": 25.4, "pt": 25.4 / 72.0}

KIND_HINTS: list[tuple[tuple[str, ...], str]] = [
    (("flat", "apartment", "apt", "unit", "شقة", "شقه"), "unit"),
    (("bed", "bedroom", "غرفة نوم", "غرفه نوم"), "bedroom"),
    (("bath", "wc", "toilet", "حمام"), "bath"),
    (("kitchen", "مطبخ"), "kitchen"),
    (("living", "salon", "reception", "صالة", "صالون", "معيشة"), "living"),
    (("corridor", "hall", "passage", "ممر", "كوريدور"), "corridor"),
    (("shaft", "riser", "duct", "منور"), "shaft"),
    (("balcon", "terrace", "بلكون", "شرفة"), "balcony"),
    (("park", "garage", "موقف", "كراج"), "parking"),
    (("store", "storage", "مخزن"), "storage"),
    (("shop", "retail", "محل"), "unit"),
    (("office", "مكتب"), "unit"),
    (("stair", "elevator", "lift", "سلم", "مصعد"), "common"),
]


def hint_for(label: str | None) -> str | None:
    if not label:
        return None
    low = label.lower()
    for needles, kind in KIND_HINTS:
        if any(needle in low for needle in needles):
            return kind
    return None


def dedupe(points: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for point in points:
        if not out or point != out[-1]:
            out.append(point)
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def polygon_area(points: list[tuple[float, float]]) -> float:
    """Shoelace, absolute. Matches packages/core/src/plans/geometry.ts."""
    if len(points) < 3:
        return 0.0
    total = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def self_intersects(points: list[tuple[float, float]]) -> bool:
    """True when the ring crosses itself. Kept dependency-free so it always agrees
    with the TypeScript implementation, which is the one that gates the ledger."""
    n = len(points)
    if n < 4:
        return False

    def orient(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def intersects(p1, p2, p3, p4) -> bool:
        d1, d2 = orient(p3, p4, p1), orient(p3, p4, p2)
        d3, d4 = orient(p1, p2, p3), orient(p1, p2, p4)
        eps = 1e-9
        return (d1 > eps) != (d2 > eps) and (d3 > eps) != (d4 > eps)

    for i in range(n):
        a1, a2 = points[i], points[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            b1, b2 = points[j], points[(j + 1) % n]
            if intersects(a1, a2, b1, b2):
                return True
    return False


def point_in_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    """Ray casting; boundaries count as inside, matching shapely's `covers`."""
    x, y = point
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if _on_segment(x1, y1, x2, y2, x, y):
            return True
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


def _on_segment(x1: float, y1: float, x2: float, y2: float, x: float, y: float) -> bool:
    cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
    if abs(cross) > 1e-7:
        return False
    return min(x1, x2) - 1e-7 <= x <= max(x1, x2) + 1e-7 and min(y1, y2) - 1e-7 <= y <= max(y1, y2) + 1e-7


def finish_shape(
    code: str,
    points: list[tuple[float, float]],
    unit: str,
    mm_per_unit: float,
    layer: str | None,
    kind_default: str,
    warnings: list[dict[str, Any]],
) -> dict[str, Any] | None:
    ring = dedupe(points)
    if len(ring) < 3:
        warnings.append({"code": code, "reason": "not_enough_points"})
        return None
    if self_intersects(ring):
        warnings.append({"code": code, "reason": "self_intersecting"})
        return None
    area_units = polygon_area(ring)
    if area_units <= 0:
        warnings.append({"code": code, "reason": "degenerate_area"})
        return None
    area_mm2 = area_units * mm_per_unit * mm_per_unit
    return {
        "code": code,
        "layer": layer,
        "ring": [[round(x, 4), round(y, 4)] for x, y in ring],
        "area_units": round(area_units, 4),
        "area_sqm": round(area_mm2 / 1_000_000.0, 3),
        "room_kind": kind_default,
        "label": None,
    }


def assign_labels(shapes: list[dict[str, Any]], texts: list[dict[str, Any]], warnings: list[dict[str, Any]]) -> None:
    """Each text belongs to the smallest shape that contains it — a room number
    inside a flat inside a floor plate should label the flat, not the plate."""
    for text in texts:
        best: dict[str, Any] | None = None
        for shape in shapes:
            if not point_in_polygon((text["x"], text["y"]), [tuple(p) for p in shape["ring"]]):
                continue
            if best is None or shape["area_units"] < best["area_units"]:
                best = shape
        if best is None:
            text["assigned_to"] = None
            continue
        text["assigned_to"] = best["code"]
        if best["label"] is None:
            best["label"] = text["text"]
            best["room_kind"] = hint_for(text["text"]) or best["room_kind"]
        else:
            # Two labels in one room is normal — a number and a name ("101", "Flat
            # 101"). Keep the longer one as the label, keep both in `labels`.
            best.setdefault("labels", [best["label"]]).append(text["text"])
            if len(text["text"]) > len(best["label"] or ""):
                best["label"] = text["text"]
                best["room_kind"] = hint_for(text["text"]) or best["room_kind"]
    # Two closed shapes that overlap without nesting are two representations of one
    # thing (a polyline room and a hatch over part of it). Geometry alone cannot say
    # which is the room, so say so instead of picking silently.
    for i, a in enumerate(shapes):
        for b in shapes[i + 1:]:
            if _bbox_overlap_ratio(a["ring"], b["ring"]) > 0.5:
                warnings.append({"reason": "overlapping_shapes", "a": a["code"], "b": b["code"]})
    unassigned = [t for t in texts if t["assigned_to"] is None]
    if unassigned:
        warnings.append({"reason": "text_outside_any_shape", "count": len(unassigned)})


def _bbox_overlap_ratio(a: list[list[float]], b: list[list[float]]) -> float:
    ax1 = min(p[0] for p in a); ax2 = max(p[0] for p in a)
    ay1 = min(p[1] for p in a); ay2 = max(p[1] for p in a)
    bx1 = min(p[0] for p in b); bx2 = max(p[0] for p in b)
    by1 = min(p[1] for p in b); by2 = max(p[1] for p in b)
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    smaller = min((ax2 - ax1) * (ay2 - ay1), (bx2 - bx1) * (by2 - by1))
    return inter / smaller if smaller > 0 else 0.0


def read_dxf(path: str, declared_unit: str | None) -> dict[str, Any]:
    import ezdxf
    from ezdxf.document import Drawing

    warnings: list[dict[str, Any]] = []
    try:
        doc: Drawing = ezdxf.readfile(path)
    except IOError as exc:
        raise SystemExit(json.dumps({"error": "unreadable_file", "detail": str(exc)}))
    except ezdxf.DXFStructureError as exc:
        raise SystemExit(json.dumps({"error": "dxf_structure_error", "detail": str(exc)}))

    insunits = doc.header.get("$INSUNITS", 0)
    detected = INSUNITS.get(int(insunits)) if insunits else None
    if detected is not None:
        unit, mm_per_unit = detected
        unit_source = "insunits"
        if declared_unit is not None and declared_unit != unit:
            warnings.append({"reason": "unit_override", "insunits": unit, "declared": declared_unit})
            unit, mm_per_unit, unit_source = declared_unit, UNIT_MM[declared_unit], "declared"
    else:
        unit = declared_unit or "mm"
        mm_per_unit = UNIT_MM[unit]
        unit_source = "declared" if declared_unit else "default_mm"
        if declared_unit is None:
            warnings.append({"reason": "unit_assumed", "unit": unit, "insunits": int(insunits or 0)})

    msp = doc.modelspace()
    shapes: list[dict[str, Any]] = []
    texts: list[dict[str, Any]] = []

    for entity in msp:
        kind = entity.dxftype()
        layer = getattr(entity.dxf, "layer", None)
        try:
            if kind == "LWPOLYLINE" and entity.closed:
                points = [(float(p[0]), float(p[1])) for p in entity.get_points("xy")]
                shape = finish_shape(f"{kind}-{len(shapes) + 1}", points, unit, mm_per_unit, layer, "unit", warnings)
                if shape:
                    shapes.append(shape)
            elif kind == "POLYLINE" and entity.is_2d_polyline and entity.is_closed:
                points = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in entity.vertices]
                shape = finish_shape(f"{kind}-{len(shapes) + 1}", points, unit, mm_per_unit, layer, "unit", warnings)
                if shape:
                    shapes.append(shape)
            elif kind == "HATCH":
                # Architects hatch rooms far more consistently than they polyline
                # them, so the hatch boundary is often the only closed ring present.
                for index, hatch_path in enumerate(entity.paths, start=1):
                    if not getattr(hatch_path, "is_closed", False):
                        continue
                    if not hasattr(hatch_path, "vertices"):
                        warnings.append({"reason": "hatch_path_not_polyline", "layer": layer})
                        continue
                    points = [(float(v[0]), float(v[1])) for v in hatch_path.vertices]
                    code = f"HATCH-{len(shapes) + 1}-{index}"
                    shape = finish_shape(code, points, unit, mm_per_unit, layer, "unit", warnings)
                    if shape:
                        shapes.append(shape)
            elif kind == "TEXT":
                texts.append({"text": entity.dxf.text.strip(), "x": float(entity.dxf.insert.x), "y": float(entity.dxf.insert.y)})
            elif kind == "MTEXT":
                texts.append({"text": entity.plain_text().strip(), "x": float(entity.dxf.insert.x), "y": float(entity.dxf.insert.y)})
        except Exception as exc:  # noqa: BLE001 - one bad entity must not lose the drawing
            warnings.append({"reason": "entity_failed", "entity": kind, "detail": str(exc)})

    texts = [t for t in texts if t["text"]]
    assign_labels(shapes, texts, warnings)
    for shape in shapes:
        shape.pop("labels", None) if shape.get("labels") is None else None
    return {
        "engine": "ezdxf",
        "engine_version": ezdxf.__version__,
        "format": "dxf",
        "unit": unit,
        "unit_source": unit_source,
        "mm_per_unit": mm_per_unit,
        "scale_known": True,
        "shapes": shapes,
        "texts": texts,
        "warnings": warnings,
        "stats": {"shapes": len(shapes), "texts": len(texts), "entities": len(msp), "layers": len(doc.layers)},
    }


def read_pdf(path: str, declared_unit: str | None, calibrate: str | None) -> dict[str, Any]:
    """Vector PDF. Geometry arrives in points; a scale is required to leave points.

    `--calibrate x1,y1,x2,y2,metres` is how a human says "this dimension line is
    6.20 m". Without it, areas are reported in points² and `scale_known` is false:
    the drawing is still readable, just not billable.
    """
    import pymupdf

    warnings: list[dict[str, Any]] = []
    doc = pymupdf.open(path)
    page = doc[0]
    shapes: list[dict[str, Any]] = []
    texts: list[dict[str, Any]] = []

    for drawing_index, drawing in enumerate(page.get_drawings(), start=1):
        items = drawing.get("items") or []
        if not drawing.get("closePath") and not _items_form_loop(items):
            continue
        points: list[tuple[float, float]] = []
        curves = 0
        for item in items:
            kind = item[0]
            if kind == "l":
                start, end = item[1], item[2]
                points.append((float(start.x), float(start.y)))
                points.append((float(end.x), float(end.y)))
            elif kind == "re":
                rect = item[1]
                points.extend(_rect_points(rect))
            elif kind == "qu":
                quad = item[1]
                points.extend([(float(quad.ul.x), float(quad.ul.y)), (float(quad.ur.x), float(quad.ur.y)),
                               (float(quad.lr.x), float(quad.lr.y)), (float(quad.ll.x), float(quad.ll.y))])
            else:
                curves += 1
        if curves:
            warnings.append({"reason": "curves_ignored", "drawing": drawing_index, "curves": curves})
            continue
        shape = finish_shape(f"PATH-{drawing_index}", points, "pt", 25.4 / 72.0, drawing.get("layer"), "unit", warnings)
        if shape:
            shapes.append(shape)

    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "").strip()
                if not text:
                    continue
                x0, y0, x1, y1 = span["bbox"]
                texts.append({"text": text, "x": (x0 + x1) / 2, "y": (y0 + y1) / 2})

    assign_labels(shapes, texts, warnings)

    mm_per_unit = 25.4 / 72.0  # one PDF point in millimetres, if scale is 1:1
    scale_known = False
    unit = "pt"
    unit_source = "pdf_points"
    if calibrate:
        try:
            x1, y1, x2, y2, metres = (float(part) for part in calibrate.split(","))
            span_pt = math.hypot(x2 - x1, y2 - y1)
            if span_pt <= 0 or metres <= 0:
                raise ValueError("calibration must describe two distinct points and a positive length")
            mm_per_unit = (metres * 1000.0) / span_pt
            scale_known = True
            unit_source = "calibrated"
            unit = "calibrated_mm_per_pt"
        except ValueError as exc:
            warnings.append({"reason": "calibration_failed", "detail": str(exc)})
    elif declared_unit is not None:
        # A declared document unit is a claim about the *drawing*, not the page
        # scale: two PDFs of the same plan at 1:50 and 1:100 are pixel-comparable.
        warnings.append({"reason": "declared_unit_insufficient_for_pdf", "declared": declared_unit})

    # Areas were computed in points; the scale decides whether they can leave points.
    for shape in shapes:
        unscaled_units = shape["area_units"]
        if scale_known:
            shape["area_sqm"] = round(unscaled_units * mm_per_unit * mm_per_unit / 1_000_000.0, 3)
        else:
            shape["area_sqm_unscaled_points2"] = unscaled_units
            shape["area_sqm"] = None
    if not scale_known:
        warnings.append({"reason": "scale_unknown", "detail": "supply --calibrate x1,y1,x2,y2,metres"})

    return {
        "engine": "pymupdf",
        "engine_version": pymupdf.__version__,
        "format": "pdf_vector",
        "unit": unit,
        "unit_source": unit_source,
        "mm_per_unit": mm_per_unit,
        "scale_known": scale_known,
        "page": {"width_pt": page.rect.width, "height_pt": page.rect.height, "pages": len(doc)},
        "shapes": shapes,
        "texts": texts,
        "warnings": warnings,
        "stats": {"shapes": len(shapes), "texts": len(texts), "drawings": len(page.get_drawings())},
    }


def _rect_points(rect: Any) -> list[tuple[float, float]]:
    return [(float(rect.x0), float(rect.y0)), (float(rect.x1), float(rect.y0)),
            (float(rect.x1), float(rect.y1)), (float(rect.x0), float(rect.y1))]


def _items_form_loop(items: list[Any]) -> bool:
    if not items:
        return False
    first_kind = items[0][0]
    if first_kind == "re":
        return True
    if first_kind != "l":
        return False
    start = items[0][1]
    end = items[-1][2]
    return abs(start.x - end.x) < 1e-6 and abs(start.y - end.y) < 1e-6


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract rooms from a vector plan.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--format", required=True, choices=["dxf", "pdf", "dwg"])
    parser.add_argument("--unit", default=None, choices=sorted(UNIT_MM.keys()))
    parser.add_argument("--calibrate", default=None)
    args = parser.parse_args()

    if args.format == "dwg":
        print(json.dumps({
            "error": "unsupported_format",
            "detail": "DWG is a proprietary container; convert to DXF (ODA File Converter) or export a vector PDF.",
        }))
        sys.exit(3)

    if args.format == "dxf":
        result = read_dxf(args.file, args.unit)
    else:
        result = read_pdf(args.file, args.unit, args.calibrate)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
