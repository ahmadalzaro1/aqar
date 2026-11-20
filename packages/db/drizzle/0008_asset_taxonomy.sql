-- 0008_asset_taxonomy
--
-- The v1 model had exactly one kind of lettable thing, and it was a flat:
-- `units` required `building_id` and required `bedrooms`/`bathrooms`. A plot of
-- land cannot satisfy either, a warehouse has no bedrooms, and a shop's defining
-- attribute (frontage, display windows, a roller shutter) had nowhere to live.
-- So the ontology could only describe one asset class in a market that rents
-- land, warehouses, showrooms, farms and rooftops.
--
-- Two levels are now explicit, because conflating them is the original defect:
--
--   properties  = the ASSET. A registered parcel or title. It has zoning, a
--                 deed, a land area, and a kind (parcel/building/compound/...).
--                 An asset is not necessarily lettable as a whole.
--   units       = the LETTABLE SPACE. What a lease points at. `space_kind`
--                 says what it is, and a 1:1 detail table carries the
--                 attributes that only that kind has.
--
-- The detail tables are class-table inheritance, not JSONB. A shop's frontage is
-- a number a human negotiates and a lease may reference, so it gets a column, a
-- type and a CHECK — not a key inside a blob that no constraint can police.

-- ---------------------------------------------------------------- asset kinds
DO $$ BEGIN
  CREATE TYPE asset_kind AS ENUM ('parcel', 'building', 'compound', 'tower', 'farm', 'mixed_use', 'infrastructure');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS asset_kind asset_kind NOT NULL DEFAULT 'building',
  ADD COLUMN IF NOT EXISTS zoning text,
  ADD COLUMN IF NOT EXISTS land_area_sqm numeric,
  ADD COLUMN IF NOT EXISTS deed_number text,
  ADD COLUMN IF NOT EXISTS deed_date date;

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_zoning_ck;
ALTER TABLE properties
  ADD CONSTRAINT properties_zoning_ck
  CHECK (zoning IS NULL OR zoning IN (
    'residential', 'commercial', 'industrial', 'agricultural', 'mixed',
    'touristic', 'educational', 'health', 'religious', 'public', 'military'
  ));

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_land_area_ck;
ALTER TABLE properties
  ADD CONSTRAINT properties_land_area_ck
  CHECK (land_area_sqm IS NULL OR land_area_sqm > 0);

-- A parcel is land by definition, so it must not claim a building's attributes.
ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_parcel_ck;
ALTER TABLE properties
  ADD CONSTRAINT properties_parcel_ck
  CHECK (asset_kind <> 'parcel' OR building_name IS NULL);

