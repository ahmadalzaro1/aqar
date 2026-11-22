import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { sql } from '@/lib/db';
import { compilePolicy } from '@aqar/core';
import { loadPolicy, policyLimitsSchema } from '@/lib/approvals/policy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/policy/limits — this organization's limits and their version.
 * PUT  /api/policy/limits — replace them.
 *
 * Two properties matter more than the endpoint:
 *   - authority comes from the policy itself (`policyEditorRoles`), so there is
 *     no second role list to keep in step;
 *   - the change is written with the version it replaced and the version it
 *     produced. A policy edit that silently rewrites history is worse than no
 *     edit, so the audit row is written in the same transaction as the limits.
 */
export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (user === null) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const policy = await loadPolicy(user.orgId);
  return NextResponse.json({ version: policy.version, limits: policy.limits });
}

export async function PUT(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (user === null) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const current = await loadPolicy(user.orgId);
  if (!current.limits.policyEditorRoles.includes(user.role)) {
    return NextResponse.json(
      {
        error: `role ${user.role} cannot edit policy limits (policy ${current.version} allows ${current.limits.policyEditorRoles.join(', ')})`,
      },
      { status: 403 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  // Accept both the bare limits object and the envelope GET returns, so a client
  // can read, edit and write back without reshaping. Then require the whole
  // object: a partial edit makes it impossible to say which numbers were in force
  // without diffing two rows.
  const candidate =
    typeof body === 'object' && body !== null && !Array.isArray(body) && 'limits' in body
      ? (body as Record<string, unknown>)['limits']
      : body;
  const parsed = policyLimitsSchema.safeParse(candidate);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'body must be the complete PolicyLimits object',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    );
  }

  // Sanity the schema cannot express: dual control must leave a band to apply to.
  if (
    parsed.data.dualControlAboveFils !== null &&
    parsed.data.dualControlAboveFils >= parsed.data.nteCeilingFils
  ) {
    return NextResponse.json(
      {
        error:
          'dualControlAboveFils must be below nteCeilingFils, otherwise the second key can never be required',
      },
      { status: 400 },
    );
  }

  // The version is a pure function of the limits, so it does not need a re-read:
  // the row and its stamp are computed from the same object.
  const after = compilePolicy(parsed.data as unknown as typeof current.limits);

  // One transaction, not two writes: a limits change whose audit row failed is a
  // change nobody can explain later, and an audit row without the change is a lie.
  await sql.begin(async (tx) => {
    await tx`
      insert into policy_limits (organization_id, limits, updated_at, updated_by_user_id)
      values (${user.orgId}, ${tx.json(parsed.data as unknown as Record<string, unknown>)}::jsonb, now(), ${user.id})
      on conflict (organization_id) do update
        set limits = excluded.limits, updated_at = now(), updated_by_user_id = excluded.updated_by_user_id
    `;
    await tx`
      insert into audit_events (organization_id, actor, action, entity_type, entity_id, before, after,
                                tool_calls, idempotency_key, occurred_at)
      values (${user.orgId},
              ${tx.json({ userId: user.id, role: user.role, via: 'api' })}::jsonb,
              'policy.limits_updated', 'policy_limits', ${user.orgId},
              ${tx.json({ version: current.version, limits: current.limits })}::jsonb,
              ${tx.json({ version: after.version, limits: after.limits })}::jsonb,
              ${tx.json([])}::jsonb, ${`policy-${user.orgId}-${randomUUID()}`}, now())
    `;
  });

  return NextResponse.json({
    version: after.version,
    previousVersion: current.version,
    limits: after.limits,
  });
}
