-- 0010_plan_ingest
--
-- A schematic is evidence, not truth. Two facts drive this schema:
--
-- 1. A vector drawing (DXF, SVG, vector PDF, IFC) already contains the geometry.
--    Parsing it is arithmetic — no model, no confidence, reproducible byte for
--    byte. A raster scan or a photo of a print does not, and any geometry derived
--    from pixels is a SUGGESTION that a human must confirm.
-- 2. Areas feed rent. Under LAW 1 no extracted number may become a charge on its
--    own, so every room carries `source` and `confidence`, and a room is only
--    usable once `confirmed_by` is set. `units.area_sqm` is not written by the
--    parser; it is written by an approved proposal.
--
-- The reconciliation gate (core: `reconcileAreas`) compares the sum of the rooms
-- against the area stated on the drawing or the deed. A 3% tolerance is the
-- industry baseline practitioners quote for manual takeoff (HN 46896474 reports
-- median <1.2% with a hard max of 5%); anything wider is a parsing failure, not a
-- drawing inaccuracy.

CREATE TABLE IF NOT EXISTS floor_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  building_id      uuid REFERENCES buildings(id) ON DELETE CASCADE,
  document_id      uuid REFERENCES documents(id) ON DELETE SET NULL,
  level            text NOT NULL,
  format           text NOT NULL CHECK (format IN ('svg', 'dxf', 'pdf_vector', 'pdf_raster', 'image', 'ifc')),
  drawing_unit     text NOT NULL CHECK (drawing_unit IN ('mm', 'cm', 'm', 'ft')),
  sha256           text,
  byte_size        integer CHECK (byte_size IS NULL OR byte_size > 0),
  status           text NOT NULL DEFAULT 'uploaded'
                   CHECK (status IN ('uploaded', 'parsed', 'reviewed', 'published', 'rejected')),
  stated_area_sqm  numeric CHECK (stated_area_sqm IS NULL OR stated_area_sqm > 0),
  parsed_by        text,
  parser_version   text,
  parsed_at        timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS floor_plans_property_idx ON floor_plans (organization_id, property_id);
CREATE UNIQUE INDEX IF NOT EXISTS floor_plans_property_level_uq
  ON floor_plans (property_id, level) WHERE status <> 'rejected';
-- The same file uploaded twice is the same plan; a re-upload must not create a
-- second geometry to disagree with the first.
CREATE UNIQUE INDEX IF NOT EXISTS floor_plans_sha_uq
  ON floor_plans (organization_id, sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan_rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  floor_plan_id   uuid NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
  code            text NOT NULL,
  label           text,
  room_kind       text NOT NULL DEFAULT 'unit'
                  CHECK (room_kind IN ('unit', 'bedroom', 'bath', 'kitchen', 'living',
                                       'corridor', 'shaft', 'balcony', 'terrace',
                                       'parking', 'common', 'storage', 'other')),
  area_sqm        numeric NOT NULL CHECK (area_sqm > 0),
  polygon         jsonb NOT NULL,
  source          text NOT NULL
                  CHECK (source IN ('vector_geometry', 'raster_model', 'manual')),
  confidence      numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  unit_id         uuid REFERENCES units(id) ON DELETE SET NULL,
  confirmed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (floor_plan_id, code)
);

-- A pixel-derived room is a guess, so it must carry its confidence. A
-- vector-derived room has no confidence to report: the arithmetic either closes
-- or it does not.
ALTER TABLE plan_rooms DROP CONSTRAINT IF EXISTS plan_rooms_confidence_ck;
ALTER TABLE plan_rooms
  ADD CONSTRAINT plan_rooms_confidence_ck
  CHECK (
    (source = 'raster_model' AND confidence IS NOT NULL)
    OR (source <> 'raster_model' AND confidence IS NULL)
  );

ALTER TABLE plan_rooms DROP CONSTRAINT IF EXISTS plan_rooms_confirmed_ck;
ALTER TABLE plan_rooms
  ADD CONSTRAINT plan_rooms_confirmed_ck
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL));

CREATE INDEX IF NOT EXISTS plan_rooms_plan_idx ON plan_rooms (floor_plan_id);
CREATE INDEX IF NOT EXISTS plan_rooms_unit_idx ON plan_rooms (unit_id) WHERE unit_id IS NOT NULL;

-- Provenance is append-only: what engine, what version, what it warned about.
CREATE TABLE IF NOT EXISTS plan_extractions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  floor_plan_id   uuid NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
  engine          text NOT NULL,
  engine_version  text NOT NULL,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_extractions_plan_idx ON plan_extractions (floor_plan_id, created_at);

-- Where an area came from. A lease's rentable area is a contract term; it may be
-- copied from a deed, read from a plan, measured on site, or typed by a human, and
-- the difference matters when a tenant disputes 4 square metres.
DO $$ BEGIN
  CREATE TYPE area_source AS ENUM ('deed', 'plan', 'measured', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS area_source area_source NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS area_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS area_confirmed_at timestamptz;
