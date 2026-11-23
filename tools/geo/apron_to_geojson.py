#!/usr/bin/env python3
"""rows.csv (DuckDB COPY output) -> the static GeoJSON the map layer fetches.

Separate from the SQL because the SQL's job is measurement and this file's job is
payload shape. Coordinates are rounded to 1e-6 deg (~10 cm): far below what a z19
camera can resolve, materially smaller on the wire.
"""
import csv, json, sys
from pathlib import Path

src = Path(sys.argv[1] if len(sys.argv) > 1 else "apps/web/public/geo/rows.csv")
out = Path(sys.argv[2] if len(sys.argv) > 2 else "apps/web/public/geo/amman-context.geojson")


def rounded(c):
    return [round(c[0], 6), round(c[1], 6)]


features = []
with src.open() as fh:
    for row in csv.DictReader(fh):
        try:
            geom = json.loads(row["geom"])
        except (KeyError, json.JSONDecodeError):
            continue
        if geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        if geom["type"] == "Polygon":
            geom["coordinates"] = [[rounded(c) for c in ring] for ring in geom["coordinates"]]
        else:
            geom["coordinates"] = [
                [[rounded(c) for c in ring] for ring in poly] for poly in geom["coordinates"]
            ]
        features.append(
            {
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "site": row["site_id"],
                    "class": row["class"] or "unknown",
                    "floors": int(row["num_floors"]) if row["num_floors"] else None,
                    "name": row["name"] or None,
                },
            }
        )

out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
print(f"{len(features)} footprints -> {out} ({out.stat().st_size / 1024:.0f} KB)")
