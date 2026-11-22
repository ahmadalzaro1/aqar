-- 0018_asset_register_down.sql
-- Reverses 0018. NOTE: this discards the register *and its history* — a down
-- migration removes structure, and the data cannot be recovered afterwards.
-- The ON DELETE RESTRICT reference from asset_events protects a *single* asset
-- from being deleted while events exist; dropping asset_events first (below)
-- releases that on purpose, because reversing a migration must run on a
-- populated database.
BEGIN;

DROP VIEW IF EXISTS asset_cost_rollup;
DROP VIEW IF EXISTS asset_health;

DROP TABLE IF EXISTS asset_events;
DROP TABLE IF EXISTS assets;

DROP FUNCTION IF EXISTS app.assert_asset_event_append_only();
DROP FUNCTION IF EXISTS app.assert_asset_location();

DROP TYPE IF EXISTS equipment_event_source;
DROP TYPE IF EXISTS equipment_event_kind;
DROP TYPE IF EXISTS equipment_sensitivity;
DROP TYPE IF EXISTS equipment_status;
DROP TYPE IF EXISTS equipment_scope;
DROP TYPE IF EXISTS equipment_kind;

COMMIT;
