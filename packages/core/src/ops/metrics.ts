// Pure deterministic reporting metrics.
//
// Conventions that hold for every function here:
//   * money is integer fils (1 JOD = 1000 fils); never floats, never rounding to JOD
//   * rates are integer basis points (10000 bps = 100%)
//   * a rate with a zero denominator is 0 bps by convention (nothing billed, nothing
//     due, nothing leasable all mean "no measurable rate", not "NaN" and not 100%)
//   * every "now" is an argument; no clock is ever read
//   * outputs are ordered deterministically, so the same input yields equal arrays

const BPS_SCALE = 10_000n;
const DAY_MS = 86_400_000;
const MONTHS_PER_YEAR = 12;

/** Half-up rounding of numerator/denominator to an integer (exact, BigInt). */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (2n * n + d) / (2n * d);
  return negative ? -rounded : rounded;
}

/** Basis points of numerator/denominator, clamped to [0, 10000]. */
function ratioBps(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const bps = roundDiv(BigInt(numerator) * BPS_SCALE, BigInt(denominator));
  if (bps < 0n) return 0;
  if (bps > BPS_SCALE) return Number(BPS_SCALE);
  return Number(bps);
}

// ---------------------------------------------------------------- occupancy ---

export type UnitStatus = 'occupied' | 'vacant' | 'turnover' | 'unavailable';

export interface OccupancyUnit {
  readonly status: UnitStatus;
}

/**
 * Occupancy in basis points of leasable units.
 *
 * Leasable = occupied + vacant + turnover (frozen contracts enum). Units
 * marked `unavailable` (renovation, legal hold) are excluded from both
 * numerator and denominator. `turnover` is leasable stock between tenants,
 * counted unoccupied. Returns 0 when nothing is leasable.
 */
export function occupancyRate(units: readonly OccupancyUnit[]): number {
  let occupied = 0;
  let leasable = 0;
  for (const unit of units) {
    if (unit.status === 'unavailable') continue;
    leasable += 1;
    if (unit.status === 'occupied') occupied += 1;
  }
  return ratioBps(occupied, leasable);
}

// ------------------------------------------------------------------ money -----

/** Overdue receivable as basis points of everything billed. 0 when nothing billed. */
export function delinquencyRateBps(overdueBalanceFils: number, totalBilledFils: number): number {
  return ratioBps(overdueBalanceFils, totalBilledFils);
}

/**
 * Cash collected as basis points of amounts billed, clamped to 10000.
 * Advance payments can push raw collections above billings; the collected ratio
 * is capped at 100% so it reads as collection performance, not prepayment volume.
 */
export function collectionRateBps(collectedFils: number, billedFils: number): number {
  return ratioBps(collectedFils, billedFils);
}

/** Net operating income = income - expenses (may be negative). */
export function noiFils(incomeFils: number, expensesFils: number): number {
  return incomeFils - expensesFils;
}

// ------------------------------------------------------------- work orders ----

export type WorkOrderStatus = 'open' | 'in_progress' | 'closed';

export interface AgingWorkOrder {
  readonly openedAtISO: string;
  readonly status: WorkOrderStatus;
}

export interface WorkOrderAging {
  readonly d0_7: number;
  readonly d8_30: number;
  readonly d31_90: number;
  readonly d90_plus: number;
  readonly totalOpen: number;
}

function ageDays(openedAtISO: string, nowISO: string): number {
  const opened = new Date(openedAtISO).getTime();
  const now = new Date(nowISO).getTime();
  if (Number.isNaN(opened) || Number.isNaN(now)) {
    throw new Error(`invalid ISO instant in workOrderAging: '${openedAtISO}' / '${nowISO}'`);
  }
  const days = Math.floor((now - opened) / DAY_MS);
  return days < 0 ? 0 : days; // a future-opened ticket is "brand new", never negative
}

/**
 * Open work orders bucketed by age in whole days at `nowISO`.
 * Closed tickets are not aging and are excluded from every bucket.
 */
export function workOrderAging(
  tickets: readonly AgingWorkOrder[],
  nowISO: string,
): WorkOrderAging {
  let d0_7 = 0;
  let d8_30 = 0;
  let d31_90 = 0;
  let d90_plus = 0;
  for (const ticket of tickets) {
    if (ticket.status === 'closed') continue;
    const days = ageDays(ticket.openedAtISO, nowISO);
    if (days <= 7) d0_7 += 1;
    else if (days <= 30) d8_30 += 1;
    else if (days <= 90) d31_90 += 1;
    else d90_plus += 1;
  }
  return { d0_7, d8_30, d31_90, d90_plus, totalOpen: d0_7 + d8_30 + d31_90 + d90_plus };
}

export interface ResolvedWorkOrder {
  readonly openedAtISO: string;
  readonly closedAtISO: string;
}

