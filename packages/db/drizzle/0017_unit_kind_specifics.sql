-- 0017_unit_kind_specifics
--
-- Four kinds were still described by fields that belong to other kinds, and two
-- kinds had no detail table at all:
--
--   * `parking` and `signage` were smuggled into `unit_land_detail` (guard array
--     in 0009). A parking bay stored `plot_number` and `max_far`; it has neither.
--     Its real distinguishing numbers — bay width, bay length, clearance height,
--     level, and whether the bay is allocated or separately deeded — had nowhere
--     to live, so nobody could answer "does my car fit" from the database.
--
--   * `units_building_ck` (0008) forced `rooftop` and `signage` to have NO
--     building. A rooftop is the roof OF a building: forcing the link away makes
--     two roofs on one property indistinguishable, and there is no honest value
--     for a roof that belongs to nothing. `signage` and `parking` are genuinely
--     either (a facade/underground bay hangs off a building, a billboard/surface
--     bay sits on a parcel), so they become optional rather than forbidden.
--
--   * `units_building_number_uq` was (building_id, unit_number), so "12" on B1
--     and "12" on B2 collided. Parking levels make that collision routine.
--
--   * The apartment legal block (common share in the building, occupancy permit,
--     net area) and the capacity block for commercial/industrial space (power,
--     fire system, licensed use) did not exist anywhere.
--
-- Also fixed here, and it belongs with the tables it affects: every detail table
-- created in 0008 was left without row-level security, while `units` was
-- enforced. Detail rows carry plot numbers, frontage, occupancy permits and
-- power capacity — commercially sensitive, and readable across organizations.
--
-- 0008 is not edited. It has been applied to live databases; a migration that
-- changes after being applied is a lie about what those databases contain.

-- ---------------------------------------------------------------- units: legal
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS common_share_permille integer,
  ADD COLUMN IF NOT EXISTS occupancy_permit_ref text,
  ADD COLUMN IF NOT EXISTS net_area_sqm numeric;

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_common_share_ck;
ALTER TABLE units
  ADD CONSTRAINT units_common_share_ck
  CHECK (common_share_permille IS NULL
         OR (common_share_permille >= 0 AND common_share_permille <= 1000));

-- A share of the building's common areas is only meaningful inside a building.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_common_share_needs_building_ck;
ALTER TABLE units
  ADD CONSTRAINT units_common_share_needs_building_ck
  CHECK (common_share_permille IS NULL OR building_id IS NOT NULL);

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_net_area_ck;
ALTER TABLE units
  ADD CONSTRAINT units_net_area_ck
  CHECK (net_area_sqm IS NULL OR net_area_sqm > 0);

-- `area_sqm` is the gross/registered figure; net lettable area cannot exceed it.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_net_le_gross_ck;
ALTER TABLE units
  ADD CONSTRAINT units_net_le_gross_ck
  CHECK (net_area_sqm IS NULL OR area_sqm IS NULL OR net_area_sqm <= area_sqm);

-- ------------------------------------------------- units: building requirement
-- Corrects 0008: rooftop REQUIRES a building; parking and signage may have one.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_building_ck;
ALTER TABLE units
  ADD CONSTRAINT units_building_ck
  CHECK (
    CASE space_kind
      WHEN 'land'::space_kind    THEN building_id IS NULL
      WHEN 'farm'::space_kind    THEN building_id IS NULL
      WHEN 'parking'::space_kind THEN true
      WHEN 'signage'::space_kind THEN true
      ELSE building_id IS NOT NULL
    END
  );

-- ------------------------------------------------------ units: count defaults
-- 0008 made bedrooms/bathrooms nullable and added the two count checks — but left
-- `DEFAULT 1` on both. An insert that omits them for a parking bay therefore got
-- 1, and the "non-residential has no bedroom count" check was never exercised.
-- A nullable column with a default is not nullable in practice: it is a value
-- nobody chose. Drop the default so the check means what it says.
UPDATE units
   SET bedrooms = NULL, bathrooms = NULL
 WHERE space_kind NOT IN ('flat'::space_kind, 'villa'::space_kind,
                          'staff_housing'::space_kind, 'labour_camp'::space_kind);

ALTER TABLE units
  ALTER COLUMN bedrooms DROP DEFAULT,
  ALTER COLUMN bathrooms DROP DEFAULT;

-- ------------------------------------------------------- units: number identity
-- A parking bay is "12" on B1 and "12" on B2. The identity is (building, level,
-- number). Buildingless units (parcels, surface bays) have no level to sort by,
-- so identity there is (property, number) — one anchor or the other, never
-- neither: two NULL-building rows with the same number in one property collide.
DROP INDEX IF EXISTS units_building_number_uq;
CREATE UNIQUE INDEX IF NOT EXISTS units_building_floor_number_uq
  ON units (building_id, coalesce(floor, ''), unit_number)
  WHERE building_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS units_property_number_uq
  ON units (property_id, unit_number)
  WHERE building_id IS NULL;

