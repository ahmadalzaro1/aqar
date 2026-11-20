// Pure (no I/O, no clock, no DB) parsing + preview planning for the bank
// import wizard. Server actions and the client both import this module, so it
// must stay free of node-only imports: the sha256 source hash lives in
// `./data`, which is server-only.
//
// MONEY: a CSV amount is parsed from its decimal string straight to integer
// fils with BigInt arithmetic. parseFloat is never used on money.
import type { BankLine, Charge, MatchSuggestion } from '@aqar/contracts';
import {
  dedupeBankLines,
  fingerprintBankLine,
  proposeOldestFirstAllocation,
  suggestMatch,
  type ChargesByLease,
  type PayerProfile,
} from '@aqar/core';

export type ParseIssueCode =
  | 'columnCount'
  | 'malformedRow'
  | 'badDate'
  | 'emptyPayer'
  | 'amountFormat'
  | 'amountScale'
  | 'amountNotPositive';

export interface ParseIssue {
  readonly rowNumber: number;
  readonly code: ParseIssueCode;
  readonly field: 'date' | 'payer' | 'amount' | 'row';
  readonly value: string;
}

export interface FatalIssue {
  readonly code: 'emptyFile' | 'missingHeader';
  readonly value: string;
}

export interface ParsedLine {
  readonly rowNumber: number;
  readonly dateISO: string;
  readonly payerName: string;
  readonly amountFils: number;
  readonly reference: string | null;
}

export interface CsvParseResult {
  readonly header: readonly string[];
  readonly lines: readonly ParsedLine[];
  readonly issues: readonly ParseIssue[];
  readonly fatal: FatalIssue | null;
}

export type FilsParse =
  | { readonly ok: true; readonly fils: number }
  | { readonly ok: false; readonly code: 'amountFormat' | 'amountScale' | 'amountNotPositive' };

const JOD_DECIMALS = 3;
const FILS_PER_JOD = 1000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * '125.500' -> 125500, '0.001' -> 1, '1,250.5' -> 1250500.
 * More than three decimals is rejected (never rounded: rounding a statement
 * amount would silently change the ledger).
 */
