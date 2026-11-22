// Aging: unpaid balance per charge, bucketed by days past due as of an input date.
import type { AgingBucket, Allocation, Charge, IsoDate, Period } from '@aqar/contracts';
import { daysBetween } from './iso.js';
import { outstandingFils } from './allocations.js';

export const AGING_BUCKETS: readonly AgingBucket[] = [
  'current',
  'd0_30',
  'd31_60',
  'd61_90',
  'd90_plus',
];

export interface AgingRow {
  readonly chargeId: string;
  readonly leaseId: string;
  readonly period: Period;
  readonly dueDateISO: IsoDate;
  readonly balanceFils: number;
  readonly daysPastDue: number;
  readonly bucket: AgingBucket;
}

export interface AgingReport {
  readonly asOfISO: IsoDate;
  readonly buckets: Readonly<Record<AgingBucket, number>>;
  readonly totalFils: number;
  readonly rows: readonly AgingRow[];
}

/** Bucket for a day count that is positive only once the due date has passed. */
export function agingBucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'd0_30';
  if (daysPastDue <= 60) return 'd31_60';
  if (daysPastDue <= 90) return 'd61_90';
  return 'd90_plus';
}

/**
 * Fully paid charges are omitted. A balance therefore only ever moves to an equal or
 * older bucket as `asOfISO` advances, because the bucket depends solely on days past due.
 */
export function agingReport(
  charges: readonly Charge[],
  allocations: readonly Allocation[],
  asOfISO: IsoDate,
): AgingReport {
  const buckets: Record<AgingBucket, number> = {
    current: 0,
    d0_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  };

  const rows: AgingRow[] = [];
  for (const charge of charges) {
    const balanceFils = outstandingFils(charge, allocations);
    if (balanceFils <= 0) continue;
    const daysPastDue = daysBetween(charge.dueDateISO, asOfISO);
    const bucket = agingBucketFor(daysPastDue);
    buckets[bucket] += balanceFils;
    rows.push({
      chargeId: charge.id,
      leaseId: charge.leaseId,
      period: charge.period,
      dueDateISO: charge.dueDateISO,
      balanceFils,
      daysPastDue,
      bucket,
    });
  }

  let totalFils = 0;
  for (const bucket of AGING_BUCKETS) totalFils += buckets[bucket];

  rows.sort((a, b) => {
    if (a.dueDateISO !== b.dueDateISO) return a.dueDateISO < b.dueDateISO ? -1 : 1;
    if (a.chargeId !== b.chargeId) return a.chargeId < b.chargeId ? -1 : 1;
    return 0;
  });

  return { asOfISO, buckets, totalFils, rows };
}
