/**
 * Importing the output of a segmentation model.
 *
 * The model is somebody else's process: a CubiCasa5k fine-tune, an MMDetection
 * instance-segmentation run, or a person tracing a scan. This file is the contract
 * its output must satisfy, and the only thing it trusts is that contract.
 *
 * What it writes: `floor_plans` (format `image`), `plan_extractions` (the whole
 * document, so a reviewer can see what the model actually said), and `plan_rooms`
 * with `source='raster_model'` and a confidence the database insists on. What it
 * never writes: `units.area_sqm`, or a confirmation. A pixel-derived area is
 * testimony until a named person vouches for it.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { rasterImportSchema, type RasterImport } from '@aqar/contracts';
import { reconcileAreas, rasterRoomAreas, type RasterRoomArea } from '@aqar/core';
import { createSql } from '@aqar/db';
import { clearSupersededRooms, guardSupersede } from './plan-write.js';

const ROOM_KINDS = new Set([
  'unit',
  'bedroom',
  'bath',
  'kitchen',
  'living',
  'corridor',
  'shaft',
  'balcony',
  'terrace',
  'parking',
  'common',
  'storage',
  'other',
]);

export interface RasterImportOptions {
  readonly filePath: string;
  readonly property: string;
  readonly level: string;
  readonly statedSqm?: number | null;
  readonly databaseUrl?: string;
}

export interface RasterImportResult {
  readonly floorPlanId: string;
  readonly propertyId: string;
  readonly source: string;
  readonly modelId: string;
  readonly metresPerPixel: number;
  readonly claims: number;
  readonly accepted: number;
  readonly refused: readonly { readonly code: string; readonly flags: readonly string[] }[];
  readonly rooms: readonly RasterRoomArea[];
  readonly sumSqm: number;
  readonly reconciliation: ReturnType<typeof reconcileAreas>;
}

export function parseRasterDocument(raw: unknown): RasterImport {
  return rasterImportSchema.parse(raw);
}

export async function importRasterPlan(options: RasterImportOptions): Promise<RasterImportResult> {
  const databaseUrl = options.databaseUrl ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set');

  const bytes = await readFile(options.filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const size = (await stat(options.filePath)).size;
  const document = parseRasterDocument(JSON.parse(bytes.toString('utf8')));

  const measured = rasterRoomAreas(
    document.rooms.map((room) => ({
      code: room.code,
      room_kind: room.room_kind,
      confidence: room.confidence,
      polygon: room.polygon as unknown as readonly (readonly [number, number])[],
      label: room.label ?? null,
    })),
    document.metres_per_pixel,
    document.image,
  );

  const accepted = measured.filter((room) => room.accepted && room.room_kind === 'unit');
  const reconciliation = reconcileAreas(
    accepted.map((room) => ({ code: room.code, areaSqm: room.areaSqm })),
    options.statedSqm ?? null,
  );

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
                'image', 'm', ${sha256}, ${size}, 'parsed', ${options.statedSqm ?? null},
                ${`raster:${document.source}`}, ${document.model_id}, now())
        on conflict (property_id, level) where status <> 'rejected'
        do update set parsed_at = now(), stated_area_sqm = excluded.stated_area_sqm,
                      parser_version = excluded.parser_version
        returning id`;
      const plan = inserted[0];
      if (plan === undefined) throw new Error('floor_plans insert returned no row');

      const { replaced } = await guardSupersede(tx, plan.id, sha256);
      if (replaced) await clearSupersededRooms(tx, plan.id);

      await tx`
        insert into plan_extractions (organization_id, floor_plan_id, engine, engine_version, params, stats, warnings)
        values (${property.organization_id}::uuid, ${plan.id}::uuid, ${`raster:${document.source}`},
                ${document.model_id},
                ${JSON.stringify({ metres_per_pixel: document.metres_per_pixel, image: document.image })}::jsonb,
                ${JSON.stringify({ claims: measured.length, accepted: accepted.length })}::jsonb,
                ${JSON.stringify(measured.filter((room) => !room.accepted).map((room) => ({ code: room.code, flags: room.flags })))}::jsonb)`;

      for (const room of measured) {
        if (!room.accepted) continue;
        const source = document.rooms.find((entry) => entry.code === room.code);
        const kind = ROOM_KINDS.has(room.room_kind) ? room.room_kind : 'other';
        // The polygon is stored in pixels with its scale, because a pixel ring
        // without the metres-per-pixel it was measured at is unreadable later.
        const polygon = JSON.stringify({
          frame: 'pixels',
          metres_per_pixel: document.metres_per_pixel,
          ring: source?.polygon ?? [],
        });
        await tx`
          insert into plan_rooms (organization_id, floor_plan_id, code, label, room_kind,
                                  area_sqm, polygon, source, confidence)
          values (${property.organization_id}::uuid, ${plan.id}::uuid, ${room.code},
                  ${source?.label ?? null}, ${kind}, ${room.areaSqm}, ${polygon}::jsonb,
                  'raster_model', ${room.confidence})
          on conflict (floor_plan_id, code) do update
            set area_sqm = excluded.area_sqm, polygon = excluded.polygon,
                label = excluded.label, room_kind = excluded.room_kind,
                source = excluded.source, confidence = excluded.confidence,
                updated_at = now()`;
      }
      return plan.id;
    });

    return {
      floorPlanId,
      propertyId: property.id,
      source: document.source,
      modelId: document.model_id,
      metresPerPixel: document.metres_per_pixel,
      claims: measured.length,
      accepted: measured.filter((room) => room.accepted).length,
      refused: measured
        .filter((room) => !room.accepted)
        .map((room) => ({ code: room.code, flags: room.flags })),
      rooms: measured,
      sumSqm: reconciliation.sumSqm,
      reconciliation,
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

if (
  process.argv[1]?.endsWith('raster.ts') === true ||
  process.argv[1]?.endsWith('raster.js') === true
) {
  const filePath = argument('file');
  const property = argument('property');
  const level = argument('level');
  if (filePath === undefined || property === undefined || level === undefined) {
    console.error(
      'usage: plan:import-raster --file <model.json> --property <name|uuid> --level <name> [--stated <m2>]',
    );
    process.exit(2);
  }
  const stated = argument('stated');
  importRasterPlan({
    filePath,
    property,
    level,
    statedSqm: stated === undefined ? null : Number(stated),
  })
    .then((result) => {
      console.info(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2),
      );
      process.exit(1);
    });
}
