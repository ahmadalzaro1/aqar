import type { AccountCode, JournalLine } from '@aqar/contracts';
import { assertPeriodOpen, balanceByAccount, postJournal, reverseJournalLines } from './index.js';
import { makeJournalLine } from './factories.test-helpers.js';

const debitLine = makeJournalLine({
  accountCode: 'tenant_ar',
  debitFils: 125000,
  memo: 'rent charge',
  sourceId: 'c1',
});
const creditLine = makeJournalLine({
  accountCode: 'income',
  creditFils: 125000,
  memo: 'rent charge',
  sourceId: 'c1',
});
const rentEntry: JournalLine[] = [debitLine, creditLine];

describe('postJournal', () => {
  it('accepts a balanced entry and returns a copy', () => {
    const posted = postJournal(rentEntry, []);
    expect(posted).toEqual(rentEntry);
    expect(posted).not.toBe(rentEntry);
    expect(posted[0]).not.toBe(rentEntry[0]);
  });

  it('does not mutate its input', () => {
    const lines = rentEntry.map((line) => ({ ...line }));
    postJournal(lines, []);
    expect(lines).toEqual(rentEntry);
  });

  it('rejects a journal whose debits and credits differ', () => {
    const lines = [
      makeJournalLine({ accountCode: 'tenant_ar', debitFils: 125000 }),
      makeJournalLine({ accountCode: 'income', creditFils: 124999 }),
    ];
    expect(() => postJournal(lines, [])).toThrow(/unbalanced/);
  });

  it('rejects a single-line (or empty) journal', () => {
    expect(() => postJournal([debitLine], [])).toThrow(/unbalanced/);
    expect(() => postJournal([], [])).toThrow(/unbalanced/);
  });

  it('rejects a line with neither side positive', () => {
    const lines = [
      makeJournalLine({ accountCode: 'tenant_ar', debitFils: 0, creditFils: 0 }),
      makeJournalLine({ accountCode: 'income', creditFils: 1000 }),
    ];
    expect(() => postJournal(lines, [])).toThrow(/one-sided/);
  });

  it('rejects a line with both sides positive', () => {
    const lines = [
      makeJournalLine({ accountCode: 'tenant_ar', debitFils: 1000, creditFils: 1000 }),
      makeJournalLine({ accountCode: 'income', creditFils: 1000 }),
    ];
    expect(() => postJournal(lines, [])).toThrow(/one-sided/);
  });

  it('refuses to post into a locked period', () => {
    expect(() => postJournal(rentEntry, ['2026-03'])).toThrow(/period locked/);
    expect(() => postJournal(rentEntry, ['2026-02'])).not.toThrow();
  });

  it('accepts a multi-line entry that nets to zero', () => {
    const lines = [
      makeJournalLine({ accountCode: 'operating_cash', debitFils: 40000 }),
      makeJournalLine({ accountCode: 'tenant_ar', creditFils: 40000 }),
      makeJournalLine({ accountCode: 'trust_cash', debitFils: 85000 }),
      makeJournalLine({ accountCode: 'income', creditFils: 85000 }),
    ];
    expect(postJournal(lines, [])).toHaveLength(4);
  });
});

describe('reverseJournalLines', () => {
  it('swaps debit and credit, prefixes the memo, keeps refs and period', () => {
    const reversed = reverseJournalLines([debitLine, creditLine]);
    expect(reversed[0]).toEqual({
      ...debitLine,
      debitFils: 0,
      creditFils: 125000,
      memo: 'reversal: rent charge',
    });
    expect(reversed[1]).toEqual({
      ...creditLine,
      debitFils: 125000,
      creditFils: 0,
      memo: 'reversal: rent charge',
    });
    expect(reversed[0]?.period).toBe('2026-03');
    expect(reversed[0]?.sourceType).toBe('charge');
    expect(reversed[0]?.sourceId).toBe('c1');
  });

  it('still balances after reversal, and reversing twice restores the direction', () => {
    const reversed = reverseJournalLines(rentEntry);
    expect(() => postJournal(reversed, [])).not.toThrow();
    const back = reverseJournalLines(reversed);
    expect(back.map((line) => [line.debitFils, line.creditFils])).toEqual(
      rentEntry.map((line) => [line.debitFils, line.creditFils]),
    );
  });

  it('does not mutate its input', () => {
    const snapshot = rentEntry.map((line) => ({ ...line }));
    reverseJournalLines(rentEntry);
    expect(rentEntry).toEqual(snapshot);
  });
});

describe('balanceByAccount', () => {
  it('reports net debits per account, negative for net credits', () => {
    expect(balanceByAccount(rentEntry)).toEqual({ tenant_ar: 125000, income: -125000 });
  });

  it('nets repeated lines on the same account', () => {
    const lines = [
      makeJournalLine({ accountCode: 'tenant_ar', debitFils: 1000 }),
      makeJournalLine({ accountCode: 'tenant_ar', creditFils: 300 }),
      makeJournalLine({ accountCode: 'income', creditFils: 700 }),
    ];
    const balances = balanceByAccount(lines);
    expect(balances.tenant_ar).toBe(700);
    expect(balances.income).toBe(-700);
  });

  it('zeroes out when a journal is reversed', () => {
    const combined = [...rentEntry, ...reverseJournalLines(rentEntry)];
    const balances = balanceByAccount(combined);
    const codes = Object.keys(balances) as AccountCode[];
    expect(codes.sort()).toEqual(['income', 'tenant_ar']);
    for (const code of codes) expect(balances[code]).toBe(0);
  });

  it('returns an empty record for no lines', () => {
    expect(balanceByAccount([])).toEqual({});
  });
});

describe('assertPeriodOpen', () => {
  it('throws only for a locked period', () => {
    expect(() => assertPeriodOpen('2026-03', ['2026-03'])).toThrow(/period locked/);
    expect(() => assertPeriodOpen('2026-04', ['2026-03'])).not.toThrow();
    expect(() => assertPeriodOpen('2026-04', [])).not.toThrow();
  });
});
