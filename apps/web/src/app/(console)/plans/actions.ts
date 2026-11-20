'use server';

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { importRasterPlan, ingestPlan } from '@aqar/drawings';
import { getSessionUser } from '@/lib/auth';
import { sql } from '@/lib/db';

/**
 * Server actions for the drawing console.
 *
 * Two rules this file must never break:
 *   * an upload creates *evidence*, never a charge — no action here writes
 *     `units.area_sqm`;
 *   * materialising units is a **proposal**. The console proposes, a human
 *     approves, and only then does anything reach the ledger.
 */

// Two input classes, one door. A vector drawing arrives as itself; a raster plan
// arrives as the JSON a segmentation model produced, which is self-describing
// (polygons in pixels plus metres-per-pixel), so it needs no extra form field.
const VECTOR = new Set(['.dxf', '.dwg', '.pdf']);
const RASTER = new Set(['.json']);
const ALLOWED = new Set([...VECTOR, ...RASTER]);
const MAX_BYTES = 25 * 1024 * 1024;

function uploadDir(): string {
  return process.env['AQAR_PLAN_UPLOAD_DIR'] ?? join(process.cwd(), 'var', 'plans');
}

export async function uploadPlanAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (user === null) redirect('/login');

  const file = formData.get('file');
  const propertyId = String(formData.get('propertyId') ?? '');
  const level = String(formData.get('level') ?? '').trim();
  const statedRaw = String(formData.get('stated') ?? '').trim();
  const calibrateRaw = String(formData.get('calibrate') ?? '').trim();

  if (!(file instanceof File) || file.size === 0) redirect('/plans?error=no_file');
  if (propertyId === '' || level === '') redirect('/plans?error=missing_fields');

  const extension = extname(file.name).toLowerCase();
  if (!ALLOWED.has(extension)) redirect('/plans?error=bad_type');
  if (file.size > MAX_BYTES) redirect('/plans?error=too_large');

  const bytes = Buffer.from(await file.arrayBuffer());
  const directory = uploadDir();
  await mkdir(directory, { recursive: true });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = join(directory, `${digest.slice(0, 16)}${extension}`);
  await writeFile(path, bytes);

  try {
    const statedSqm = statedRaw === '' ? null : Number(statedRaw);
    const result = RASTER.has(extension)
      ? await importRasterPlan({ filePath: path, property: propertyId, level, statedSqm })
      : await ingestPlan({
          filePath: path,
          property: propertyId,
          level,
          statedSqm,
          ...(calibrateRaw === '' ? {} : { calibrate: calibrateRaw }),
        });
    revalidatePath('/plans');
    redirect(`/plans/${result.floorPlanId}`);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'digest' in error) throw error;
    const message = error instanceof Error ? error.message : 'unknown_error';
    redirect(`/plans?error=${encodeURIComponent(message.slice(0, 120))}`);
  }
}

export async function confirmRoomAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (user === null) redirect('/login');
  const planId = String(formData.get('planId') ?? '');
  const code = String(formData.get('code') ?? '');
  if (planId === '' || code === '') redirect('/plans?error=missing_fields');

  // Confirming an area is naming the person who vouches for it. The database
  // refuses a half-confirmation, so both columns move together or neither does.
  await sql`
    update plan_rooms
       set confirmed_by = ${user.id}::uuid, confirmed_at = now(), updated_at = now()
     where organization_id = ${user.orgId}::uuid
       and floor_plan_id = ${planId}::uuid
       and code = ${code}`;
  revalidatePath(`/plans/${planId}`);
}

export async function proposeUnitsAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (user === null) redirect('/login');
  const planId = String(formData.get('planId') ?? '');
  if (planId === '') redirect('/plans?error=missing_fields');

  const rooms = await sql<{ code: string; label: string | null; area_sqm: string }[]>`
    select code, label, area_sqm from plan_rooms
     where organization_id = ${user.orgId}::uuid
       and floor_plan_id = ${planId}::uuid
       and room_kind = 'unit'
       and confirmed_at is not null
     order by code`;

  if (rooms.length === 0) redirect(`/plans/${planId}?error=nothing_confirmed`);

  const plan = await sql<{ level: string; property_id: string; property_name: string }[]>`
    select f.level, f.property_id, p.name as property_name
      from floor_plans f join properties p on p.id = f.property_id
     where f.organization_id = ${user.orgId}::uuid and f.id = ${planId}::uuid`;
  const row = plan[0];
  if (row === undefined) redirect('/plans?error=unknown_plan');

  const args = {
    planId,
    level: row.level,
    propertyId: row.property_id,
    rooms: rooms.map((room) => ({
      code: room.code,
      label: room.label,
      areaSqm: Number(room.area_sqm),
      areaSource: 'plan' as const,
    })),
  };
  const argsHash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  const idempotencyKey = `plan:${planId}:propose:${argsHash.slice(0, 12)}`;

  // A proposal, not a write. `posted` stays false until a human approves and the
  // executor runs; this row is the record that someone asked.
  await sql`
    insert into action_proposals (organization_id, tool_name, action, args, args_hash, summary,
                                  status, requested_by, model_id, idempotency_key, expires_at)
    select ${user.orgId}::uuid, 'plans.materialize', 'create_units_from_plan',
           ${JSON.stringify(args)}::jsonb, ${argsHash},
           ${`Create ${rooms.length} unit(s) on ${row.level} from drawing ${planId.slice(0, 8)}`},
           'pending',
           ${JSON.stringify({ userId: user.id, via: 'console' })}::jsonb,
           'human',
           ${idempotencyKey},
           now() + interval '7 days'
     where not exists (select 1 from action_proposals where idempotency_key = ${idempotencyKey})`;

  revalidatePath(`/plans/${planId}`);
}
