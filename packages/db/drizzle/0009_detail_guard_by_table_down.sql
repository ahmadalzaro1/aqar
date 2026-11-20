-- Reverses 0009 into the 0008 shape (argument-passed kind, one trigger each).
-- The forward migration's bug is exactly what this restores, so this down is only
-- for a rollback that also rolls back 0008.
DROP TRIGGER IF EXISTS unit_residential_detail_kind_guard ON unit_residential_detail;
DROP TRIGGER IF EXISTS unit_commercial_detail_kind_guard ON unit_commercial_detail;
DROP TRIGGER IF EXISTS unit_industrial_detail_kind_guard ON unit_industrial_detail;
DROP TRIGGER IF EXISTS unit_land_detail_kind_guard ON unit_land_detail;
DROP TRIGGER IF EXISTS unit_farm_detail_kind_guard ON unit_farm_detail;
DROP TRIGGER IF EXISTS unit_rooftop_detail_kind_guard ON unit_rooftop_detail;

CREATE OR REPLACE FUNCTION unit_detail_kind_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected text := tg_argv[0];
  actual   text;
BEGIN
  SELECT space_kind::text INTO actual FROM units WHERE id = NEW.unit_id;
  IF actual IS NULL THEN
    RAISE EXCEPTION 'unit % does not exist', NEW.unit_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF actual <> expected THEN
    RAISE EXCEPTION 'unit % is a %, so it cannot have % detail', NEW.unit_id, actual, expected
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
