import type { BankLine, Charge } from '@aqar/contracts';
import fc from 'fast-check';
import { dedupeBankLines, fingerprintBankLine, suggestMatch } from './bank.js';
import type { PayerProfile } from './bank.js';

/** Rewrites a name the way a different bank statement would (same real payer). */
function arabicVariant(text: string, seed: number): string {
  let out = '';
  let index = 0;
  for (const character of text) {
    index += 1;
    if (character === '\u0627') {
      const pick = (seed + index) % 3;
      out += pick === 0 ? '\u0623' : pick === 1 ? '\u0625' : '\u0622';
    } else if (character >= '0' && character <= '9') {
      out += String.fromCharCode(0x0660 + (character.charCodeAt(0) - 48));
    } else {
      out += character;
    }
    if ((seed + index) % 2 === 0) {
      out += '\u0640'; // tatweel
    }
    if ((seed + index) % 3 === 0) {
      out += '\u0651'; // shadda
    }
  }
  return out;
}

const isoDateArb = fc
  .tuple(
    fc.integer({ min: 2000, max: 2035 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([year, month, day]) => `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

const arabicNameArb = fc
  .tuple(
    fc.constantFrom('احمد علي', 'شركة الأمل', 'ادم', 'Ali Hassan', 'محمــد'),
    fc.integer({ min: 0, max: 999 }),
  )
  .map(([name, suffix]) => `${name} ${String(suffix)}`);

function bankLine(overrides: Partial<BankLine> = {}): BankLine {
  return {
    id: 'line-1',
    statementId: 'stmt-1',
    dateISO: '2026-01-05',
    amountFils: 100_000,
    payerName: 'احمد علي',
    payerAccount: null,
    reference: null,
    ...overrides,
  };
}

describe('fingerprintBankLine (properties)', () => {
  it('is stable and identical across Arabic spelling variants', () => {
    fc.assert(
      fc.property(isoDateArb, fc.nat({ max: 5_000_000 }), arabicNameArb, fc.integer({ min: 0, max: 50 }), (dateISO, amountFils, payerName, seed) => {
        const plain = bankLine({ dateISO, amountFils, payerName });
        const variant = bankLine({
          dateISO,
          amountFils,
          payerName: arabicVariant(payerName, seed),
          payerAccount: 'JO12 0001 2345',
          reference: '0000',
        });
        const fingerprints = fingerprintBankLine(plain);
        expect(fingerprints).toMatch(/^[0-9a-f]{8}$/);
        expect(fingerprintBankLine(plain)).toBe(fingerprints);
        expect(fingerprintBankLine(variant)).toBe(fingerprints);
      }),
      { numRuns: 1200 },
    );
  });

  it('is identical for null and empty optional fields', () => {
    fc.assert(
      fc.property(isoDateArb, fc.nat({ max: 5_000_000 }), arabicNameArb, (dateISO, amountFils, payerName) => {
        const withNulls = bankLine({ dateISO, amountFils, payerName, payerAccount: null, reference: null });
        const withEmpties = bankLine({ dateISO, amountFils, payerName, payerAccount: '', reference: '' });
        expect(fingerprintBankLine(withEmpties)).toBe(fingerprintBankLine(withNulls));
      }),
      { numRuns: 500 },
    );
  });
});

const namePool = ['احمد علي', 'شركة الأمل', 'Ali'];

const generatedLineArb = fc
  .tuple(
    fc.constantFrom(...namePool),
    fc.constantFrom('2026-01-05', '2026-01-06', '2026-02-01'),
    fc.constantFrom(1000, 2000, 3000),
  )
  .map(([payerName, dateISO, amountFils]) => bankLine({ payerName, dateISO, amountFils }));

function withIds(lines: readonly BankLine[], prefix: string): BankLine[] {
  return lines.map((line, index) => ({ ...line, id: `${prefix}-${String(index)}` }));
}

describe('dedupeBankLines (properties)', () => {
  it('never re-adds a fingerprint and is idempotent', () => {
    fc.assert(
      fc.property(
        fc.array(generatedLineArb, { maxLength: 4 }),
        fc.array(generatedLineArb, { maxLength: 5 }),
        (existingPool, incomingPool) => {
          const existing = withIds(existingPool, 'existing');
          const incoming = withIds(incomingPool, 'incoming');
          const fresh = dedupeBankLines(existing, incoming);

          const seen = new Set(existing.map(fingerprintBankLine));
          for (const line of fresh) {
            const fingerprint = fingerprintBankLine(line);
            expect(seen.has(fingerprint)).toBe(false);
            seen.add(fingerprint);
          }
          expect(dedupeBankLines([...existing, ...fresh], fresh)).toEqual([]);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('suggestMatch (properties)', () => {
  const payer: PayerProfile = {
    payerId: 'payer-1',
    leaseId: 'lease-1',
    names: ['احمد علي'],
    accounts: [],
    confirmed: true,
  };

  const chargeArb: fc.Arbitrary<Charge> = fc
    .tuple(fc.integer({ min: 0, max: 500_000 }), fc.constantFrom('2026-01-05', '2026-02-05'))
    .map(([amountFils, dueDateISO], index) => ({
      id: `charge-${String(index)}`,
      leaseId: 'lease-1',
      period: dueDateISO.slice(0, 7),
      kind: 'rent' as const,
      amountFils,
      dueDateISO,
      proratedDays: null,
    }));

  it('always explains itself and preserves the bank amount', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 2_000_000 }),
        fc.array(chargeArb, { maxLength: 3 }),
        fc.constantFrom('احمد علي', 'أحمد علي', 'Unknown Person'),
        (amountFils, charges, payerName) => {
          const suggestion = suggestMatch(bankLine({ amountFils, payerName }), [payer], {
            'lease-1': charges,
          });
          expect(suggestion.amountFils).toBe(amountFils);
          expect(suggestion.reason.trim().length).toBeGreaterThan(0);
          expect(suggestion.confidence).toBeGreaterThanOrEqual(0);
          expect(suggestion.confidence).toBeLessThanOrEqual(1);
          expect(['auto', 'review', 'ambiguous', 'unknown_payer', 'partial']).toContain(
            suggestion.kind,
          );
          for (const leaseId of suggestion.leaseIds) {
            expect(leaseId).toBe('lease-1');
          }
          if (suggestion.kind === 'unknown_payer') {
            expect(suggestion.payerId).toBeNull();
            expect(suggestion.leaseIds).toEqual([]);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