-- ------------------------------------------------------------- land: legal block
-- `basin` is the DLS حوض: a plot number is only unique inside its basin, so the
-- pair is the parcel's identity. Setbacks and road width decide what can be built.
ALTER TABLE unit_land_detail
  ADD COLUMN IF NOT EXISTS basin text,
  ADD COLUMN IF NOT EXISTS zoning_permit_ref text,
  ADD COLUMN IF NOT EXISTS setback_front_m numeric,
  ADD COLUMN IF NOT EXISTS setback_side_m numeric,
  ADD COLUMN IF NOT EXISTS setback_rear_m numeric,
  ADD COLUMN IF NOT EXISTS road_width_m numeric,
  ADD COLUMN IF NOT EXISTS has_lien boolean NOT NULL DEFAULT false;

ALTER TABLE unit_land_detail DROP CONSTRAINT IF EXISTS unit_land_setbacks_ck;
ALTER TABLE unit_land_detail
  ADD CONSTRAINT unit_land_setbacks_ck
  CHECK (
    (setback_front_m IS NULL OR setback_front_m >= 0)
    AND (setback_side_m IS NULL OR setback_side_m >= 0)
    AND (setback_rear_m IS NULL OR setback_rear_m >= 0)
    AND (road_width_m IS NULL OR road_width_m > 0)
  );

-- ------------------------------------- commercial/industrial: capacity block
-- `permitted_use` is what the space was built and approved for. `licensed_use` is
-- what the current tenant is licensed to trade. A shop approved for retail and
-- licensed as a restaurant is a real, common and consequential difference.
ALTER TABLE unit_commercial_detail
  ADD COLUMN IF NOT EXISTS licensed_use text,
  ADD COLUMN IF NOT EXISTS power_capacity_kva numeric,
  ADD COLUMN IF NOT EXISTS has_fire_system boolean NOT NULL DEFAULT false;

ALTER TABLE unit_industrial_detail
  ADD COLUMN IF NOT EXISTS licensed_use text,
  ADD COLUMN IF NOT EXISTS power_capacity_kva numeric,
  ADD COLUMN IF NOT EXISTS has_fire_system boolean NOT NULL DEFAULT false;

ALTER TABLE unit_commercial_detail DROP CONSTRAINT IF EXISTS unit_commercial_power_ck;
ALTER TABLE unit_commercial_detail
  ADD CONSTRAINT unit_commercial_power_ck
  CHECK (power_capacity_kva IS NULL OR power_capacity_kva > 0);

ALTER TABLE unit_industrial_detail DROP CONSTRAINT IF EXISTS unit_industrial_power_ck;
ALTER TABLE unit_industrial_detail
  ADD CONSTRAINT unit_industrial_power_ck
  CHECK (power_capacity_kva IS NULL OR power_capacity_kva > 0);

