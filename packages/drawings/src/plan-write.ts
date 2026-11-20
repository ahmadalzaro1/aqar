/**
 * What happens when a level is drawn twice.
 *
 * `floor_plans_property_level_uq` says one plan per property per level, so the second
 * upload of a *different* drawing replaces the first. That is the useful behaviour —
 * a revised drawing should not need a delete — but it has one dangerous edge: the
 * rooms of the old drawing may already carry a person's confirmation, or may already
 * have become units. Replacing those silently would delete an act, and this system
 * does not delete acts.
 *
 * So: a plan with a confirmed or materialised room refuses to be replaced. Superseding
 * it is a decision somebody makes, with the old drawing in front of them, not a side
 * effect of an upload.
 */

import type { TransactionSql } from 'postgres';

export class PlanSupersedeError extends Error {
  readonly code = 'plan_is_confirmed';

  constructor(readonly confirmedRooms: number) {
    super(
      `this level already has a drawing with ${confirmedRooms} confirmed or materialised room(s); ` +
        'supersede it deliberately instead of uploading over it',
    );
    this.name = 'PlanSupersedeError';
  }
}

function isSupersedeError(error: unknown): boolean {
  return error instanceof PlanSupersedeError;
}

/**
 * Refuses when the plan being re-parsed has human or downstream state attached.
 * A byte-identical re-parse is not a supersede, so it passes.
 */
export async function guardSupersede(
  tx: TransactionSql,
  planId: string,
  incomingSha256: string,
): Promise<{ readonly replaced: boolean }> {
  const existing = await tx<{ sha256: string | null }[]>`
    select sha256 from floor_plans where id = ${planId}::uuid`;
  const previousSha = existing[0]?.sha256 ?? null;
  if (previousSha === undefined || previousSha === null) return { replaced: false };
  // A byte-identical re-parse is the same drawing again: rooms upsert in place and
  // confirmations survive, because nothing about them became untrue.
  if (previousSha === incomingSha256) return { replaced: false };

  const counted = await tx<{ n: number }[]>`
    select count(*)::int as n from plan_rooms
     where floor_plan_id = ${planId}::uuid
       and (confirmed_by is not null or unit_id is not null
            or confirmed_at is not null)`;
  const confirmedRooms = counted[0]?.n ?? 0;
  if (confirmedRooms > 0) throw new PlanSupersedeError(confirmedRooms);
  return { replaced: true };
}

/**
 * Clears the rooms of the drawing being replaced. Only call after `guardSupersede`
 * has passed: at this point nothing in the table is a human act.
 */
export async function clearSupersededRooms(tx: TransactionSql, planId: string): Promise<void> {
  await tx`delete from plan_rooms where floor_plan_id = ${planId}::uuid`;
}

export { isSupersedeError };
