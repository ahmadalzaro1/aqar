-- Reverses 0008. Drops the taxonomy, not the data it described: a unit that was
-- a warehouse keeps its row and its rent, and simply loses the vocabulary that
-- said so. Enum values added to `charge_kind` cannot be removed without
-- rewriting every dependent column, so they are left in place — a down migration
-- must be safe to run on a live database, and rewriting an active money column is
-- not.
DROP TRIGGER IF EXISTS unit_residential_detail_kind_guard ON unit_residential_detail;
DROP TRIGGER IF EXISTS unit_commercial_detail_kind_guard ON unit_commercial_detail;
DROP TRIGGER IF EXISTS unit_industrial_detail_kind_guard ON unit_industrial_detail;
DROP TRIGGER IF EXISTS unit_land_detail_kind_guard ON unit_land_detail;
DROP TRIGGER IF EXISTS unit_farm_detail_kind_guard ON unit_farm_detail;
DROP TRIGGER IF EXISTS unit_rooftop_detail_kind_guard ON unit_rooftop_detail;

DROP TABLE IF EXISTS unit_rooftop_detail;
DROP TABLE IF EXISTS unit_farm_detail;
DROP TABLE IF EXISTS unit_land_detail;
DROP TABLE IF EXISTS unit_industrial_detail;
DROP TABLE IF EXISTS unit_commercial_detail;
DROP TABLE IF EXISTS unit_residential_detail;

DROP FUNCTION IF EXISTS unit_detail_kind_guard();

ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_cycle_ck;
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_notice_period_ck;
ALTER TABLE leases
  DROP COLUMN IF EXISTS notice_period_days,
  DROP COLUMN IF EXISTS billing_cycle,
  DROP COLUMN IF EXISTS lease_kind;
DROP TYPE IF EXISTS billing_cycle;
DROP TYPE IF EXISTS lease_kind;

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_building_ck;
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_nonresidential_counts_ck;
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_residential_counts_ck;

-- Restore the v1 shape only when every row can satisfy it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM units WHERE building_id IS NULL OR bedrooms IS NULL OR bathrooms IS NULL) THEN
    RAISE NOTICE 'units still hold non-building or non-residential spaces; leaving columns nullable';
  ELSE
    ALTER TABLE units ALTER COLUMN bedrooms SET NOT NULL;
    ALTER TABLE units ALTER COLUMN bathrooms SET NOT NULL;
    ALTER TABLE units ALTER COLUMN building_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE units DROP COLUMN IF EXISTS space_kind;
DROP TYPE IF EXISTS space_kind;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_parcel_ck;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_land_area_ck;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_zoning_ck;
ALTER TABLE properties
  DROP COLUMN IF EXISTS deed_date,
  DROP COLUMN IF EXISTS deed_number,
  DROP COLUMN IF EXISTS land_area_sqm,
  DROP COLUMN IF EXISTS zoning,
  DROP COLUMN IF EXISTS asset_kind;
DROP TYPE IF EXISTS asset_kind;