export function parseJodToFils(raw: string): FilsParse {
  const trimmed = raw.replace(/[\s\u00a0]/g, '');
  if (trimmed.length === 0) return { ok: false, code: 'amountFormat' };
  let value = trimmed;
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) {
    value = value.replace(/,/g, '');
  }
  if (value.includes(',')) return { ok: false, code: 'amountFormat' };
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return { ok: false, code: 'amountFormat' };
  const sign = match[1] ?? '';
  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';
  if (fraction.length > JOD_DECIMALS) return { ok: false, code: 'amountScale' };
  const padded = fraction.padEnd(JOD_DECIMALS, '0');
  const fils = BigInt(whole) * FILS_PER_JOD + BigInt(padded.length === 0 ? '0' : padded);
  if (fils > MAX_SAFE) return { ok: false, code: 'amountFormat' };
  const result = Number(fils);
  if (sign === '-' || result <= 0) return { ok: false, code: 'amountNotPositive' };
  return { ok: true, fils: result };
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Minimal RFC-4180-style splitter: quoted fields, "" escapes, embedded commas. */
function splitCsvRow(row: string): string[] | null {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < row.length; index += 1) {
    const ch = row.charAt(index);
    if (inQuotes) {
      if (ch === '"') {
        if (row.charAt(index + 1) === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (current.trim().length === 0) {
        current = '';
        inQuotes = true;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === ',') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (inQuotes) return null;
  cells.push(current);
  return cells;
}

interface ColumnMap {
  readonly date: number;
  readonly payer: number;
  readonly amount: number;
  readonly reference: number;
}

function readColumns(header: readonly string[]): ColumnMap | null {
  const index = new Map<string, number>();
  header.forEach((cell, position) => {
    const key = cell.trim().toLowerCase();
    if (key.length > 0 && !index.has(key)) index.set(key, position);
  });
  const date = index.get('date');
  const payer = index.get('payer');
  const amount = index.get('amount');
  if (date === undefined || payer === undefined || amount === undefined) return null;
  return { date, payer, amount, reference: index.get('reference') ?? -1 };
}

/**
 * Parses the wizard's CSV. Every rejected row is reported with its own reason
 * and physical line number; nothing is silently dropped.
 */
export function parseCsv(text: string): CsvParseResult {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rawRows = normalized.split('\n');
  const rows = rawRows
    .map((row, index) => ({ row, rowNumber: index + 1 }))
    .filter((entry) => entry.row.trim().length > 0);
  if (rows.length === 0) {
    return { header: [], lines: [], issues: [], fatal: { code: 'emptyFile', value: '' } };
  }
  const headerRow = rows[0];
  if (headerRow === undefined) {
    return { header: [], lines: [], issues: [], fatal: { code: 'emptyFile', value: '' } };
  }
  const headerCells = splitCsvRow(headerRow.row) ?? [];
  const header = headerCells.map((cell) => cell.trim().toLowerCase());
  const columns = readColumns(header);
  if (columns === null) {
    const required = ['date', 'payer', 'amount'];
    const missing = required.filter((name) => !header.includes(name));
    return {
      header,
      lines: [],
      issues: [],
      fatal: { code: 'missingHeader', value: missing.join(', ') },
    };
  }
  const requiredWidth = Math.max(columns.date, columns.payer, columns.amount) + 1;

  const lines: ParsedLine[] = [];
  const issues: ParseIssue[] = [];
  for (const entry of rows.slice(1)) {
    const cells = splitCsvRow(entry.row);
    if (cells === null) {
      issues.push({ rowNumber: entry.rowNumber, code: 'malformedRow', field: 'row', value: entry.row });
      continue;
    }
    if (cells.length < requiredWidth) {
      issues.push({
        rowNumber: entry.rowNumber,
        code: 'columnCount',
        field: 'row',
        value: String(cells.length),
      });
      continue;
    }
    const rawDate = (cells[columns.date] ?? '').trim();
    const rawPayer = (cells[columns.payer] ?? '').trim();
    const rawAmount = (cells[columns.amount] ?? '').trim();
    const rawReference = columns.reference >= 0 ? (cells[columns.reference] ?? '').trim() : '';

    let rowFailed = false;
    if (!isValidIsoDate(rawDate)) {
      issues.push({ rowNumber: entry.rowNumber, code: 'badDate', field: 'date', value: rawDate });
      rowFailed = true;
    }
    if (rawPayer.length === 0) {
      issues.push({ rowNumber: entry.rowNumber, code: 'emptyPayer', field: 'payer', value: '' });
      rowFailed = true;
    }
    const amount = parseJodToFils(rawAmount);
    if (!amount.ok) {
      issues.push({ rowNumber: entry.rowNumber, code: amount.code, field: 'amount', value: rawAmount });
      rowFailed = true;
    }
    if (rowFailed || !amount.ok) continue;
    lines.push({
      rowNumber: entry.rowNumber,
      dateISO: rawDate,
      payerName: rawPayer,
      amountFils: amount.fils,
      reference: rawReference.length === 0 ? null : rawReference,
    });
  }
  return { header, lines, issues, fatal: null };
}

export interface DedupeRow {
  readonly line: BankLine;
  readonly fingerprint: string;
  readonly duplicateKind: 'existing' | 'in_file' | null;
  readonly duplicateOf: BankLine | null;
}

function pendingId(rowNumber: number): string {
  return `pending:${String(rowNumber)}`;
}

/**
 * Fingerprints every parsed line and classifies it against the organization's
 * stored bank lines using @aqar/core. `dedupeBankLines` is the authority on
 * what counts as fresh; the fingerprint map only explains *why*.
 */
export function planDedupe(
  existing: readonly BankLine[],
  incoming: readonly ParsedLine[],
): DedupeRow[] {
  const pending: BankLine[] = incoming.map((line) => ({
    id: pendingId(line.rowNumber),
    statementId: 'pending',
    dateISO: line.dateISO,
    amountFils: line.amountFils,
    payerName: line.payerName,
    payerAccount: null,
    reference: line.reference,
  }));
  const freshIds = new Set(dedupeBankLines(existing, pending).map((line) => line.id));

  const existingByFingerprint = new Map<string, BankLine>();
  for (const line of existing) {
    const fingerprint = fingerprintBankLine(line);
    if (!existingByFingerprint.has(fingerprint)) existingByFingerprint.set(fingerprint, line);
  }

  const seenInFile = new Set<string>();
  return pending.map((line) => {
    const fingerprint = fingerprintBankLine(line);
    const stored = existingByFingerprint.get(fingerprint);
    let duplicateKind: 'existing' | 'in_file' | null = null;
    let duplicateOf: BankLine | null = null;
    if (stored !== undefined) {
      duplicateKind = 'existing';
      duplicateOf = stored;
    } else if (seenInFile.has(fingerprint)) {
      duplicateKind = 'in_file';
    } else if (!freshIds.has(line.id)) {
      // Defensive: core reported it as a duplicate but no stored line matched,
      // so it must have collided with an earlier row of this same file.
      duplicateKind = 'in_file';
    }
    seenInFile.add(fingerprint);
    return { line, fingerprint, duplicateKind, duplicateOf };
  });
}

export interface PlanEntry {
  readonly chargeId: string;
  readonly amountFils: number;
}

export interface MatchPlan {
  readonly suggestion: MatchSuggestion;
  readonly allocations: readonly PlanEntry[];
  readonly postable: boolean;
}

export function sumPlan(plan: readonly PlanEntry[]): number {
  return plan.reduce((total, entry) => total + entry.amountFils, 0);
}

/**
 * Runs the core matcher, then the core oldest-first allocation for the single
 * lease the matcher identified. A plan is postable only when the deterministic
 * allocation covers the payment exactly; anything else stays a suggestion for
 * a human.
 */
export function planMatch(
  line: BankLine,
  payers: readonly PayerProfile[],
  chargesByLease: ChargesByLease,
): MatchPlan {
  const suggestion = suggestMatch(line, payers, chargesByLease);
  const leaseId = suggestion.leaseIds.length === 1 ? suggestion.leaseIds[0] : undefined;
  if (leaseId === undefined) {
    return { suggestion, allocations: [], postable: false };
  }
  const allocations = proposeOldestFirstAllocation(
    chargesByLease[leaseId] ?? [],
    suggestion.amountFils,
  );
  const postable =
    (suggestion.kind === 'auto' || suggestion.kind === 'partial') &&
    allocations.length > 0 &&
    sumPlan(allocations) === suggestion.amountFils;
  return { suggestion, allocations, postable };
}

export interface ImportRecord {
  readonly id: string;
  readonly sourceHash: string;
  readonly fileName: string;
  readonly accountLabel: string;
  readonly lineCount: number;
  readonly importedAtISO: string;
}

/** Re-upload detection: the raw file hash is unique per organization. */
export function detectReupload(
  recordedImports: readonly ImportRecord[],
  sourceHash: string,
): ImportRecord | null {
  return recordedImports.find((record) => record.sourceHash === sourceHash) ?? null;
}

export interface PreviewRow {
  readonly rowNumber: number;
  readonly dateISO: string;
  readonly payerName: string;
  readonly amountFils: number;
  readonly reference: string | null;
  readonly fingerprint: string;
  readonly duplicateKind: 'existing' | 'in_file' | null;
  readonly duplicateOfDateISO: string | null;
  readonly suggestion: MatchSuggestion | null;
  readonly allocations: readonly PlanEntry[];
  readonly postable: boolean;
}

export interface AnalyzeResult {
  readonly status: 'ready' | 'reupload' | 'invalid' | 'unauthorized';
  readonly sourceHash: string;
  readonly totalLines: number;
  readonly newLines: number;
  readonly duplicateLines: number;
  readonly issues: readonly ParseIssue[];
  readonly fatal: FatalIssue | null;
  readonly existingImport: ImportRecord | null;
  readonly rows: readonly PreviewRow[];
}

export interface ConfirmResult {
  readonly status: 'imported' | 'already_imported' | 'invalid' | 'unauthorized';
  readonly importId: string | null;
  readonly insertedLines: number;
  readonly duplicateLines: number;
  readonly suggestions: number;
  readonly payments: number;
  readonly allocations: number;
  readonly issues: readonly ParseIssue[];
}

export interface ParseSettings {
  readonly dateToleranceDays: number;
}

export const DEFAULT_PARSE_SETTINGS: ParseSettings = { dateToleranceDays: 5 };

export function chargeAsBankLineInput(line: ParsedLine): BankLine {
  return {
    id: pendingId(line.rowNumber),
    statementId: 'pending',
    dateISO: line.dateISO,
    amountFils: line.amountFils,
    payerName: line.payerName,
    payerAccount: null,
    reference: line.reference,
  };
}

export function remainingCharges(
  rows: readonly { id: string; leaseId: string; period: string; kind: string; dueDateISO: string; remainingFils: number }[],
): ChargesByLease {
  const byLease: Record<string, Charge[]> = {};
  for (const row of rows) {
    if (row.remainingFils <= 0) continue;
    const charge: Charge = {
      id: row.id,
      leaseId: row.leaseId,
      period: row.period,
      kind: row.kind as Charge['kind'],
      amountFils: row.remainingFils,
      dueDateISO: row.dueDateISO,
      proratedDays: null,
    };
    const bucket = byLease[row.leaseId];
    if (bucket === undefined) {
      byLease[row.leaseId] = [charge];
    } else {
      bucket.push(charge);
    }
  }
  return byLease;
}
