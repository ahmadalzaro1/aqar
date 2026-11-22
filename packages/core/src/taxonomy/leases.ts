import type { SpaceKind } from './spaces.js';

/**
 * Lease kinds and the billing rules each one implies.
 *
 * The pairing rule exists because a wrong cycle is not a cosmetic error: monthly
 * billing on an agricultural lease produces twelve late fees a year against a
 * tenant who owes one payment, and an annual cycle on a daily rental produces a
 * single 365-day receivable nobody collects.
 */

export const LEASE_KINDS = [
  'residential',
  'commercial',
  'industrial',
  'agricultural',
  'short_term',
  'parking',
  'bare_land',
] as const;

export type LeaseKind = (typeof LEASE_KINDS)[number];

export const BILLING_CYCLES = [
  'monthly',
  'quarterly',
  'semi_annual',
  'annual',
  'upfront_single',
] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Months between invoices; `upfront_single` is 0 because it bills once. */
export const CYCLE_MONTHS: Readonly<Record<BillingCycle, number>> = {
  monthly: 1,
  quarterly: 3,
  semi_annual: 6,
  annual: 12,
  upfront_single: 0,
};

const ALLOWED: Readonly<Record<LeaseKind, readonly BillingCycle[]>> = {
  residential: ['monthly', 'quarterly', 'semi_annual', 'annual'],
  commercial: ['monthly', 'quarterly', 'semi_annual', 'annual'],
  industrial: ['monthly', 'quarterly', 'semi_annual', 'annual'],
  agricultural: ['quarterly', 'semi_annual', 'annual', 'upfront_single'],
  short_term: ['upfront_single', 'monthly'],
  parking: ['monthly', 'quarterly', 'upfront_single'],
  bare_land: ['semi_annual', 'annual', 'upfront_single'],
};

export function allowedCycles(kind: LeaseKind): readonly BillingCycle[] {
  return ALLOWED[kind];
}

export function cycleAllowed(kind: LeaseKind, cycle: BillingCycle): boolean {
  return ALLOWED[kind].includes(cycle);
}

/**
 * Default notice period in days, by kind. It is a default the operator can
 * override — Jordanian residential practice is one month, commercial leases are
 * negotiated, and agricultural notice follows the crop year, not the calendar.
 */
export const DEFAULT_NOTICE_DAYS: Readonly<Record<LeaseKind, number>> = {
  residential: 30,
  commercial: 60,
  industrial: 90,
  agricultural: 180,
  short_term: 7,
  parking: 15,
  bare_land: 180,
};

/**
 * A deposit is security, not revenue. The ceiling is a policy default and is
 * stored as data so a jurisdiction rule can be replaced without a deploy.
 */
export const DEPOSIT_MONTHS_CAP: Readonly<Record<LeaseKind, number>> = {
  residential: 1,
  commercial: 3,
  industrial: 3,
  agricultural: 12,
  short_term: 1,
  parking: 1,
  bare_land: 12,
};

/**
 * How many invoices a period produces. A digest, a statement and an arrears
 * report all need this number, and deriving it in three places is how a report
 * ends up disagreeing with the ledger.
 */
export function invoicesPerYear(cycle: BillingCycle): number {
  const months = CYCLE_MONTHS[cycle];
  if (months === 0) return 1;
  return Math.round(12 / months);
}

/** The lease kind a space kind may carry, for the console's default and the guard. */
export function defaultLeaseKind(kind: SpaceKind): LeaseKind {
  switch (kind) {
    case 'parking':
      return 'parking';
    case 'land':
    case 'signage':
      return 'bare_land';
    case 'farm':
      return 'agricultural';
    case 'warehouse':
    case 'cold_store':
      return 'industrial';
    case 'office':
    case 'shop':
    case 'showroom':
    case 'workshop':
      return 'commercial';
    default:
      return 'residential';
  }
}