-- ---------------------------------------------------------------- space kinds
DO $$ BEGIN
  CREATE TYPE space_kind AS ENUM (
    'flat', 'villa', 'staff_housing', 'labour_camp',
    'office', 'shop', 'showroom', 'workshop', 'warehouse', 'cold_store',
    'land', 'farm', 'rooftop', 'parking', 'signage'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE units ADD COLUMN IF NOT EXISTS space_kind space_kind NOT NULL DEFAULT 'flat';

-- Land has no building to belong to; bedrooms are a residential attribute.
ALTER TABLE units ALTER COLUMN building_id DROP NOT NULL;
ALTER TABLE units ALTER COLUMN bedrooms   DROP NOT NULL;
ALTER TABLE units ALTER COLUMN bathrooms  DROP NOT NULL;

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_residential_counts_ck;
ALTER TABLE units
  ADD CONSTRAINT units_residential_counts_ck
  CHECK (
    space_kind NOT IN ('flat', 'villa', 'staff_housing', 'labour_camp')
    OR (bedrooms IS NOT NULL AND bathrooms IS NOT NULL)
  );

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_nonresidential_counts_ck;
ALTER TABLE units
  ADD CONSTRAINT units_nonresidential_counts_ck
  CHECK (
    space_kind IN ('flat', 'villa', 'staff_housing', 'labour_camp')
    OR (bedrooms IS NULL AND bathrooms IS NULL)
  );

-- Three kinds stand on the ground (or on a roof): they have no building row.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_building_ck;
ALTER TABLE units
  ADD CONSTRAINT units_building_ck
  CHECK (
    CASE space_kind
      WHEN 'land' THEN building_id IS NULL
      WHEN 'farm' THEN building_id IS NULL
      WHEN 'rooftop' THEN building_id IS NULL
      WHEN 'signage' THEN building_id IS NULL
      WHEN 'parking' THEN TRUE  -- a lot has no building; a basement bay does
      ELSE building_id IS NOT NULL
    END
  );

-- ---------------------------------------------------------- kind guard trigger
-- A detail row must belong to a space of its own kind. Without this, a shop's
-- frontage could be attached to a flat and every downstream report would be
-- wrong while every constraint stayed satisfied.
CREATE OR REPLACE FUNCTION unit_detail_kind_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected text := tg_argv[0];
  actual   text;
BEGIN
  SELECT space_kind::text INTO actual FROM units WHERE id = NEW.unit_id;
  IF actual IS NULL THEN
    RAISE EXCEPTION 'unit % does not exist', NEW.unit_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF actual <> expected THEN
    RAISE EXCEPTION 'unit % is a %, so it cannot have % detail', NEW.unit_id, actual, expected
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ------------------------------------------------------------- detail tables
CREATE TABLE IF NOT EXISTS unit_residential_detail (
  unit_id     uuid PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  square_m    numeric CHECK (square_m IS NULL OR square_m > 0),
  furnished   boolean NOT NULL DEFAULT false,
  has_balcony boolean NOT NULL DEFAULT false,
  has_parking boolean NOT NULL DEFAULT false,
  floor_number integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unit_commercial_detail (
  unit_id           uuid PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  frontage_m        numeric CHECK (frontage_m IS NULL OR frontage_m > 0),
  display_windows   integer NOT NULL DEFAULT 0 CHECK (display_windows >= 0),
  roller_shutter    boolean NOT NULL DEFAULT true,
  mezzanine_sqm     numeric CHECK (mezzanine_sqm IS NULL OR mezzanine_sqm > 0),
  permitted_use     text,
  fit_out           text CHECK (fit_out IS NULL OR fit_out IN ('shell', 'semi_fitted', 'fitted', 'turnkey')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unit_industrial_detail (
  unit_id             uuid PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  clear_height_m      numeric CHECK (clear_height_m IS NULL OR clear_height_m > 0),
  floor_load_kg_sqm   integer CHECK (floor_load_kg_sqm IS NULL OR floor_load_kg_sqm > 0),
  dock_doors          integer NOT NULL DEFAULT 0 CHECK (dock_doors >= 0),
  three_phase_power   boolean NOT NULL DEFAULT false,
  yard_sqm            numeric CHECK (yard_sqm IS NULL OR yard_sqm > 0),
  temperature_c       integer,
  permitted_use       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unit_land_detail (
  unit_id           uuid PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  plot_number       text,
  plot_area_sqm     numeric CHECK (plot_area_sqm IS NULL OR plot_area_sqm > 0),
  max_far           numeric CHECK (max_far IS NULL OR max_far > 0),
  max_height_m      numeric CHECK (max_height_m IS NULL OR max_height_m > 0),
  is_corner         boolean NOT NULL DEFAULT false,
  has_water_meter   boolean NOT NULL DEFAULT false,
  has_power_meter   boolean NOT NULL DEFAULT false,
  current_use       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unit_farm_detail (
  unit_id            uuid PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  area_dunums        numeric CHECK (area_dunums IS NULL OR area_dunums > 0),
  well_count         integer NOT NULL DEFAULT 0 CHECK (well_count >= 0),
  water_rights_m3    numeric CHECK (water_rights_m3 IS NULL OR water_rights_m3 >= 0),
  greenhouse_count   integer NOT NULL DEFAULT 0 CHECK (greenhouse_count >= 0),
  soil_kind          text,
  planted_crop       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unit_rooftop_detail (
  unit_id              uuid PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  load_capacity_kg_sqm integer CHECK (load_capacity_kg_sqm IS NULL OR load_capacity_kg_sqm > 0),
  access_kind          text CHECK (access_kind IS NULL OR access_kind IN ('stair', 'ladder', 'external_lift')),
  has_parapet          boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One trigger per family, because the expected kind is the argument.
DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('unit_residential_detail', 'flat'),
      ('unit_residential_detail', 'villa'),
      ('unit_residential_detail', 'staff_housing'),
      ('unit_residential_detail', 'labour_camp'),
      ('unit_commercial_detail', 'office'),
      ('unit_commercial_detail', 'shop'),
      ('unit_commercial_detail', 'showroom'),
      ('unit_commercial_detail', 'workshop'),
      ('unit_industrial_detail', 'warehouse'),
      ('unit_industrial_detail', 'cold_store'),
      ('unit_land_detail', 'land'),
      ('unit_land_detail', 'signage'),
      ('unit_land_detail', 'parking'),
      ('unit_farm_detail', 'farm'),
      ('unit_rooftop_detail', 'rooftop')
    ) AS t(tbl, kind)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', pair.tbl || '_kind_guard', pair.tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION unit_detail_kind_guard(%L)',
      pair.tbl || '_kind_guard', pair.tbl, pair.kind
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------- lease kinds
DO $$ BEGIN
  CREATE TYPE lease_kind AS ENUM (
    'residential', 'commercial', 'industrial', 'agricultural',
    'short_term', 'parking', 'bare_land'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE billing_cycle AS ENUM ('monthly', 'quarterly', 'semi_annual', 'annual', 'upfront_single');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS lease_kind lease_kind NOT NULL DEFAULT 'residential',
  ADD COLUMN IF NOT EXISTS billing_cycle billing_cycle NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS notice_period_days integer;

ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_notice_period_ck;
ALTER TABLE leases
  ADD CONSTRAINT leases_notice_period_ck
  CHECK (notice_period_days IS NULL OR (notice_period_days >= 0 AND notice_period_days <= 365));

-- Agricultural land is not billed monthly; a daily-rental unit is not billed by
-- the year. The pairing is a rule, so it is a constraint and not advice.
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_cycle_ck;
ALTER TABLE leases
  ADD CONSTRAINT leases_cycle_ck
  CHECK (
    CASE lease_kind
      WHEN 'agricultural' THEN billing_cycle IN ('quarterly', 'semi_annual', 'annual', 'upfront_single')
      WHEN 'bare_land' THEN billing_cycle IN ('semi_annual', 'annual', 'upfront_single')
      WHEN 'short_term' THEN billing_cycle IN ('upfront_single', 'monthly')
      ELSE TRUE
    END
  );

-- ------------------------------------------------------------ charge taxonomy
-- Existing values stay; new ones cover the money that actually exists in a
-- Jordanian building: service charges, insurance recovery, fit-out deposits,
-- bounced-cheque fees and VAT.
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'service_charge';
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'insurance';
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'utility';
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'parking';
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'fit_out_deposit';
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'cheque_bounce_fee';
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'vat';
ALTER TYPE charge_kind ADD VALUE IF NOT EXISTS 'penalty';
