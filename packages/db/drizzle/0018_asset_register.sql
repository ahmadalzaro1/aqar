-- 0018_asset_register.sql
-- The building's digital twin: what is installed, where, since when, under which
-- warranty, serviced by whom — and deliberately NOT who lives there.
--
-- Privacy stance (enforced structurally, see the block at the bottom):
--   1. No person columns. asset_events carries ticket_id, never tenant_id, so a
--      tenant's personal data can be erased without erasing the building's history.
--   2. sensitivity defaults to 'internal' (fail closed): a tenant-facing surface must
--      opt an asset in, never out.
--   3. cctv assets record equipment health only. Never frames, never biometrics.
--   4. Owners read aggregates (asset_cost_rollup), not raw events.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Vocabulary
-- ---------------------------------------------------------------------------
CREATE TYPE equipment_kind AS ENUM (
  'structure', 'roof', 'envelope', 'water_supply', 'water_tank', 'pump',
  'drainage', 'sewer', 'gas_network', 'gas_cylinder', 'electrical_panel', 'wiring',
  'generator', 'solar', 'hvac_split', 'hvac_central', 'water_heater', 'elevator',
  'fire_alarm', 'fire_extinguisher', 'fire_riser', 'security_access', 'cctv',
  'intercom', 'door_lock', 'kitchen', 'appliance', 'plumbing_fixture', 'lighting',
  'parking_equipment', 'signage', 'other'
);

CREATE TYPE equipment_scope AS ENUM ('unit', 'building');
CREATE TYPE equipment_status AS ENUM ('in_service', 'faulty', 'retired', 'replaced');

-- internal: staff/agent only. tenant_visible: may be shown in the tenant's channel.
CREATE TYPE equipment_sensitivity AS ENUM ('internal', 'tenant_visible');

CREATE TYPE equipment_event_kind AS ENUM (
  'installed', 'serviced', 'inspected', 'failed', 'repaired',
  'replaced', 'warranty_claim', 'retired'
);

CREATE TYPE equipment_event_source AS ENUM ('manual', 'ticket', 'vendor', 'schedule', 'import');

-- ---------------------------------------------------------------------------
-- 2. The register
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id             uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,

  -- An asset is either private to one unit or shared by the building.
  scope                   equipment_scope NOT NULL,
  unit_id                 uuid REFERENCES units(id) ON DELETE CASCADE,
  building_id             uuid REFERENCES buildings(id) ON DELETE CASCADE,

  kind                    equipment_kind NOT NULL,
  label                   text NOT NULL,
  serial                  text,

  -- The three dates that turn "who pays?" into a checkable question.
  installed_on            date,
  expected_life_years     integer,
  warranty_expires_on     date,

  -- The calendar that turns a ticket queue into preventive maintenance.
  service_interval_days   integer,
  last_serviced_on        date,
  next_due_on             date GENERATED ALWAYS AS (last_serviced_on + service_interval_days) STORED,

  -- Reuses the four-bucket responsibility enum: landlord | tenant | shared | warranty.
  responsible_party       responsibility NOT NULL DEFAULT 'landlord',

  vendor_id               uuid REFERENCES vendors(id) ON DELETE SET NULL,
  cost_centre             text,
  status                  equipment_status NOT NULL DEFAULT 'in_service',
  sensitivity             equipment_sensitivity NOT NULL DEFAULT 'internal',
  replaced_by_asset_id    uuid REFERENCES assets(id) ON DELETE SET NULL,
  notes_md                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assets_label_not_blank_ck CHECK (length(btrim(label)) > 0),
  CONSTRAINT assets_scope_target_ck CHECK (
    (scope = 'unit'     AND unit_id IS NOT NULL AND building_id IS NULL) OR
    (scope = 'building' AND building_id IS NOT NULL AND unit_id IS NULL)
  ),
  CONSTRAINT assets_expected_life_ck CHECK (expected_life_years IS NULL OR expected_life_years BETWEEN 1 AND 100),
  CONSTRAINT assets_service_interval_ck CHECK (service_interval_days IS NULL OR service_interval_days BETWEEN 1 AND 3650),
  CONSTRAINT assets_life_dates_ck CHECK (
    installed_on IS NULL OR warranty_expires_on IS NULL OR warranty_expires_on >= installed_on
  ),
  CONSTRAINT assets_service_dates_ck CHECK (
    installed_on IS NULL OR last_serviced_on IS NULL OR last_serviced_on >= installed_on
  ),
  CONSTRAINT assets_no_self_replace_ck CHECK (replaced_by_asset_id IS DISTINCT FROM id),
  CONSTRAINT assets_replaced_consistency_ck CHECK (status <> 'replaced' OR replaced_by_asset_id IS NOT NULL)
);

