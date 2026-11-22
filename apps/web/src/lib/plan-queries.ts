import { sql } from './db';

/**
 * Reads for the drawing-review console. Kept apart from `queries.ts` so the plan
 * screens can change without touching the ledger's read models.
 */

export interface PlanRow {
  readonly id: string;
  readonly propertyName: string;
  readonly level: string;
  readonly format: string;
  readonly drawingUnit: string;
  readonly status: string;
  readonly statedAreaSqm: number | null;
  readonly rooms: number;
  readonly confirmed: number;
  readonly lettableSqm: number;
  readonly uploadedAt: string;
}

export interface RoomRow {
  readonly code: string;
  readonly label: string | null;
  readonly kind: string;
  readonly areaSqm: number;
  readonly source: string;
  readonly confidence: number | null;
  readonly confirmedAt: string | null;
}

export interface PlanDetail {
  readonly plan: PlanRow;
  readonly rooms: readonly RoomRow[];
  readonly warnings: readonly string[];
  /**
   * How the rooms were read: `rings` (drawn closed) or `walls` (the faces the wall
   * network encloses). A reviewer looking at 60 m² of flat should know whether
   * somebody drew that rectangle or whether the extractor closed it.
   */
  readonly strategy: string;
}

interface RawPlan {
  id: string;
  property_name: string;
  level: string;
  format: string;
  drawing_unit: string;
  status: string;
  stated_area_sqm: string | null;
  rooms: string | number;
  confirmed: string | number;
  lettable_sqm: string | null;
  created_at: string;
}

function toPlan(row: RawPlan): PlanRow {
  return {
    id: String(row.id),
    propertyName: String(row.property_name),
    level: String(row.level),
    format: String(row.format),
    drawingUnit: String(row.drawing_unit),
    status: String(row.status),
    statedAreaSqm: row.stated_area_sqm === null ? null : Number(row.stated_area_sqm),
    rooms: Number(row.rooms),
    confirmed: Number(row.confirmed),
    lettableSqm: row.lettable_sqm === null ? 0 : Number(row.lettable_sqm),
    uploadedAt: String(row.created_at).slice(0, 10),
  };
}

const PLAN_SELECT = sql`
  select f.id, p.name as property_name, f.level, f.format, f.drawing_unit, f.status,
         f.stated_area_sqm, f.created_at,
         (select count(*) from plan_rooms r where r.floor_plan_id = f.id) as rooms,
         (select count(*) from plan_rooms r where r.floor_plan_id = f.id and r.confirmed_at is not null) as confirmed,
         (select coalesce(sum(r.area_sqm), 0) from plan_rooms r
           where r.floor_plan_id = f.id and r.room_kind = 'unit') as lettable_sqm
    from floor_plans f
    join properties p on p.id = f.property_id
   where f.organization_id = `;

export async function floorPlansForOrg(orgId: string): Promise<PlanRow[]> {
  const rows = await sql<
    RawPlan[]
  >`${PLAN_SELECT}${orgId}::uuid order by f.created_at desc limit 50`;
  return rows.map(toPlan);
}

export async function planDetail(orgId: string, planId: string): Promise<PlanDetail | null> {
  const plans = await sql<
    RawPlan[]
  >`${PLAN_SELECT}${orgId}::uuid and f.id = ${planId}::uuid limit 1`;
  const plan = plans[0];
  if (plan === undefined) return null;

  const rooms = await sql<
    {
      code: string;
      label: string | null;
      room_kind: string;
      area_sqm: string;
      source: string;
      confidence: string | null;
      confirmed_at: string | null;
    }[]
  >`
    select code, label, room_kind, area_sqm, source, confidence, confirmed_at
      from plan_rooms where floor_plan_id = ${planId}::uuid
     order by case when room_kind = 'unit' then 0 else 1 end, area_sqm desc`;

  const warnings = await sql<{ warnings: unknown; params: unknown }[]>`
    select warnings, params from plan_extractions where floor_plan_id = ${planId}::uuid
     order by created_at desc limit 1`;

  // postgres.js hands jsonb back as a *string* on this connection, so an
  // `Array.isArray` check silently produced "no warnings" for every plan — the
  // reviewer's most important line, invisible. Parse defensively instead.
  const stored = warnings[0]?.warnings;
  const rawWarnings =
    typeof stored === 'string'
      ? (() => {
          try {
            return JSON.parse(stored) as unknown;
          } catch {
            return null;
          }
        })()
      : stored;
  const storedParams = warnings[0]?.params;
  const params =
    typeof storedParams === 'string'
      ? (() => {
          try {
            return JSON.parse(storedParams) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : ((storedParams as Record<string, unknown> | undefined) ?? {});
  const strategy = typeof params['strategy'] === 'string' ? params['strategy'] : 'rings';
  return {
    plan: toPlan(plan),
    strategy,
    rooms: rooms.map((room) => ({
      code: String(room.code),
      label: room.label === null ? null : String(room.label),
      kind: String(room.room_kind),
      areaSqm: Number(room.area_sqm),
      source: String(room.source),
      confidence: room.confidence === null ? null : Number(room.confidence),
      confirmedAt: room.confirmed_at === null ? null : String(room.confirmed_at).slice(0, 10),
    })),
    // Two shapes reach here: the vector parser emits {reason}, the raster importer
    // emits {code, flags}. A refused claim is the reviewer's most important line, so
    // both are flattened to one readable string instead of `[object Object]`.
    warnings: Array.isArray(rawWarnings)
      ? (rawWarnings as unknown[]).map((warning) => {
          const entry = warning as { reason?: unknown; code?: unknown; flags?: unknown };
          if (typeof entry.reason === 'string') return entry.reason;
          const flags = Array.isArray(entry.flags) ? entry.flags.map(String).join(', ') : 'refused';
          return typeof entry.code === 'string' ? `${entry.code}: ${flags}` : flags;
        })
      : [],
  };
}

export async function propertiesForOrg(orgId: string): Promise<{ id: string; name: string }[]> {
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name from properties where organization_id = ${orgId}::uuid order by name`;
  return rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}
