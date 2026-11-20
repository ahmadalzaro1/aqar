# plan-extractor

Reads the geometry out of a **vector** plan and reports it as JSON. This is the
lane where extraction is arithmetic: DXF and vector PDF already contain the room
boundaries, so no model is involved and no confidence is reported.

```bash
cd tools/plan-extractor
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python ezdxf ezdxf-shapely pymupdf shapely

.venv/bin/python make_fixtures.py                       # regenerate the test drawings
.venv/bin/python extract.py --file fixtures/flats.dxf --format dxf
.venv/bin/python extract.py --file fixtures/flats.pdf --format pdf --calibrate 60,60,60,626.93,10
.venv/bin/python extract.py --file fixtures/walls.dxf --format dxf      # walls only -> polygonized faces
.venv/bin/python extract.py --file fixtures/walls-open.dxf --format dxf # encloses nothing -> refused
```

The worker calls it through `apps/worker/src/plans/extractor.ts`, which validates
the output against `planExtractionSchema` in `packages/contracts`.

## What it will not do

- **Guess a scale for a PDF.** A vector PDF has no absolute units; without
  `--calibrate x1,y1,x2,y2,metres` the areas are returned as `null` with
  `scale_unknown`, and the drawing is readable but not billable.
- **Read DWG.** Proprietary container; convert with ODA File Converter or ask for
  the DXF. The error says exactly that.
- **Flatten curves.** A curved boundary is a fixture or a detail bubble far more
  often than a room.
- **Trust an overlapping pair of closed shapes.** If two rings overlap without
  nesting it emits `overlapping_shapes` and lets a human decide which is the room.