CREATE UNIQUE INDEX assets_serial_uq ON assets (organization_id, serial) WHERE serial IS NOT NULL;
CREATE INDEX assets_property_idx  ON assets (organization_id, property_id);
CREATE INDEX assets_unit_idx      ON assets (unit_id)     WHERE unit_id IS NOT NULL;
CREATE INDEX assets_building_idx  ON assets (building_id) WHERE building_id IS NOT NULL;
CREATE INDEX assets_due_idx       ON assets (organization_id, next_due_on)
  WHERE status = 'in_service' AND next_due_on IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The time axis (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE asset_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: a register with history is retired, never deleted.
  asset_id              uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,

  event_kind            equipment_event_kind NOT NULL,
  occurred_on           date NOT NULL,
  source                equipment_event_source NOT NULL DEFAULT 'manual',

  -- Provenance: which ticket, which vendor, which document, what it cost.
  ticket_id             uuid REFERENCES tickets(id) ON DELETE SET NULL,
  vendor_id             uuid REFERENCES vendors(id) ON DELETE SET NULL,
  cost_fils             bigint CHECK (cost_fils >= 0),
  evidence_ref          text,

  note_md               text,
  -- Staff actor only. There is deliberately no tenant_id here: see the privacy note.
  recorded_by_user_id   uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asset_events_cost_ck CHECK (cost_fils IS NULL OR cost_fils >= 0)
);

CREATE INDEX asset_events_asset_idx  ON asset_events (asset_id, occurred_on DESC);
CREATE INDEX asset_events_org_idx    ON asset_events (organization_id, occurred_on DESC);
CREATE INDEX asset_events_ticket_idx ON asset_events (ticket_id) WHERE ticket_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------
-- An asset does not teleport between properties or units. Moving equipment is a
-- retirement plus a new registration, so the history stays attributable.
CREATE OR REPLACE FUNCTION app.assert_asset_location()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  actual_property uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.scope <> OLD.scope
       OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
       OR NEW.building_id IS DISTINCT FROM OLD.building_id
       OR NEW.property_id <> OLD.property_id THEN
      RAISE EXCEPTION 'asset % cannot change location; retire it and register the replacement', OLD.id
        USING HINT = 'Set status=replaced with replaced_by_asset_id, then INSERT the new asset row.';
    END IF;
  END IF;

  IF NEW.scope = 'unit' THEN
    IF NEW.unit_id IS NULL THEN
      RAISE EXCEPTION 'scope=unit requires unit_id (got NULL)'
        USING HINT = 'A unit asset must name its unit; building-wide equipment uses scope=building.';
    END IF;
    SELECT property_id INTO actual_property FROM units WHERE id = NEW.unit_id;
    IF actual_property IS NULL THEN
      RAISE EXCEPTION 'unit % does not exist', NEW.unit_id;
    END IF;
  ELSE
    IF NEW.building_id IS NULL THEN
      RAISE EXCEPTION 'scope=building requires building_id (got NULL)'
        USING HINT = 'Building-wide equipment must name its building.';
    END IF;
    SELECT property_id INTO actual_property FROM buildings WHERE id = NEW.building_id;
    IF actual_property IS NULL THEN
      RAISE EXCEPTION 'building % does not exist', NEW.building_id;
    END IF;
  END IF;

  IF actual_property <> NEW.property_id THEN
    RAISE EXCEPTION 'asset location belongs to property %, not %', actual_property, NEW.property_id
      USING HINT = 'property_id must be the property that owns the unit or building.';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_asset_location ON assets;
