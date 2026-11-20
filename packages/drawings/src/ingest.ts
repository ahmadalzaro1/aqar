/**
 * Ingest a drawing into the database: parse, reconcile, store as evidence.
 *
 *   pnpm plan:ingest --file tools/plan-extractor/fixtures/flats.dxf \
 *     --property <slug-or-id> --level ground --stated 147
 *
 * This writes `floor_plans` and `plan_rooms` and nothing else. It never writes
 * `units.area_sqm`: an area becomes billable only when a human confirms a room and
 * an approved proposal carries it into the unit. That separation is deliberate —
 * a parser is allowed to be wrong about a floor plan, but never about rent.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createSql } from '@aqar/db';
import { clearSupersededRooms, guardSupersede } from './plan-write.js';
import { reconcileAreas } from '@aqar/core';
import { reconcilableShapes, runPlanExtractor } from './extractor.js';

const ROOM_KINDS = new Set([
  'unit', 'bedroom', 'bath', 'kitchen', 'living', 'corridor', 'shaft',
  'balcony', 'terrace', 'parking', 'common', 'storage', 'other',
]);
const DRAWING_UNITS = new Set(['mm', 'cm', 'm', 'ft']);

export interface IngestOptions {
  readonly filePath: string;
  readonly property: string;
  readonly level: string;
  readonly statedSqm: number | null;
  readonly unit?: 'mm' | 'cm' | 'm' | 'ft' | 'in';
  readonly calibrate?: string;
  readonly databaseUrl?: string;
}

export interface IngestResult {
  readonly floorPlanId: string;
  readonly propertyId: string;
  readonly format: string;
  readonly drawingUnit: string;
  readonly shapes: number;
  readonly rooms: number;
  readonly sumSqm: number;
  readonly reconciliation: ReturnType<typeof reconcileAreas>;
  readonly warnings: readonly string[];
  readonly scaleKnown: boolean;
}

export async function ingestPlan(options: IngestOptions): Promise<IngestResult> {
  const databaseUrl = options.databaseUrl ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set');
  }

  const bytes = await readFile(options.filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const size = (await stat(options.filePath)).size;
  const extension = basename(options.filePath).toLowerCase().split('.').pop() ?? '';
  const format = extension === 'dxf' ? 'dxf' : extension === 'dwg' ? 'dwg' : 'pdf';

  const extraction = await runPlanExtractor({
    format,
    filePath: options.filePath,
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    ...(options.calibrate === undefined ? {} : { calibrate: options.calibrate }),
  });

  const rooms = extraction.shapes.filter((shape) => shape.area_sqm !== null);
  // A corridor is not lettable area, and a bedroom hatch is already inside its flat.
  // Reconciling the stated area against everything the parser found would count the
  // same square metre twice and blame the drawing for it.
  const lettable = new Set(rooms.filter((room) => room.room_kind === 'unit').map((room) => room.code));
  const reconciliation = reconcileAreas(
    reconcilableShapes(extraction).filter((shape) => lettable.has(shape.code)),
    options.statedSqm,
  );
  const drawingUnit = DRAWING_UNITS.has(extraction.unit) ? extraction.unit : 'mm';

  const sql = createSql(databaseUrl);
  try {
    const properties = await sql<{ id: string; organization_id: string }[]>`
      select id, organization_id from properties
       where id::text = ${options.property} or name ilike ${options.property}
       order by created_at limit 1`;
    const property = properties[0];
    if (property === undefined) throw new Error(`no property matches '${options.property}'`);

    const floorPlanId = await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${property.organization_id}, true)`;
      const inserted = await tx<{ id: string }[]>`
        insert into floor_plans (organization_id, property_id, level, format, drawing_unit,
                                 sha256, byte_size, status, stated_area_sqm, parsed_by,
                                 parser_version, parsed_at)
        values (${property.organization_id}::uuid, ${property.id}::uuid, ${options.level},
                ${extraction.format}, ${drawingUnit}, ${sha256}, ${size},
                ${extraction.scale_known ? 'parsed' : 'uploaded'}, ${options.statedSqm},
                ${extraction.engine}, ${extraction.engine_version}, now())
        on conflict (property_id, level) where status <> 'rejected'
        do update set parsed_at = now(), stated_area_sqm = excluded.stated_area_sqm
        returning id`;
      const plan = inserted[0];
      if (plan === undefined) throw new Error('floor_plans insert returned no row');

      // A second, different drawing for the same level replaces the first — unless
      // somebody already confirmed a room or a unit was materialised from it.
      const { replaced } = await guardSupersede(tx, plan.id, sha256);
      if (replaced) await clearSupersededRooms(tx, plan.id);

      await tx`
        insert into plan_extractions (organization_id, floor_plan_id, engine, engine_version, params, stats, warnings)
        values (${property.organization_id}::uuid, ${plan.id}::uuid, ${extraction.engine},
                ${extraction.engine_version},
                ${JSON.stringify({ unit: extraction.unit, calibrate: options.calibrate ?? null })}::jsonb,
                ${JSON.stringify(extraction.stats)}::jsonb,
                ${JSON.stringify(extraction.warnings)}::jsonb)`;

      for (const room of rooms) {
        const kind = ROOM_KINDS.has(room.room_kind) ? room.room_kind : 'other';
        await tx`
          insert into plan_rooms (organization_id, floor_plan_id, code, label, room_kind,
                                  area_sqm, polygon, source)
          values (${property.organization_id}::uuid, ${plan.id}::uuid, ${room.code},
                  ${room.label}, ${kind}, ${room.area_sqm},
                  ${JSON.stringify(room.ring)}::jsonb, 'vector_geometry')
          on conflict (floor_plan_id, code) do update
            set area_sqm = excluded.area_sqm, polygon = excluded.polygon,
                label = excluded.label, room_kind = excluded.room_kind, updated_at = now()`;
      }
      return plan.id;
    });

    return {
      floorPlanId,
      propertyId: property.id,
      format: extraction.format,
      drawingUnit,
      shapes: extraction.shapes.length,
      rooms: rooms.length,
      sumSqm: reconciliation.sumSqm,
      reconciliation,
      warnings: extraction.warnings.map((warning) => String(warning['reason'] ?? 'unknown')),
      scaleKnown: extraction.scale_known,
    };
  } finally {
    await sql.end();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

if (process.argv[1]?.endsWith('ingest.ts') === true || process.argv[1]?.endsWith('ingest.js') === true) {
  const filePath = argument('file');
  const property = argument('property');
  const level = argument('level');
  if (filePath === undefined || property === undefined || level === undefined) {
    console.error('usage: plan:ingest --file <drawing> --property <slug|uuid> --level <name> [--stated <m2>] [--unit mm] [--calibrate x1,y1,x2,y2,m]');
    process.exit(2);
  }
  const stated = argument('stated');
  const unit = argument('unit');
  ingestPlan({
    filePath,
    property,
    level,
    statedSqm: stated === undefined ? null : Number(stated),
    ...(unit === undefined ? {} : { unit: unit as 'mm' | 'cm' | 'm' | 'ft' }),
    ...(argument('calibrate') === undefined ? {} : { calibrate: argument('calibrate') as string }),
  })
    .then((result) => {
      console.info(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exit(1);
    });
}
