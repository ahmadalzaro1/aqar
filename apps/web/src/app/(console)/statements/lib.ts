// Owner-statement engine wiring. PURE: no I/O, no clock, no React, no DB.
//
// LAW 1 — every fils in this module comes out of @aqar/core. Nothing here adds,
// subtracts, multiplies or divides money on its own: it collects ledger rows and
// hands them to `sumFils`, `managementFee`, `distributionWaterfall` and
// `splitByShares`. If core throws, the draft is reported as blocked instead of
// inventing a number.
import { periodSchema } from '@aqar/contracts';
import type { OwnerShare, Period } from '@aqar/contracts';
import {
  collectionRateBps,
  distributionWaterfall,
  managementFee,
  splitByShares,
  sumFils,
} from '@aqar/core';

/**
 * Fee rate used when a property has no `management_fees` row at all.
 * Seeded fee schedules are written at 800 bps (packages/db/src/seed.ts), so this
 * only ever applies to a property that has never had a fee recorded.
 */
export const DEFAULT_MANAGEMENT_FEE_BPS = 800;

/** No reserve top-up is configured anywhere in M7 yet; the waterfall still takes it. */
export const STATEMENT_RESERVE_FILS = 0;

/** One lease's rent charge for the period, with what was actually collected against it. */
export interface RentLine {
  readonly leaseId: string;
  readonly unitLabel: string;
  readonly tenantName: string;
  readonly billedFils: number;
  readonly collectedFils: number;
}

/** One completed work order charged to the property inside the period. */
export interface ExpenseLine {
  readonly workOrderId: string;
  readonly label: string;
  readonly completedISO: string;
  readonly costFils: number;
}

export interface OwnerShareAmount {
  readonly ownerId: string;
  readonly shareBps: number;
  readonly amountFils: number;
}

/** Everything the computation needs, already read from the ledger. */
export interface StatementSource {
  readonly propertyId: string;
  readonly period: Period;
  readonly rentLines: readonly RentLine[];
  readonly expenseLines: readonly ExpenseLine[];
  /** EVERY owner share of the property: the split needs the full 10000 bps. */
  readonly shares: readonly OwnerShare[];
  readonly feeBasisBps: number;
}

export type BlockCode = 'no-owners' | 'invalid-shares' | 'shortfall';

export interface StatementBlock {
  readonly code: BlockCode;
  readonly detail: string;
}

export interface StatementDraft {
  readonly propertyId: string;
  readonly period: Period;
  /** Rent charged to tenants for the period (context for the fee base and collection rate). */
  readonly billedRentFils: number;
  /** Rent actually collected in the period — the waterfall's gross. */
  readonly grossCollectedFils: number;
  readonly collectionRateBps: number;
  readonly expensesFils: number;
  readonly feeBps: number;
  readonly managementFeeFils: number;
  readonly reserveFils: number;
  /** null when the draft is blocked: never a guessed or negative figure. */
  readonly netFils: number | null;
  readonly ownerShares: readonly OwnerShareAmount[];
  readonly blocked: StatementBlock | null;
}

/** 'YYYY-MM' or null. Delegates to the contracts period schema — one source of truth. */
export function parseStatementPeriod(raw: string | undefined): Period | null {
  if (raw === undefined) return null;
  const parsed = periodSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Audit idempotency key for issuing one property's statement for one period.
 * The owner is NOT part of the key: `owner_statements` is unique per
 * property+period, so the same key must collapse a re-issue of any owner's view.
 */
export function statementIdempotencyKey(propertyId: string, period: string): string {
  return `${propertyId}:${period}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Builds the statement draft.
 *
 * Order of operations (all core):
 *   1. billed / collected = sumFils over the per-lease rent lines
 *   2. expenses           = sumFils over completed work orders
 *   3. fee                = managementFee(collected, feeBps)   [floor]
 *   4. net                = distributionWaterfall(collected, fee, expenses, reserve)
 *   5. owner amount       = splitByShares(net, all property shares)
 *
 * Remainder policy: `splitByShares` uses largest remainder and breaks ties by
 * ownerId ascending, so every fil is assigned and the same inputs always produce
 * the same per-owner figures regardless of row order. We assert that invariant
 * before returning and refuse to emit a draft that lost a fil.
 */
export function computeStatement(source: StatementSource): StatementDraft {
  const billedRentFils = sumFils(source.rentLines.map((line) => line.billedFils));
  const grossCollectedFils = sumFils(source.rentLines.map((line) => line.collectedFils));
  const expensesFils = sumFils(source.expenseLines.map((line) => line.costFils));
  const managementFeeFils = managementFee(grossCollectedFils, source.feeBasisBps);
  const base = {
    propertyId: source.propertyId,
    period: source.period,
    billedRentFils,
    grossCollectedFils,
    collectionRateBps: collectionRateBps(grossCollectedFils, billedRentFils),
    expensesFils,
    feeBps: source.feeBasisBps,
    managementFeeFils,
    reserveFils: STATEMENT_RESERVE_FILS,
  };

  if (source.shares.length === 0) {
    return {
      ...base,
      netFils: null,
      ownerShares: [],
      blocked: { code: 'no-owners', detail: 'no ownership shares recorded for this property' },
    };
  }

  let netFils: number;
  try {
    netFils = distributionWaterfall(
      grossCollectedFils,
      managementFeeFils,
      expensesFils,
      STATEMENT_RESERVE_FILS,
    );
  } catch (error) {
    return {
      ...base,
      netFils: null,
      ownerShares: [],
      blocked: { code: 'shortfall', detail: describe(error) },
    };
  }

  try {
    const apportioned = splitByShares(netFils, source.shares);
    const ownerShares = source.shares.map((share) => ({
      ownerId: share.ownerId,
      shareBps: share.shareBps,
      amountFils: apportioned[share.ownerId] ?? 0,
    }));
    const distributed = sumFils(ownerShares.map((share) => share.amountFils));
    if (distributed !== netFils) {
      throw new RangeError(
        `owner split does not balance: ${String(distributed)} fils allocated of ${String(netFils)}`,
      );
    }
    return { ...base, netFils, ownerShares, blocked: null };
  } catch (error) {
    return {
      ...base,
      netFils: null,
      ownerShares: [],
      blocked: { code: 'invalid-shares', detail: describe(error) },
    };
  }
}

/** This owner's share of the draft net, or 0 when the owner holds no share. */
export function ownerShareAmount(draft: StatementDraft, ownerId: string): number {
  const match = draft.ownerShares.find((share) => share.ownerId === ownerId);
  return match === undefined ? 0 : match.amountFils;
}

/**
 * Draft distribution rows for the 'Issue' transaction. Drafts only: approving or
 * paying a distribution is a separate, human, out-of-scope decision.
 */
export interface DistributionDraftRow {
  readonly ownerId: string;
  readonly amountFils: number;
  readonly status: 'draft';
}

export function distributionDrafts(draft: StatementDraft): DistributionDraftRow[] {
  if (draft.blocked !== null) return [];
  return draft.ownerShares
    .filter((share) => share.amountFils > 0)
    .map((share) => ({ ownerId: share.ownerId, amountFils: share.amountFils, status: 'draft' as const }));
}
