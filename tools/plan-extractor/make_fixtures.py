#!/usr/bin/env python3
"""Generate the two drawings the extractor tests run against.

They are synthetic on purpose: a real client drawing cannot be committed to a public
repo, and a fixture whose areas a human can compute by hand ("6 m x 10 m is 60 m²")
is a better test than a golden file nobody can verify.
"""

from pathlib import Path

import ezdxf
import pymupdf

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures"
FIXTURES.mkdir(exist_ok=True)


def make_dxf(path: Path) -> None:
    doc = ezdxf.new("R2018")
    doc.header["$INSUNITS"] = 4  # millimetres, what AutoCAD writes for a local plan
    msp = doc.modelspace()
    doc.layers.add("UNITS")
    doc.layers.add("COMMON")

    def room(code: str, x: float, y: float, w: float, h: float, label: str, layer: str = "UNITS") -> None:
        msp.add_lwpolyline(
            [(x, y), (x + w, y), (x + w, y + h), (x, y + h)],
            close=True,
            dxfattribs={"layer": layer},
        )
        text = msp.add_mtext(label, dxfattribs={"layer": layer})
        text.dxf.insert = (x + w / 2, y + h / 2)

    room("101", 0, 0, 6000, 10000, "Flat 101")
    room("102", 6000, 0, 4500, 10000, "Flat 102")
    room("103", 10500, 0, 6000, 3000, "شقة 103")
    room("C1", 0, 10000, 16500, 1500, "Corridor", layer="COMMON")

    # A hatched room, which is how most architects draw bedrooms.
    hatch = msp.add_hatch(dxfattribs={"layer": "UNITS"})
    hatch.paths.add_polyline_path(
        [(9800, 3000), (10500, 3000), (10500, 5500), (9800, 5500)], is_closed=True
    )
    bedroom = msp.add_mtext("Bedroom 1", dxfattribs={"layer": "UNITS"})
    bedroom.dxf.insert = (10100, 4200)

    # An open polyline is a wall run, not a room: it must not become area.
    msp.add_lwpolyline([(0, 11000), (16500, 11000)], dxfattribs={"layer": "COMMON"})

    # A bow-tie: well-defined shoelace area, entirely wrong answer.
    msp.add_lwpolyline([(17000, 0), (21000, 4000), (21000, 0), (17000, 4000)], close=True, dxfattribs={"layer": "COMMON"})

    doc.saveas(path)


def make_pdf(path: Path) -> None:
    """A 1:50 plan: 1 mm on paper = 50 mm on the ground = 2.8346 pt on paper."""
    doc = pymupdf.open()
    page = doc.new_page(width=842, height=595)  # A4 landscape, points
    pt_per_metre = (1000 / 50) / (25.4 / 72)  # 56.69 pt per ground metre

    def room(x_m: float, y_m: float, w_m: float, h_m: float, label: str) -> None:
        rect = pymupdf.Rect(
            60 + x_m * pt_per_metre,
            60 + y_m * pt_per_metre,
            60 + (x_m + w_m) * pt_per_metre,
            60 + (y_m + h_m) * pt_per_metre,
        )
        page.draw_rect(rect, color=(0, 0, 0), width=0.5)
        page.insert_text((rect.x0 + 8, rect.y0 + 14), label, fontsize=6)

    room(0, 0, 6, 10, "Flat 101")
    room(6, 0, 4.5, 10, "Flat 102")
    room(10.5, 0, 6, 3, "Flat 103")
    doc.save(str(path))
    doc.close()


if __name__ == "__main__":
    make_dxf(FIXTURES / "flats.dxf")
    make_pdf(FIXTURES / "flats.pdf")
    print("wrote", FIXTURES / "flats.dxf", FIXTURES / "flats.pdf")
