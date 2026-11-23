-- Ground-level context apron for the aqar 3D view (apps/web/public/geo/amman-context.geojson).
-- Source: Overture Maps release 2026-11-18.0, theme=buildings, licence ODbL —
-- the attribution is rendered in the legend and must stay there.
--
-- Shape: 320 m around each recorded site, our own massing excluded (<= 25 m),
-- geometry simplified at 2e-5 deg (~2 m) so the whole apron is one ~184 KB static
-- GeoJSON. Only 0.1% of these footprints record a height, so every building is
-- drawn flat grey and the legend says the height is unknown.
--
-- Run:  duckdb -no-agent -c ".read infra/geo/apron.sql"   (needs spatial + httpfs)
-- Then: python3 tools/geo/apron_to_geojson.py             (rows.csv -> GeoJSON)

LOAD spatial;
LOAD httpfs;
SET geometry_always_xy = true;

-- 320 m apron around each recorded site; our own massing occupies the middle.
CREATE TEMP TABLE s AS
SELECT * FROM (VALUES
  ('e0b64ed7-eb5e-5de2-aa38-676bdec6813d', 'Abdoun',  ST_Point(35.8792, 31.9441)),
  ('8afebd74-c284-56bc-ad24-99dd1fb94830', 'Weibdeh', ST_Point(35.9239, 31.9512))
) t(site_id, site, c);

CREATE TEMP TABLE b AS
SELECT geometry, class, num_floors, names.primary AS name, ST_Centroid(geometry) AS pt
FROM read_parquet(
  's3://overturemaps-us-west-2/release/2026-11-18.0/theme=buildings/type=building/*',
  hive_partitioning=1)
WHERE bbox.xmin > 35.876 AND bbox.xmax < 35.928
  AND bbox.ymin > 31.940 AND bbox.ymax < 31.955;

COPY (
  SELECT
    s.site_id,
    s.site,
    b.class,
    b.num_floors,
    b.name,
    ST_AsGeoJSON(ST_SimplifyPreserveTopology(b.geometry, 0.00002)) AS geom
  FROM s
  JOIN b ON ST_Distance_Sphere(b.pt, s.c) <= 320
  WHERE ST_Distance_Sphere(b.pt, s.c) > 25
) TO '/Users/syntaxstudio/HERMES/aqar-demo/apps/web/public/geo/rows.csv' (HEADER, DELIMITER ',');