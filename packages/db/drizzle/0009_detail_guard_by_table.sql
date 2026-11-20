-- 0009_detail_guard_by_table
--
-- 0008 created one guard trigger per (table, kind) pair, each passing its expected
-- kind as a trigger argument — but a trigger name is unique per table, so every
-- later CREATE OR REPLACE in that loop silently replaced the earlier one. The
-- survivor was the LAST kind in the list: `unit_land_detail` only accepted
-- `parking`, and `unit_commercial_detail` only accepted `workshop`. Real flats
-- could not store their own frontage; real plots could not store their plot.
--
-- Fixed by keying the guard on the TABLE instead of an argument. The table knows
-- which family it is, and the family is the set of kinds that legitimately share
-- those attributes. This also removes the possibility of two triggers fighting
-- over one row.
--
-- Corrected forward rather than by editing 0008: 0008 has been applied to a live
-- database, and a migration file that changes after being applied is a lie about
-- what that database contains.

CREATE OR REPLACE FUNCTION unit_detail_kind_guard() RETURNS trigger
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

-- One trigger per table, no arguments. Idempotent: drop then create.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'unit_residential_detail', 'unit_commercial_detail', 'unit_industrial_detail',
    'unit_land_detail', 'unit_farm_detail', 'unit_rooftop_detail'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_kind_guard', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION unit_detail_kind_guard()',
      t || '_kind_guard', t
    );
  END LOOP;
END $$;