CREATE TRIGGER trg_asset_location
  BEFORE INSERT OR UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION app.assert_asset_location();

CREATE OR REPLACE FUNCTION app.assert_asset_event_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'asset_events is append-only: % is refused', TG_OP
    USING HINT = 'Insert a correcting event instead of rewriting building history.';
END
$fn$;

DROP TRIGGER IF EXISTS trg_asset_events_append_only ON asset_events;
CREATE TRIGGER trg_asset_events_append_only
  BEFORE UPDATE OR DELETE ON asset_events
  FOR EACH ROW EXECUTE FUNCTION app.assert_asset_event_append_only();

-- ---------------------------------------------------------------------------
-- 5. Row isolation + privileges (same posture as units / meters / tickets)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assets', 'asset_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      'USING (organization_id = app.current_org_id()) '
      'WITH CHECK (organization_id = app.current_org_id())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aqar_app', t);
  END LOOP;
END;
$$;

-- history is readable and appendable, never rewritable, for the application role
REVOKE UPDATE, DELETE, TRUNCATE ON asset_events FROM aqar_app;
GRANT SELECT, INSERT ON asset_events TO aqar_app;

-- ---------------------------------------------------------------------------
-- 6. Derived read models (no stored staleness; RLS applies to both)
-- ---------------------------------------------------------------------------
CREATE VIEW asset_health AS
SELECT
  a.id,
  a.organization_id,
  a.property_id,
  a.scope,
  a.building_id,
  a.unit_id,
  a.kind,
  a.label,
  a.status,
  a.sensitivity,
  a.responsible_party,
  a.installed_on,
  a.warranty_expires_on,
  a.next_due_on,
  CASE
    WHEN a.installed_on IS NULL THEN NULL
    ELSE date_part('year', age(current_date, a.installed_on))::integer
  END AS age_years,
  CASE
    WHEN a.warranty_expires_on IS NULL THEN 'unknown'
    WHEN a.warranty_expires_on >= current_date THEN 'in_warranty'
    ELSE 'expired'
  END AS warranty_state,
  CASE
    WHEN a.service_interval_days IS NULL OR a.next_due_on IS NULL THEN 'unscheduled'
    WHEN a.next_due_on < current_date THEN 'overdue'
    WHEN a.next_due_on <= current_date + 30 THEN 'due_soon'
    ELSE 'ok'
  END AS service_state,
  -- Cause becomes inferable from age rather than argued about.
  CASE
    WHEN a.expected_life_years IS NULL OR a.installed_on IS NULL THEN 'unknown'
    WHEN date_part('year', age(current_date, a.installed_on)) >= a.expected_life_years THEN 'end_of_life'
    WHEN date_part('year', age(current_date, a.installed_on)) >= a.expected_life_years * 0.8 THEN 'ageing'
    ELSE 'within_life'
  END AS life_state
FROM assets a;

-- Owner-facing: cost by property, kind and year. Aggregate only — no unit, no person.
CREATE VIEW asset_cost_rollup AS
SELECT
  e.organization_id,
  a.property_id,
  a.kind,
  date_part('year', e.occurred_on)::integer AS year,
  count(*)::integer AS events,
  coalesce(sum(e.cost_fils), 0)::bigint AS cost_fils
FROM asset_events e
JOIN assets a ON a.id = e.asset_id
GROUP BY e.organization_id, a.property_id, a.kind, date_part('year', e.occurred_on)::integer;

COMMIT;