-- ------------------------------------------------------------ parking detail
CREATE TABLE IF NOT EXISTS unit_parking_detail (
  unit_id uuid PRIMARY KEY REFERENCES units (id) ON DELETE CASCADE,
  -- Level is part of the bay's identity ("B1"), kept here as the physical fact;
  -- `units.floor` carries the same label for identity purposes.
  level text,
  bay_width_m numeric,
  bay_length_m numeric,
  -- Door height, not ceiling height: a bay that fits a saloon and not an SUV is
  -- a different product, and this is the number that decides it.
  clearance_m numeric,
  is_covered boolean NOT NULL DEFAULT false,
  -- Allocated bays are granted by the building; deeded bays are owned outright.
  -- Both are real and neither implies the other, but they cannot both be true.
  is_allocated boolean NOT NULL DEFAULT true,
  has_own_deed boolean NOT NULL DEFAULT false,
  has_ev_charger boolean NOT NULL DEFAULT false,
  -- The flat this bay serves. This link, not the bay, is what a tenant disputes.
  allocated_to_unit_id uuid REFERENCES units (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_parking_dims_ck CHECK (
    (bay_width_m IS NULL OR bay_width_m > 0)
    AND (bay_length_m IS NULL OR bay_length_m > 0)
    AND (clearance_m IS NULL OR clearance_m > 0)
  ),
  CONSTRAINT unit_parking_allocation_ck CHECK (
    allocated_to_unit_id IS NULL OR is_allocated
  ),
  CONSTRAINT unit_parking_deed_ck CHECK (NOT (is_allocated AND has_own_deed))
);

CREATE INDEX IF NOT EXISTS unit_parking_allocated_to_idx
  ON unit_parking_detail (allocated_to_unit_id);

-- A bay allocated to a flat on another property (or in another building) is a
-- data-entry error that becomes a billing dispute. Runs as a trigger because a
-- row CHECK cannot look at the row it references.
CREATE OR REPLACE FUNCTION public.unit_parking_allocation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_kind space_kind;
  target_property uuid;
  target_building uuid;
  bay_property uuid;
  bay_building uuid;
BEGIN
  IF NEW.allocated_to_unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT space_kind, property_id, building_id
    INTO target_kind, target_property, target_building
    FROM units WHERE id = NEW.allocated_to_unit_id;

  IF target_kind IS NULL THEN
    -- Gone because the allocation is being cleared by a cascade (an FK SET NULL
    -- re-enters this trigger after the referenced unit row is already deleted).
    IF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'allocated unit % does not exist', NEW.allocated_to_unit_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF target_kind = 'parking'::space_kind THEN
    RAISE EXCEPTION 'a parking bay cannot be allocated to another parking bay (%)', NEW.allocated_to_unit_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT property_id, building_id INTO bay_property, bay_building
    FROM units WHERE id = NEW.unit_id;

  IF bay_property IS DISTINCT FROM target_property THEN
    RAISE EXCEPTION 'bay % and unit % are on different properties', NEW.unit_id, NEW.allocated_to_unit_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF bay_building IS NOT NULL AND bay_building IS DISTINCT FROM target_building THEN
    RAISE EXCEPTION 'bay % and unit % are in different buildings', NEW.unit_id, NEW.allocated_to_unit_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_unit_parking_allocation ON unit_parking_detail;
CREATE TRIGGER trg_unit_parking_allocation
  BEFORE INSERT OR UPDATE OF allocated_to_unit_id ON unit_parking_detail
  FOR EACH ROW EXECUTE FUNCTION public.unit_parking_allocation_guard();

-- ------------------------------------------------------------ signage detail
CREATE TABLE IF NOT EXISTS unit_signage_detail (
  unit_id uuid PRIMARY KEY REFERENCES units (id) ON DELETE CASCADE,
  -- A billboard is sold on face area, never on plot area.
  face_area_sqm numeric,
  orientation text,
  permit_ref text,
  is_illuminated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_signage_face_ck CHECK (face_area_sqm IS NULL OR face_area_sqm > 0),
  CONSTRAINT unit_signage_orientation_ck CHECK (
    orientation IS NULL OR orientation IN (
      'north', 'south', 'east', 'west',
      'north_east', 'north_west', 'south_east', 'south_west',
      'multi'
    )
  )
);

-- ---------------------------------------------- the pairing guard, per family
-- 0009 keyed the guard on TG_TABLE_NAME, which is right. What changes here is the
-- set of kinds each family accepts: `unit_land_detail` loses `parking` and
-- `signage` (it was only ever their home because they had none), and the two new
-- tables join the list. Same function body, corrected arrays.
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
    WHEN 'unit_land_detail'        THEN ARRAY['land']
    WHEN 'unit_farm_detail'        THEN ARRAY['farm']
    WHEN 'unit_rooftop_detail'     THEN ARRAY['rooftop']
    WHEN 'unit_parking_detail'     THEN ARRAY['parking']
    WHEN 'unit_signage_detail'     THEN ARRAY['signage']
  END;

  IF allowed IS NULL THEN
    RAISE EXCEPTION 'no detail family registered for table %', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT space_kind::text INTO actual FROM units WHERE id = NEW.unit_id;
  IF actual IS NULL THEN
    -- The owning unit is gone. That is legitimate only mid-cascade: deleting a unit
    -- fires this UPDATE (an FK nulling a reference on the same table) after the unit
    -- row is already deleted. A row whose owner no longer exists cannot misdescribe
    -- it, so let the cascade finish. An INSERT cannot reach here with a missing
    -- parent: the unit_id foreign key refuses it first.
    IF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
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
    'unit_land_detail', 'unit_farm_detail', 'unit_rooftop_detail',
    'unit_parking_detail', 'unit_signage_detail'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_kind_guard ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_kind_guard BEFORE INSERT OR UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION public.unit_detail_kind_guard()',
      t, t
    );
  END LOOP;
END $$;

-- ------------------------------------- row-level security on the detail tables
-- These tables have no organization_id of their own; ownership comes from their
-- unit. The policy therefore asks the parent, and fails closed: with no
-- organization GUC, `app.current_org_id()` is NULL and nothing is visible.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'unit_residential_detail', 'unit_commercial_detail', 'unit_industrial_detail',
    'unit_land_detail', 'unit_farm_detail', 'unit_rooftop_detail',
    'unit_parking_detail', 'unit_signage_detail'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      'USING (EXISTS (SELECT 1 FROM units u WHERE u.id = unit_id '
      '              AND u.organization_id = app.current_org_id())) '
      'WITH CHECK (EXISTS (SELECT 1 FROM units u WHERE u.id = unit_id '
      '              AND u.organization_id = app.current_org_id()))',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aqar_app', t);
  END LOOP;
END $$;
