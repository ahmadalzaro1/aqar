import type { BankLine, Charge } from '@aqar/contracts';
import { dedupeBankLines, fingerprintBankLine, suggestMatch } from './bank.js';
import type { PayerProfile } from './bank.js';

function line(overrides: Partial<BankLine> = {}): BankLine {
  return {
    id: 'line-1',
    statementId: 'stmt-1',
    dateISO: '2026-01-06',
    amountFils: 300_000,
    payerName: 'Mohammed Ali',
    payerAccount: null,
    reference: null,
    ...overrides,
  };
}

function charge(id: string, leaseId: string, amountFils: number, dueDateISO: string): Charge {
  return { id, leaseId, period: dueDateISO.slice(0, 7), kind: 'rent', amountFils, dueDateISO, proratedDays: null };
}

function payer(overrides: Partial<PayerProfile> = {}): PayerProfile {
  return {
    payerId: 'payer-1',
    leaseId: 'lease-1',
    names: ['محمد علي', 'Mohammed Ali'],
    accounts: ['JO12ABCD1234'],
    confirmed: true,
    ...overrides,
  };
}

describe('fingerprintBankLine', () => {
  it('is stable and 8 hex characters', () => {
    const fingerprint = fingerprintBankLine(line());
    expect(fingerprint).toBe(fingerprintBankLine(line()));
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('ignores whitespace, case, diacritics and tatweel', () => {
    const plain = line({ payerName: 'محمد علي', reference: 'ايجار 2026' });
    const decorated = line({ payerName: '  مُحَمَّد   عَلِي ', reference: 'إيجار ٢٠٢٦' });
    expect(fingerprintBankLine(decorated)).toBe(fingerprintBankLine(plain));
  });

  it('changes when the amount, date or payer changes', () => {
    const base = fingerprintBankLine(line());
    expect(fingerprintBankLine(line({ amountFils: 300_001 }))).not.toBe(base);
    expect(fingerprintBankLine(line({ dateISO: '2026-01-07' }))).not.toBe(base);
    expect(fingerprintBankLine(line({ payerName: 'Other Payer' }))).not.toBe(base);
  });

  it('treats a missing reference and an empty reference the same', () => {
    expect(fingerprintBankLine(line({ reference: null }))).toBe(
      fingerprintBankLine(line({ reference: '' })),
    );
  });
});

describe('dedupeBankLines', () => {
  it('drops lines already imported and duplicates inside the batch', () => {
    const existing = [line({ id: 'old-1' })];
    const incoming = [
      line({ id: 'new-1' }),
      line({ id: 'new-2' }),
      line({ id: 'new-3', payerName: 'Someone Else' }),
    ];
    const fresh = dedupeBankLines(existing, incoming);
    expect(fresh.map((entry) => entry.id)).toEqual(['new-3']);
  });

  it('is idempotent', () => {
    const existing = [line({ id: 'old-1' })];
    const incoming = [line({ id: 'new-1' }), line({ id: 'new-2' })];
    const first = dedupeBankLines(existing, incoming);
    expect(dedupeBankLines([...existing, ...first], first)).toEqual([]);
  });
});

describe('suggestMatch', () => {
  const openCharge = [charge('charge-1', 'lease-1', 300_000, '2026-01-05')];

  it('auto-posts a confirmed payer paying exactly the outstanding balance', () => {
    const suggestion = suggestMatch(line(), [payer()], { 'lease-1': openCharge });
    expect(suggestion.kind).toBe('auto');
    expect(suggestion.confidence).toBe(0.95);
    expect(suggestion.leaseIds).toEqual(['lease-1']);
    expect(suggestion.payerId).toBe('payer-1');
    expect(suggestion.amountFils).toBe(300_000);
    expect(suggestion.reason.length).toBeGreaterThan(0);
  });

  it('sends an unconfirmed payer to review instead of auto', () => {
    const suggestion = suggestMatch(line(), [payer({ confirmed: false })], { 'lease-1': openCharge });
    expect(suggestion.kind).toBe('review');
    expect(suggestion.payerId).toBe('payer-1');
    expect(suggestion.confidence).toBeLessThan(0.95);
    expect(suggestion.reason).toContain('unconfirmed');
  });

  it('proposes an oldest-first allocation for a partial payment', () => {
    const charges = [
      charge('charge-late', 'lease-1', 200_000, '2026-02-05'),
      charge('charge-old', 'lease-1', 100_000, '2026-01-05'),
    ];
    const suggestion = suggestMatch(line({ amountFils: 150_000 }), [payer()], {
      'lease-1': charges,
    });
    expect(suggestion.kind).toBe('partial');
    expect(suggestion.leaseIds).toEqual(['lease-1']);
    expect(suggestion.reason).toContain('charge-old');
    expect(suggestion.reason).toMatch(/oldest-first/);
    expect(suggestion.confidence).toBe(0.8);
  });

  it('flags two plausible payers for the same amount as ambiguous', () => {
    const payers = [
      payer({ payerId: 'payer-1', leaseId: 'lease-1' }),
      payer({ payerId: 'payer-2', leaseId: 'lease-2' }),
    ];
    const suggestion = suggestMatch(line(), payers, {
      'lease-1': openCharge,
      'lease-2': [charge('charge-2', 'lease-2', 300_000, '2026-01-05')],
    });
    expect(suggestion.kind).toBe('ambiguous');
    expect(suggestion.payerId).toBeNull();
    expect(suggestion.leaseIds).toHaveLength(2);
    expect(suggestion.reason).toContain('payer-1');
    expect(suggestion.reason).toContain('payer-2');
  });

  it('reports an unknown payer when no profile matches', () => {
    const suggestion = suggestMatch(line({ payerName: 'Total Stranger' }), [payer()], {
      'lease-1': openCharge,
    });
    expect(suggestion.kind).toBe('unknown_payer');
    expect(suggestion.payerId).toBeNull();
    expect(suggestion.leaseIds).toEqual([]);
    expect(suggestion.reason.length).toBeGreaterThan(0);
  });

  it('never matches on reference text alone', () => {
    const suggestion = suggestMatch(
      line({ payerName: 'Total Stranger', reference: 'lease-1 rent charge-1' }),
      [payer()],
      { 'lease-1': openCharge },
    );
    expect(suggestion.kind).toBe('unknown_payer');
    expect(suggestion.leaseIds).toEqual([]);
  });

  it('matches on the payer bank account even with a different spelling', () => {
    const suggestion = suggestMatch(
      line({ payerName: 'M. ALI', payerAccount: 'jo12 abcd 1234' }),
      [payer()],
      { 'lease-1': openCharge },
    );
    expect(suggestion.kind).toBe('auto');
    expect(suggestion.payerId).toBe('payer-1');
  });

  it('sends an overpayment to review', () => {
    const suggestion = suggestMatch(line({ amountFils: 350_000 }), [payer()], {
      'lease-1': openCharge,
    });
    expect(suggestion.kind).toBe('review');
    expect(suggestion.reason).toContain('overpays');
  });

  it('sends a payer with no open charge to review', () => {
    const suggestion = suggestMatch(line({ amountFils: 0 }), [payer()], {});
    expect(suggestion.kind).toBe('review');
    expect(suggestion.payerId).toBe('payer-1');
    expect(suggestion.reason).toContain('no open charge');
  });

  it('keeps confidence inside 0..1 and always explains itself', () => {
    const cases = [
      suggestMatch(line(), [payer()], { 'lease-1': openCharge }),
      suggestMatch(line({ amountFils: 1 }), [payer()], { 'lease-1': openCharge }),
      suggestMatch(line({ payerName: 'Nobody' }), [], {}),
    ];
    for (const suggestion of cases) {
      expect(suggestion.confidence).toBeGreaterThanOrEqual(0);
      expect(suggestion.confidence).toBeLessThanOrEqual(1);
      expect(suggestion.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('rejects a negative date tolerance', () => {
    expect(() => suggestMatch(line(), [payer()], {}, -1)).toThrow(RangeError);
  });
});