/**
 * Mean time to resolution in hours over closed tickets, to one decimal place.
 * Null when nothing is closed (no measurement, not a zero). Negative durations are
 * clamped to 0 so one bad record cannot poison the mean.
 */
export function meanTimeToResolutionHours(tickets: readonly ResolvedWorkOrder[]): number | null {
  if (tickets.length === 0) return null;
  let totalMinutes = 0n;
  for (const ticket of tickets) {
    const opened = new Date(ticket.openedAtISO).getTime();
    const closed = new Date(ticket.closedAtISO).getTime();
    if (Number.isNaN(opened) || Number.isNaN(closed)) {
      throw new Error(
        `invalid ISO instant in meanTimeToResolutionHours: '${ticket.openedAtISO}' / '${ticket.closedAtISO}'`,
      );
    }
    const minutes = Math.max(0, Math.floor((closed - opened) / 60_000));
    totalMinutes += BigInt(minutes);
  }
  // tenths of an hour, half-up
  const tenths = roundDiv(totalMinutes * 10n, BigInt(tickets.length) * 60n);
  return Number(tenths) / 10;
}

// -------------------------------------------------------------- lease roll ----

export interface LeaseRollEntry {
  readonly endISO: string;
}

export interface LeaseRollBucket {
  /** YYYY-MM */
  readonly period: string;
  readonly expiringCount: number;
}

function monthIndex(iso: string): number {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid ISO date in leaseRollForecast: '${iso}'`);
  }
  return year * MONTHS_PER_YEAR + (month - 1);
}

function periodLabel(index: number): string {
  const year = Math.floor(index / MONTHS_PER_YEAR);
  const month = (index % MONTHS_PER_YEAR) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * Lease expiries per calendar month for the `months` months starting at the month
 * of `asOfISO` (inclusive of that month). Leases already expired before that month
 * are not forecast; null/negative `months` yields an empty array.
 *
 * `asOfISO` is required because core never reads a clock: the caller supplies the
 * reference instant.
 */
export function leaseRollForecast(
  leases: readonly LeaseRollEntry[],
  months: number,
  asOfISO: string,
): readonly LeaseRollBucket[] {
  if (months <= 0) return [];
  const startIndex = monthIndex(asOfISO);
  const counts = Array.from({ length: months }, (): number => 0);
  for (const lease of leases) {
    const index = monthIndex(lease.endISO) - startIndex;
    if (index < 0 || index >= months) continue;
    const current = counts[index];
    counts[index] = (current ?? 0) + 1;
  }
  return counts.map((expiringCount, offset) => ({
    period: periodLabel(startIndex + offset),
    expiringCount,
  }));
}

// ----------------------------------------------------------- vendor spend ----

export interface VendorInvoice {
  readonly vendorId: string;
  readonly amountFils: number;
}

export interface VendorSpend {
  readonly vendorId: string;
  readonly spendFils: number;
}

/**
 * Total invoiced fils per vendor, largest first then vendor id, so the ranking is
 * stable across runs and runtime implementations.
 */
export function vendorSpendFils(invoices: readonly VendorInvoice[]): readonly VendorSpend[] {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    totals.set(invoice.vendorId, (totals.get(invoice.vendorId) ?? 0) + invoice.amountFils);
  }
  return [...totals.entries()]
    .map(([vendorId, spendFils]) => ({ vendorId, spendFils }))
    .sort((a, b) => (b.spendFils - a.spendFils) || a.vendorId.localeCompare(b.vendorId));
}

// ----------------------------------------------------------- property P&L ----

export interface PropertyPnlRow {
  readonly propertyId: string;
  readonly incomeFils: number;
  readonly expenseFils: number;
}

export interface PropertyPnl {
  readonly propertyId: string;
  readonly incomeFils: number;
  readonly expenseFils: number;
  readonly noiFils: number;
}

/** Per-property income/expense aggregation with NOI, sorted by property id. */
export function propertyPnl(rows: readonly PropertyPnlRow[]): readonly PropertyPnl[] {
  const totals = new Map<string, { incomeFils: number; expenseFils: number }>();
  for (const row of rows) {
    const current = totals.get(row.propertyId) ?? { incomeFils: 0, expenseFils: 0 };
    totals.set(row.propertyId, {
      incomeFils: current.incomeFils + row.incomeFils,
      expenseFils: current.expenseFils + row.expenseFils,
    });
  }
  return [...totals.entries()]
    .map(([propertyId, sums]) => ({
      propertyId,
      incomeFils: sums.incomeFils,
      expenseFils: sums.expenseFils,
      noiFils: noiFils(sums.incomeFils, sums.expenseFils),
    }))
    .sort((a, b) => a.propertyId.localeCompare(b.propertyId));
}
