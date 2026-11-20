DROP TABLE IF EXISTS plan_extractions;
DROP TABLE IF EXISTS plan_rooms;
DROP TABLE IF EXISTS floor_plans;
ALTER TABLE units
  DROP COLUMN IF EXISTS area_confirmed_at,
  DROP COLUMN IF EXISTS area_confirmed_by,
  DROP COLUMN IF EXISTS area_source;
DROP TYPE IF EXISTS area_source;
