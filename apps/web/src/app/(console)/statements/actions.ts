'use server';

// The ONLY write path for statements. Session-guarded, recomputes server-side
// (the client preview is never trusted), one transaction, append-only audit,
// idempotent on property+period. Distributions are created as drafts only.
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { sql } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import {
  computeStatement,
  distributionDrafts,
  parseStatementPeriod,
  statementIdempotencyKey,
} from './lib';
import {
  existingDistributionOwnerIds,
  existingStatement,
  expenseLines,
  feeBasisBps,
  propertyShares,
  rentLines,
} from './queries';

export type IssueResult =
  | { readonly status: 'issued'; readonly statementId: string; readonly drafts: number }
  | { readonly status: 'already_issued'; readonly statementId: string }
  | { readonly status: 'blocked'; readonly detail: string }
  | { readonly status: 'invalid' }
  | { readonly status: 'unauthorized' };

export async function issueStatement(propertyId: string, rawPeriod: string): Promise<IssueResult> {
  const user = await getSessionUser();
  if (user === null) return { status: 'unauthorized' };
  const period = parseStatementPeriod(rawPeriod);
  if (period === null) return { status: 'invalid' };
  const orgId = user.orgId;

  const [rent, expenses, shares, fee] = await Promise.all([
    rentLines(orgId, propertyId, period),
    expenseLines(orgId, propertyId, period),
    propertyShares(orgId, propertyId),
    feeBasisBps(orgId, propertyId),
  ]);
  const draft = computeStatement({
    propertyId,
    period,
    rentLines: rent,
    expenseLines: expenses,
    shares,
    feeBasisBps: fee.bps,
  });
  if (draft.blocked !== null || draft.netFils === null) {
    return { status: 'blocked', detail: draft.blocked?.detail ?? 'blocked' };
  }
  const netFils = draft.netFils;
  const key = statementIdempotencyKey(propertyId, period);
  const now = new Date();

  const outcome = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    const inserted = await tx`
      INSERT INTO owner_statements
        (id, organization_id, property_id, period, gross_rent_fils, expenses_fils,
         management_fee_fils, net_fils, issued_at)
      VALUES
        (${randomUUID()}, ${orgId}, ${propertyId}, ${period}, ${draft.grossCollectedFils},
         ${draft.expensesFils}, ${draft.managementFeeFils}, ${netFils}, ${now})
      ON CONFLICT (property_id, period) DO NOTHING
      RETURNING id`;
    const row = inserted[0];
    if (row === undefined) {
      const prior = await existingStatement(orgId, propertyId, period);
      return { status: 'already_issued' as const, statementId: prior?.id ?? '', drafts: 0 };
    }
    const statementId = String(row['id']);

    const held = await existingDistributionOwnerIds(orgId, propertyId, period);
    let drafts = 0;
    for (const d of distributionDrafts(draft)) {
      if (held.has(d.ownerId)) continue;
      await tx`
        INSERT INTO distributions
          (id, organization_id, owner_id, property_id, period, amount_fils, status)
        VALUES
          (${randomUUID()}, ${orgId}, ${d.ownerId}, ${propertyId}, ${period}, ${d.amountFils}, 'draft')`;
      drafts += 1;
    }

    await tx`
      INSERT INTO audit_events
        (id, organization_id, actor, action, entity_type, entity_id, before, after,
         model_id, prompt_version, confidence, idempotency_key, occurred_at)
      VALUES
        (${randomUUID()}, ${orgId},
         ${JSON.stringify({ kind: 'user', id: user.id })}::jsonb,
         'owner_statement.issue', 'owner_statement', ${statementId},
         NULL,
         ${JSON.stringify({ propertyId, period, grossCollectedFils: draft.grossCollectedFils, expensesFils: draft.expensesFils, managementFeeFils: draft.managementFeeFils, netFils, feeBps: fee.bps, drafts })}::jsonb,
         NULL, NULL, NULL, ${key}, ${now})`;
    return { status: 'issued' as const, statementId, drafts };
  });

  if (outcome.status === 'issued') revalidatePath('/statements');
  return outcome;
}
