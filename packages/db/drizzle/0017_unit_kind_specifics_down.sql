-- 0017_unit_kind_specifics (down)
--
-- Reverses everything in the up migration. Two reversals can fail by design, and
-- refusing is the honest outcome:
--
--   * `units_building_number_uq` is (building_id, unit_number); if the database now
--     holds two bays numbered "12" on different levels, restoring the flat index
--     would silently claim an identity the data does not have. The index creation
--     fails and the transaction rolls back.
--   * 0008's `units_building_ck` forbade a building on a rooftop. If rooftop rows
--     created under 0017 carry a building, restoring it fails for the same reason.
--
-- Reverse the data first, then re-run this. Do not "fix" the down file to make it
-- pass.

DROP TABLE IF EXISTS unit_parking_detail;
DROP TABLE IF EXISTS unit_signage_detail;
DROP FUNCTION IF EXISTS public.unit_parking_allocation_guard();

-- Guard back to the 0009 arrays: parking and signage live in land detail again.
CREATE OR REPLACE FUNCTION public.unit_detail_kind_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual  text;
  allowed text[];
BEGIN
  allowed := CASE TG_TABLE_NAME
    WHEN 'unit_residential_detail' THEN ARRAY['flat', 'villa', 'staff_housing', 'labour_camp']
    WHEN 'unit_commercial_detail'  THEN ARRAY['office', 'shop', 'showroom', 'workshop']
    WHEN 'unit_industrial_detail'  THEN ARRAY['warehouse', 'cold_store']
    WHEN 'unit_land_detail'        THEN ARRAY['land', 'signage', 'parking']
    WHEN 'unit_farm_detail'        THEN ARRAY['farm']
    WHEN 'unit_rooftop_detail'     THEN ARRAY['rooftop']
  END;

  IF allowed IS NULL THEN
    RAISE EXCEPTION 'no detail family registered for table %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT space_kind::text INTO actual FROM units WHERE id = NEW.unit_id;
  IF actual IS NULL THEN
    RAISE EXCEPTION 'unit % does not exist', NEW.unit_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT (actual = ANY (allowed)) THEN
    RAISE EXCEPTION 'unit % is a %, so it cannot have % detail', NEW.unit_id, actual, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'unit_residential_detail', 'unit_commercial_detail', 'unit_industrial_detail',
    'unit_land_detail', 'unit_farm_detail', 'unit_rooftop_detail'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_kind_guard', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION public.unit_detail_kind_guard()',
      t || '_kind_guard', t
    );
  END LOOP;
END $$;

-- Row-level security returns to how 0008 left it: units enforced, details not.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'unit_residential_detail', 'unit_commercial_detail', 'unit_industrial_detail',
    'unit_land_detail', 'unit_farm_detail', 'unit_rooftop_detail'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

ALTER TABLE unit_commercial_detail DROP CONSTRAINT IF EXISTS unit_commercial_power_ck;
ALTER TABLE unit_commercial_detail
  DROP COLUMN IF EXISTS licensed_use,
  DROP COLUMN IF EXISTS power_capacity_kva,
  DROP COLUMN IF EXISTS has_fire_system;

ALTER TABLE unit_industrial_detail DROP CONSTRAINT IF EXISTS unit_industrial_power_ck;
ALTER TABLE unit_industrial_detail
  DROP COLUMN IF EXISTS licensed_use,
  DROP COLUMN IF EXISTS power_capacity_kva,
  DROP COLUMN IF EXISTS has_fire_system;

ALTER TABLE unit_land_detail DROP CONSTRAINT IF EXISTS unit_land_setbacks_ck;
ALTER TABLE unit_land_detail
  DROP COLUMN IF EXISTS basin,
  DROP COLUMN IF EXISTS zoning_permit_ref,
  DROP COLUMN IF EXISTS setback_front_m,
  DROP COLUMN IF EXISTS setback_side_m,
  DROP COLUMN IF EXISTS setback_rear_m,
  DROP COLUMN IF EXISTS road_width_m,
  DROP COLUMN IF EXISTS has_lien;

DROP INDEX IF EXISTS units_building_floor_number_uq;
DROP INDEX IF EXISTS units_property_number_uq;
CREATE UNIQUE INDEX IF NOT EXISTS units_building_number_uq
  ON units (building_id, unit_number);

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_building_ck;
ALTER TABLE units
  ADD CONSTRAINT units_building_ck
  CHECK (
    CASE space_kind
      WHEN 'land'::space_kind    THEN building_id IS NULL
      WHEN 'farm'::space_kind    THEN building_id IS NULL
      WHEN 'rooftop'::space_kind THEN building_id IS NULL
      WHEN 'signage'::space_kind THEN building_id IS NULL
      WHEN 'parking'::space_kind THEN true
      ELSE building_id IS NOT NULL
    END
  );

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_net_le_gross_ck;
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_net_area_ck;
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_common_share_needs_building_ck;
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_common_share_ck;

-- 0008 left these defaulted as well as nullable; restore that shape exactly.
ALTER TABLE units
  ALTER COLUMN bedrooms SET DEFAULT 1,
  ALTER COLUMN bathrooms SET DEFAULT 1;

ALTER TABLE units
  DROP COLUMN IF EXISTS common_share_permille,
  DROP COLUMN IF EXISTS occupancy_permit_ref,
  DROP COLUMN IF EXISTS net_area_sqm;

