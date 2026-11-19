import * as fc from 'fast-check';
import type { IsoDate } from '@aqar/contracts';
import {
  allocatePayment,
  agingReport,
  assertFils,
  computeLateFee,
  formatFils,
  generateMonthlyCharges,
  mulDivFloor,
  sumFils,
  toDayNumber,
  toFils,
  fromDayNumber,
} from './index.js';
import { makeCharge, makeLease, makePayment } from './factories.test-helpers.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

describe('money properties', () => {
  it('formatFils/toFils round-trip for every nonnegative safe integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_SAFE }), (fils) => {
        const text = formatFils(fils);
        expect(text).toMatch(/^\d+\.\d{3}$/);
        expect(toFils(text)).toBe(fils);
        expect(Number.isInteger(toFils(text))).toBe(true);
      }),
    );
  });

  it('parses any whole/fraction JOD pair exactly, without float drift', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9_000_000_000 }),
        fc.integer({ min: 0, max: 999 }),
        (wholeJod, fractionFils) => {
          const text = `${wholeJod}.${String(fractionFils).padStart(3, '0')}`;
          const fils = toFils(text);
          expect(fils).toBe(wholeJod * 1000 + fractionFils);
          expect(formatFils(fils)).toBe(text);
        },
      ),
    );
  });

  it('assertFils accepts exactly the integer fils domain', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, min: -1e9, max: 1e9 }), (value) => {
        const shouldAccept = Number.isSafeInteger(value) && value >= 0;
        if (shouldAccept) expect(assertFils(value)).toBe(value);
        else expect(() => assertFils(value)).toThrow();
      }),
    );
  });

  it('mulDivFloor stays inside the exact rational bounds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (a, b, divisor) => {
          const result = mulDivFloor(a, b, divisor);
          expect(Number.isInteger(result)).toBe(true);
          const product = BigInt(a) * BigInt(b);
          const step = BigInt(divisor);
          expect(BigInt(result) * step <= product).toBe(true);
          expect(product < (BigInt(result) + 1n) * step).toBe(true);
        },
      ),
    );
  });

  it('sumFils never loses a fils', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 50 }), (values) => {
        const total = sumFils(values);
        expect(Number.isInteger(total)).toBe(true);
        expect(total).toBe(values.reduce((sum, value) => sum + value, 0));
      }),
    );
  });
});
