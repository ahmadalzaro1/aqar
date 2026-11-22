/**
 * Where policy comes from.
 *
 * `@aqar/core` compiles limits into a predicate but must not read a database.
 * This is the seam: one query, one strict parse, one compiled policy per call.
 *
 * Two rules make it safe to be per-org:
 *   - an organization with no row gets the shipped default, so the version is
 *     stable and the numbers are not duplicated in SQL;
 *   - an organization with an *unreadable* row refuses to decide. Falling back to
 *     the default on a parse error would silently widen policy for exactly the
 *     organization whose limits someone was editing.
 */
import {
  compilePolicy,
  DEFAULT_POLICY_LIMITS,
  type CompiledPolicy,
  type PolicyLimits,
} from '@aqar/core';
import { z } from 'zod';
import { sql } from '@/lib/db';

const limitsSchema = z
  .object({
    approverRoles: z.array(z.string().min(1)).min(1).max(20),
    nteCeilingFils: z.number().int().positive(),
    autoApproveUnderFils: z.number().int().nonnegative(),
    reversalWindowHours: z
      .number()
      .int()
      .positive()
      .max(24 * 365),
    dualControlAboveFils: z.number().int().positive().nullable(),
    requiredApprovers: z.number().int().min(1).max(5),
    policyEditorRoles: z.array(z.string().min(1)).min(1).max(5),
  })
  .strict();

export const policyLimitsSchema = limitsSchema;

/** Compile the policy that applies to this organization right now. */
export async function loadPolicy(organizationId: string): Promise<CompiledPolicy> {
  const rows = await sql<{ limits: unknown }[]>`
    select limits from policy_limits where organization_id = ${organizationId}
  `;
  const row = rows[0];
  if (row === undefined) return compilePolicy();

  const parsed = limitsSchema.safeParse(row.limits);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `stored policy limits for this organization are unreadable (${issues}) — refusing to decide rather than apply a different policy`,
    );
  }
  const limits: PolicyLimits = parsed.data;
  return compilePolicy(limits);
}

/** The shipped defaults, for a console that wants to show what "unset" means. */
export const SHIPPED_LIMITS: PolicyLimits = DEFAULT_POLICY_LIMITS;
