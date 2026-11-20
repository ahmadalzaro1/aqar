# Schematics — uploading a drawing and having the system work on it

> Built and verified 2026-11-21. Migration `0010`, core `packages/core/src/plans/`,
> tests `packages/core/src/plans/plans.test.ts` (14) and
> `apps/worker/src/__tests__/plans.test.ts` (5, real Postgres).

## What the research says (primary sources, 2026-11-21)

The industry splits into two camps, and they disagree about the same thing:

**Camp 1 — computer vision does the extraction.** The canonical dataset is
[CubiCasa5k](https://github.com/CubiCasa) (5k annotated Finnish floor plans, 632★,
actively maintained). The strongest open replication is
[xmarva/floorplan-detection](https://github.com/xmarva/floorplan-detection):
MMDetection fine-tuned on CubiCasa5k, best model a **Cascade R-CNN at 0.47 box
mAP**, served by FastAPI + Docker. A solo ML engineer presenting to PropTech firms
reported ([HN 47092547](https://news.ycombinator.com/item?id=47092547)) a Swin +
Detectron2 **instance-segmentation** pipeline at **67.1% AP50 / 38.2% AP** (strict
0.50–0.95 IoU), <10 s per plan on CPU, with the masks passed through **Shapely**
boolean unions to get mathematically clean polygons. His own summary of the failure
mode matters: *"standard object detection or basic OCR (tested Qwen, DeepSeek) on
architectural plans fails instantly — walls intersect, door swings and dimension
lines heavily occlude the actual structures."*

**Camp 2 — CV is not worth it at this stage.** The Swiss Dwellings team
([HN 46896474](https://news.ycombinator.com/item?id=46896474)) built the pipeline and
then concluded the opposite: real archives are ~100-year-old drawings mixed with
modern exports, and *"even with decent models, you still pay heavily in expert
cleanup."* They optimised against the honest baseline — manual CAD-style annotation
with a constrained web editor (scale normalisation, closed rooms, openings must
attach to walls) plus **hard QA gates against external numeric truth**, at
**~3% tolerance, median area deviation <1.2%, hard max 5%** — and reached it at
**~1/10th the prevailing manual cost**. Their words: *"CV stopped being a clear
value add for this stage."*

**The synthesis that Aqar adopts:** the input class decides the pipeline, and only
one of the three is a model problem.

## Three lanes, by what the operator uploaded

| Upload | Lane | Deterministic? | Confidence |
|---|---|---|---|
| DXF / DWG, SVG, **vector** PDF, IFC | parse geometry directly | yes — arithmetic | none (it's exact) |
| raster scan, photo of a print, JPEG floor plan | segmentation model | no | required, human-confirmed |
| nothing usable | manual entry / LiDAR capture | n/a | manual |

**~all consultant drawings in Jordan arrive as DXF/DWG or PDF**, so lane 1 covers
most of the value and needs no model at all. This is why the slice built today is
lane 1.

## What exists now

- **`floor_plans`** — one row per uploaded drawing: property, level, `format`,
  declared `drawing_unit`, sha256 (the same file cannot become two plans), status,
  `stated_area_sqm`.
- **`plan_rooms`** — every closed shape the parser found, with `area_sqm`, the
  polygon, `room_kind`, `source` (`vector_geometry` | `raster_model` | `manual`),
  `confidence`, and `confirmed_by`/`confirmed_at`. A raster room **must** carry a
  confidence; a vector room **must not**; a confirmation without a name is refused.
- **`plan_extractions`** — append-only provenance: engine, version, params, stats,
  warnings.
- **`units.area_source`** (`deed` | `plan` | `measured` | `manual`) +
  `area_confirmed_by/at` — an area has a provenance, because a tenant disputing 4 m²
  is a dispute about where the number came from.
- **`packages/core/src/plans/geometry.ts`** — shoelace area, winding-agnostic,
  bow-tie (self-intersection) detection, unit conversion for mm/cm/m/ft, and
  **`reconcileAreas(rooms, statedSqm, tolerance = 0.03)`** which returns
  `within` / `outside` / `no_statement`.
- **`packages/core/src/plans/svg.ts`** — a bounded vector reader: `<rect>`,
  `<polygon>`, closed `<polyline>`, `<path>` with `M/L/H/V/Z` (absolute and
  relative). **Curves are refused, not flattened** — a bezier ring is a fixture or a
  title block, and turning it into 60.3 m² of confident nonsense is how a parse
  becomes a billing error.
- **`scaleWarnings()`** — refuses to silently convert: a 6×10 m flat declared in
  millimetres reports `too_small_for_a_space` instead of storing 0.00006 m².

## The gate that keeps this out of the ledger (LAW 1)

An extracted area is **evidence**. A room is usable only when
`confirmed_by` is set, and `units.area_sqm` is never written by a parser — it is
written by an approved proposal. `reconcileAreas` with a 3% tolerance is the
practitioner baseline quoted above, and a drawing outside it is a parsing failure,
not a drawing inaccuracy.

## The Python sidecar (`tools/plan-extractor`)

| Lane | Reader | Status |
|---|---|---|
| **DXF** | `ezdxf` 1.4.5 — closed `LWPOLYLINE`/`POLYLINE`, `HATCH` boundary paths | **working** |
| **DWG** | none — proprietary container | refused with `unsupported_format` |
| **Vector PDF** | `pymupdf` 2.1 — `page.get_drawings()` paths, `rect`/`line`/`quad` only | **working** |
| **Labels** | `TEXT`/`MTEXT` in DXF, text spans in PDF; each goes to the *smallest* ring containing it | **working** |
| Raster scan | CubiCasa/MMDetection | not wired — no weights, and the schema refuses an unconfidenced guess |
| SVG | `packages/core/src/plans/svg.ts` | working (in TS, no sidecar needed) |

Measured on the committed fixtures (`make_fixtures.py` generates both):

- `flats.dxf` in millimetres → `60.0 / 45.0 / 18.0 / 24.75` m², hatch `1.75` m²
  recognised as `bedroom`, labels `Flat 101`, `Flat 102`, **`شقة 103`** (Arabic
  survives the process boundary), bow-tie reported `self_intersecting` and excluded.
- `flats.pdf` at 1:50 → `60.0 / 45.0 / 18.0` m² **only with** `--calibrate`;
  without it `scale_known: false` and every `area_sqm` is `null`.

Bridge: `apps/worker/src/plans/extractor.ts` → `planExtractionSchema`
(`packages/contracts`). Tests: `apps/worker/src/__tests__/plan-extractor.test.ts`.

## Ingesting a drawing today

```bash
cd apps/worker
pnpm plan:ingest --file ../../tools/plan-extractor/fixtures/flats.dxf \
  --property "Al-Weibdeh Heritage Building" --level ground --stated 123
```

Writes `floor_plans` + `plan_rooms` (never `units.area_sqm`). Measured against the
live database on 2026-11-21: 5 rooms stored, lettable `60 + 45 + 18 = 123 m²`,
reconciled `within` against a stated 123 m², corridor 24.75 m² and the 1.75 m²
bedroom hatch stored but **excluded from the lettable sum** — a corridor is not
rentable, and a bedroom hatch is already inside its flat.

## The console (`/plans`)

`apps/web/src/app/(console)/plans/` — the first screen where a drawing becomes
something a person can decide about.

- **Upload** (`page.tsx` → `uploadPlanAction`): property, level, stated area, an
  optional PDF calibration line, and the file. 25 MB cap, `.dxf`/`.dwg`/`.pdf`
  only. The file is stored under `var/plans/<sha-prefix>.<ext>` and parsed by
  `@aqar/drawings` in the same request.
- **Review** (`[id]/page.tsx`): rooms with kind, area, source and confidence; the
  three-state reconciliation badge (`within` / `outside` / `no_statement`) computed
  in the browser session by `reconcileAreas`, not by the parser.
- **Confirm** (`confirmRoomAction`): writes `confirmed_by` + `confirmed_at`
  together. A half-confirmation is refused by the database, not by the form.
- **Propose** (`proposeUnitsAction`): inserts an `action_proposals` row
  (`plans.materialize` / `create_units_from_plan`, `status='pending'`) containing
  only *confirmed* unit rooms. Nothing touches `units`.

Verified in a real browser against the live database on 2026-11-21: uploaded
`flats.dxf` through the form, the review page listed 5 rooms (`60 / 45 / 18`
lettable, corridor and hatch excluded), confirming `LWPOLYLINE-1` wrote
`confirmed_by` + `confirmed_at`, and proposing created exactly one pending
proposal for that one confirmed unit. Re-uploading the same file to the same
level returned the **same plan id** — the upsert updates, it does not duplicate.

## Two schema corrections found by using it

- **0011** narrowed the drawing hash index to `(org, property, level, sha256)`.
- **0012** dropped it entirely: reading the catalog showed
  `floor_plans_property_level_uq` (`property_id, level WHERE status <> 'rejected'`)
  already says one plan per level per property, whatever the file. The hash index
  was redundant where it fired, and actively wrong where it did not — a compound's
  two identical blocks, and the same stamped drawing issued twice, are ordinary.
  Duplicate detection belongs in the upload path as a warning, not in the schema
  as a refusal. `plan:ingest` now upserts on `(property_id, level)`.

## Not built (honest gaps)

1. **Raster lane** — no CubiCasa/MMDetection inference wired; the schema and the
   `confidence` contract exist and refuse a guess without one.
2. **Console UI** — no upload screen, no plan review screen, no proposal →
   `units.area_sqm` flow yet.
3. **DXF block references and nested inserts** — geometry inside an `INSERT` is not
   expanded yet, so a drawing whose rooms live in blocks reads as empty.
4. **Boolean wall unions** — `ezdxf-shapely` is installed but wall centrelines are
   not yet merged into room rings; rooms must already be drawn closed or hatched.
5. **Twitter/X sweep blocked** — the X session returned HTTP 429 (search quota) on
   four attempts at 00:42–00:58; research above is from HN, GitHub and product
   pages instead. Retry after cooldown.
