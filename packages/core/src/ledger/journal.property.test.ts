import * as fc from 'fast-check';
import { accountCodeSchema } from '@aqar/contracts';
import type { AccountCode, JournalLine, Period } from '@aqar/contracts';
import { balanceByAccount, postJournal, reverseJournalLines } from './index.js';
import { makeJournalLine } from './factories.test-helpers.js';

const ACCOUNT_CODES: readonly AccountCode[] = accountCodeSchema.options;
const accountArb = fc.constantFrom<AccountCode>(...ACCOUNT_CODES);
const periodArb = fc.constantFrom<Period>('2026-03', '2026-04', '2026-05');

interface RawLine {
  accountCode: AccountCode;
  debitFils: number;
  creditFils: number;
  period: Period;
}

const rawLineArb: fc.Arbitrary<RawLine> = fc.record({
  accountCode: accountArb,
  debitFils: fc.integer({ min: 0, max: 100_000 }),
  creditFils: fc.integer({ min: 0, max: 100_000 }),
  period: periodArb,
});

function toLines(raw: readonly RawLine[]): JournalLine[] {
  return raw.map((line, index) =>
    makeJournalLine({
      accountCode: line.accountCode,
      debitFils: line.debitFils,
      creditFils: line.creditFils,
      period: line.period,
      memo: `entry-${index}`,
      sourceId: `src-${index}`,
    }),
  );
}

describe('postJournal properties', () => {
  it('either balances or throws a tagged error', () => {
    fc.assert(
      fc.property(
        fc.array(rawLineArb, { maxLength: 8 }),
        fc.array(periodArb, { maxLength: 2 }),
        (raw, locked) => {
          const lines = toLines(raw);
          let posted: JournalLine[] | undefined;
          try {
            posted = postJournal(lines, locked);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toMatch(/unbalanced|one-sided|period locked/);
            return;
          }
          const debits = posted.reduce((sum, line) => sum + line.debitFils, 0);
          const credits = posted.reduce((sum, line) => sum + line.creditFils, 0);
          expect(debits).toBe(credits);
          expect(posted).toHaveLength(lines.length);
          expect(posted).toEqual(lines);
          expect(posted).not.toBe(lines);
          posted.forEach((line, index) => expect(line).not.toBe(lines[index]));
        },
      ),
    );
  });

  it('rejects every journal that is not strictly balanced', () => {
    fc.assert(
      fc.property(rawLineArb, rawLineArb, (a, b) => {
        const lines = toLines([a, b]);
        const debits = a.debitFils + b.debitFils;
        const credits = a.creditFils + b.creditFils;
        const everyLineSingleSided = [a, b].every((line) => (line.debitFils > 0) !== (line.creditFils > 0));
        if (!everyLineSingleSided) {
          expect(() => postJournal(lines, [])).toThrow(/one-sided/);
          return;
        }
        if (debits === credits) expect(() => postJournal(lines, [])).not.toThrow();
        else expect(() => postJournal(lines, [])).toThrow(/unbalanced/);
      }),
    );
  });
});

describe('reversal properties', () => {
  it('restores exact prior per-account balances when the latest journal is reversed', () => {
    const pairsArb = fc.array(
      fc.record({
        debitAccount: accountArb,
        creditAccount: accountArb,
        amountFils: fc.integer({ min: 1, max: 1_000_000 }),
        period: periodArb,
      }),
      { minLength: 1, maxLength: 5 },
    );

    fc.assert(
      fc.property(pairsArb, pairsArb, (firstPairs, secondPairs) => {
        const build = (pairs: typeof firstPairs, tag: string): JournalLine[] => {
          const lines: JournalLine[] = [];
          pairs.forEach((pair, index) => {
            lines.push(
              makeJournalLine({
                accountCode: pair.debitAccount,
                debitFils: pair.amountFils,
                period: pair.period,
                sourceId: `${tag}-${index}`,
                memo: `${tag}-${index}`,
              }),
              makeJournalLine({
                accountCode: pair.creditAccount,
                creditFils: pair.amountFils,
                period: pair.period,
                sourceId: `${tag}-${index}`,
                memo: `${tag}-${index}`,
              }),
            );
          });
          return lines;
        };

        const first = postJournal(build(firstPairs, 'a'), []);
        const second = postJournal(build(secondPairs, 'b'), []);
        const reversal = reverseJournalLines(second);

        const afterFirst = balanceByAccount(first);
        const afterReversal = balanceByAccount([...first, ...second, ...reversal]);

        for (const code of ACCOUNT_CODES) {
          // the second journal did change things, and its reversal undoes exactly that change
          expect(afterReversal[code] ?? 0).toBe(afterFirst[code] ?? 0);
        }
        // a reversal of a single journal nets every touched account back to zero
        const alone = balanceByAccount([...first, ...reverseJournalLines(first)]);
        for (const code of Object.keys(afterFirst) as AccountCode[]) {
          expect(alone[code] ?? 0).toBe(0);
        }
        expect(() => postJournal(reversal, [])).not.toThrow();
        for (const line of reversal) expect(line.memo.startsWith('reversal: ')).toBe(true);
      }),
    );
  });

  it('never mutates the lines it reverses', () => {
    fc.assert(
      fc.property(fc.array(rawLineArb, { maxLength: 6 }), (raw) => {
        const lines = toLines(raw);
        const snapshot = lines.map((line) => ({ ...line }));
        reverseJournalLines(lines);
        expect(lines).toEqual(snapshot);
      }),
    );
  });
});
