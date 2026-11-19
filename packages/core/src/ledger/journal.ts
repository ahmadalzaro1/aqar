// Double-entry journal: posting rules, reversals, and per-account nets.
import type { AccountCode, JournalLine, Period } from '@aqar/contracts';
import { sumFils } from './fils.js';

function isBalancedSide(line: JournalLine): boolean {
  const hasDebit = line.debitFils > 0;
  const hasCredit = line.creditFils > 0;
  return hasDebit !== hasCredit;
}

/**
 * Validates and copies a journal batch. Errors carry machine-greppable tokens:
 * 'unbalanced', 'one-sided', 'period locked'.
 */
export function postJournal(lines: readonly JournalLine[], lockedPeriods: readonly Period[]): JournalLine[] {
  if (lines.length < 2) {
    throw new Error(`unbalanced: a journal entry needs at least 2 lines, got ${lines.length}`);
  }
  for (const line of lines) {
    if (!isBalancedSide(line)) {
      throw new Error(
        `one-sided: line on ${line.accountCode} (${line.sourceType}/${line.sourceId}) must have exactly one of debitFils/creditFils positive`,
      );
    }
  }
  const locked = new Set<string>(lockedPeriods);
  for (const line of lines) {
    if (locked.has(line.period)) {
      throw new Error(`period locked: cannot post to ${line.period} (${line.sourceType}/${line.sourceId})`);
    }
  }
  const debits = sumFils(lines.map((line) => line.debitFils));
  const credits = sumFils(lines.map((line) => line.creditFils));
  if (debits !== credits) {
    throw new Error(`unbalanced: debits ${debits} fils != credits ${credits} fils`);
  }
  return lines.map((line) => ({ ...line }));
}

/** Swaps debit/credit on every line, marks the memo as a reversal, keeps refs + period. */
export function reverseJournalLines(lines: readonly JournalLine[]): JournalLine[] {
  return lines.map((line) => ({
    ...line,
    debitFils: line.creditFils,
    creditFils: line.debitFils,
    memo: `reversal: ${line.memo}`,
  }));
}

/** Net debit (debits minus credits) per account; negative means a net credit balance. */
export function balanceByAccount(lines: readonly JournalLine[]): Partial<Record<AccountCode, number>> {
  const balances: Partial<Record<AccountCode, number>> = {};
  for (const line of lines) {
    const current = balances[line.accountCode] ?? 0;
    balances[line.accountCode] = current + line.debitFils - line.creditFils;
  }
  return balances;
}

export function assertPeriodOpen(period: Period, lockedPeriods: readonly Period[]): void {
  for (const locked of lockedPeriods) {
    if (locked === period) throw new Error(`period locked: ${period}`);
  }
}
