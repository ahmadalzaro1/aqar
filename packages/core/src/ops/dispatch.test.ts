import { describe, expect, it } from 'vitest';
import {
  approvalForNte,
  completionOutcome,
  eligibleVendors,
  quoteSelectionIsValid,
  rankQuotes,
  type DispatchVendor,
} from './dispatch.js';

function vendor(over: Partial<DispatchVendor> & { id: string }): DispatchVendor {
  return {
    nameEn: over.id,
    nameAr: null,
    trades: ['plumbing'],
    allowListed: true,
    insuranceCertExpiry: null,
    rating: null,
    score: null,
    ...over,
  };
}

describe('eligibleVendors', () => {
  it('keeps only allow-listed vendors that work the trade', () => {
    const out = eligibleVendors(
      [
        vendor({ id: 'a' }),
        vendor({ id: 'b', allowListed: false }),
        vendor({ id: 'c', trades: ['electrical'] }),
      ],
      { trade: 'plumbing', onDate: '2026-11-22' },
    );
    expect(out.map((v) => v.id)).toEqual(['a']);
  });

  it('compares trades trimmed and case-insensitively', () => {
    const out = eligibleVendors([vendor({ id: 'a', trades: ['  Plumbing '] })], {
      trade: 'PLUMBING',
      onDate: '2026-11-22',
    });
    expect(out).toHaveLength(1);
  });

  it('treats an insurance certificate expiring today as in force and yesterday as not', () => {
    const onDate = '2026-11-22';
    const kept = eligibleVendors([vendor({ id: 'today', insuranceCertExpiry: onDate })], {
      trade: 'plumbing',
      onDate,
    });
    const dropped = eligibleVendors(
      [vendor({ id: 'yesterday', insuranceCertExpiry: '2026-11-21' })],
      { trade: 'plumbing', onDate },
    );
    expect(kept.map((v) => v.id)).toEqual(['today']);
    expect(dropped).toHaveLength(0);
  });

  it('does not disqualify a vendor with no certificate on file', () => {
    const out = eligibleVendors([vendor({ id: 'new', insuranceCertExpiry: null })], {
      trade: 'plumbing',
      onDate: '2026-11-22',
    });
    expect(out.map((v) => v.id)).toEqual(['new']);
  });

  it('ranks by proven score, then rating, then name, and puts unproven vendors last', () => {
    const out = eligibleVendors(
      [
        vendor({ id: 'unproven', score: null, rating: 5 }),
        vendor({ id: 'b-low', score: 40 }),
        vendor({ id: 'a-high', score: 90 }),
        vendor({ id: 'b-mid', score: 40, rating: 4.5 }),
      ],
      { trade: 'plumbing', onDate: '2026-11-22' },
    );
    expect(out.map((v) => v.id)).toEqual(['a-high', 'b-mid', 'b-low', 'unproven']);
  });

  it('is stable for two identical vendors (name breaks the tie)', () => {
    const out = eligibleVendors(
      [vendor({ id: 'z', nameEn: 'Zeta' }), vendor({ id: 'a', nameEn: 'Alpha' })],
      { trade: 'plumbing', onDate: '2026-11-22' },
    );
    expect(out.map((v) => v.nameEn)).toEqual(['Alpha', 'Zeta']);
  });

  it('accepts a category word for the trade when the caller passes it as an alias', () => {
    const roster = [vendor({ id: 'p', trades: ['plumbing'] })];
    expect(eligibleVendors(roster, { trade: 'plumber', onDate: '2026-11-22' })).toHaveLength(0);
    expect(
      eligibleVendors(roster, { trade: 'plumber', onDate: '2026-11-22', aliases: ['plumbing'] }),
    ).toHaveLength(1);
  });

  it('returns an empty list rather than inventing a vendor', () => {
    expect(eligibleVendors([], { trade: 'plumbing', onDate: '2026-11-22' })).toEqual([]);
  });
});

describe('approvalForNte', () => {
  it('requires a human when no ceiling was stated', () => {
    expect(approvalForNte({ nteFils: null, approvalLimitFils: 50_000 })).toEqual({
      requiresApproval: true,
      reason: 'no_nte',
    });
  });

  it('requires a human above the limit and not at it', () => {
    expect(approvalForNte({ nteFils: 50_001, approvalLimitFils: 50_000 })).toEqual({
      requiresApproval: true,
      reason: 'over_limit',
    });
    expect(approvalForNte({ nteFils: 50_000, approvalLimitFils: 50_000 })).toEqual({
      requiresApproval: false,
      reason: 'within_limit',
    });
  });

  it('treats a zero limit as a real limit', () => {
    expect(approvalForNte({ nteFils: 0, approvalLimitFils: 0 }).requiresApproval).toBe(false);
    expect(approvalForNte({ nteFils: 1, approvalLimitFils: 0 }).requiresApproval).toBe(true);
  });

  it('refuses a ceiling that is not a whole number of fils', () => {
    expect(() => approvalForNte({ nteFils: 10.5, approvalLimitFils: 100 })).toThrow(/integer/);
    expect(() => approvalForNte({ nteFils: -1, approvalLimitFils: 100 })).toThrow(/integer/);
  });
});

describe('rankQuotes', () => {
  const q = (over: Partial<Parameters<typeof rankQuotes>[0][number]> & { id: string }) => ({
    vendorId: 'v1',
    amountFils: 1000,
    leadTimeDays: null,
    receivedAt: '2026-11-22T10:00:00.000Z',
    ...over,
  });

  it('orders by price, then lead time, then arrival, then id', () => {
    const out = rankQuotes([
      q({ id: 'pricey', amountFils: 5000 }),
      q({ id: 'cheap-slow', amountFils: 1000, leadTimeDays: 5 }),
      q({ id: 'cheap-fast', amountFils: 1000, leadTimeDays: 1 }),
      q({ id: 'cheap-unknown', amountFils: 1000, leadTimeDays: null }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['cheap-fast', 'cheap-slow', 'cheap-unknown', 'pricey']);
  });

  it('does not mutate the caller’s array', () => {
    const input = [q({ id: 'b', amountFils: 2 }), q({ id: 'a', amountFils: 1 })];
    rankQuotes(input);
    expect(input.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('quoteSelectionIsValid', () => {
  it('allows none or one selected quote, never two', () => {
    expect(quoteSelectionIsValid([])).toBe(true);
    expect(quoteSelectionIsValid([{ selected: true }, { selected: false }])).toBe(true);
    expect(quoteSelectionIsValid([{ selected: true }, { selected: true }])).toBe(false);
  });
});

describe('completionOutcome', () => {
  it('reports the variance against the authorised ceiling', () => {
    expect(completionOutcome({ costFils: 12_000, nteFils: 15_000 })).toEqual({
      varianceFils: -3_000,
      overNte: false,
    });
    expect(completionOutcome({ costFils: 18_000, nteFils: 15_000 })).toEqual({
      varianceFils: 3_000,
      overNte: true,
    });
  });

  it('treats an unbounded order as always over the ceiling', () => {
    expect(completionOutcome({ costFils: 7, nteFils: null })).toEqual({
      varianceFils: 7,
      overNte: true,
    });
  });

  it('refuses a negative invoice', () => {
    expect(() => completionOutcome({ costFils: -1, nteFils: 100 })).toThrow(/integer/);
  });
});
