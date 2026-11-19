// Monthly rent charge generation: deterministic, idempotent, order-invariant.
import type { Charge, LeaseMoneyTerms, Period } from '@aqar/contracts';
import { formatIsoDate, monthBounds, parsePeriod, toDayNumber } from './iso.js';
import { mulDivFloor } from './fils.js';

/** Canonical serialization used only to break ties between duplicate lease ids deterministically. */
function canonicalLease(lease: LeaseMoneyTerms): string {
  const lateFee = lease.lateFeeRule === null ? 'null' : JSON.stringify(lease.lateFeeRule);
  const escalation = JSON.stringify(lease.escalationRule);
  return [
    lease.leaseId,
    lease.rentFils,
    lease.depositFils,
    lease.dueDay,
    lease.startISO,
    lease.endISO,
    lease.status,
    lateFee,
    escalation,
  ].join('|');
}

function chargeKey(leaseId: string, period: Period, kind: Charge['kind']): string {
  return `${leaseId}|${period}|${kind}`;
}

/**
 * One rent charge per intersecting, active-or-upcoming lease for `period`.
 * Id is `${leaseId}:${period}:rent`; an already-present lease+period+kind is skipped,
 * which makes the function idempotent: feeding its own output back as `existing`
 * yields an empty list.
 *
 * Days are counted inclusively and clipped to the month, so a lease that starts or
 * ends inside the month is prorated as floor(rentFils * daysCovered / daysInMonth).
 */
export function generateMonthlyCharges(
  leases: readonly LeaseMoneyTerms[],
  period: Period,
  existing: readonly Charge[],
): Charge[] {
  const { year, month } = parsePeriod(period);
  const bounds = monthBounds(period);

  // Duplicate lease ids would make the result depend on input order; resolve them
  // by canonical serialization instead of "whichever came first".
  const uniqueLeases = new Map<string, LeaseMoneyTerms>();
  for (const lease of leases) {
    const current = uniqueLeases.get(lease.leaseId);
    if (current === undefined || canonicalLease(lease) < canonicalLease(current)) {
      uniqueLeases.set(lease.leaseId, lease);
    }
  }

  const existingKeys = new Set<string>();
  for (const charge of existing) existingKeys.add(chargeKey(charge.leaseId, charge.period, charge.kind));

  const generated: Charge[] = [];
  for (const lease of uniqueLeases.values()) {
    if (lease.status !== 'active' && lease.status !== 'upcoming') continue;

    const leaseStart = toDayNumber(lease.startISO);
    const leaseEnd = toDayNumber(lease.endISO);
    if (leaseEnd < bounds.firstDay || leaseStart > bounds.lastDay) continue;

    const clippedStart = Math.max(leaseStart, bounds.firstDay);
    const clippedEnd = Math.min(leaseEnd, bounds.lastDay);
    const daysCovered = clippedEnd - clippedStart + 1;
    if (daysCovered <= 0) continue;

    if (existingKeys.has(chargeKey(lease.leaseId, period, 'rent'))) continue;

    const prorated = daysCovered < bounds.days;
    generated.push({
      id: `${lease.leaseId}:${period}:rent`,
      leaseId: lease.leaseId,
      period,
      kind: 'rent',
      amountFils: prorated ? mulDivFloor(lease.rentFils, daysCovered, bounds.days) : lease.rentFils,
      // Contract caps dueDay at 28, so this clamp is only defensive.
      dueDateISO: formatIsoDate({ year, month, day: Math.min(lease.dueDay, bounds.days) }),
      proratedDays: prorated ? daysCovered : null,
    });
  }

  generated.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return generated;
}
