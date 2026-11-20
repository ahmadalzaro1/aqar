import { describe, expect, it } from 'vitest';
import {
  chargeAsBankLineInput, detectReupload, parseCsv, parseJodToFils, planDedupe,
  planMatch, remainingCharges, sumPlan,
} from './lib';
import type { ImportRecord } from './lib';
import type { Charge } from '@aqar/contracts';
import type { PayerProfile } from '@aqar/core';

const CSV = 'date,payer,amount,reference\n2026-11-01,Ahmad Ali,125.500,rent nov\n2026-11-02,"Sara, K",0.001,tip';

describe('parseJodToFils — integer fils, never floats', () => {
  it('converts exactly at 3 decimals', () => {
    expect(parseJodToFils('125.500')).toEqual({ ok: true, fils: 125500 });
    expect(parseJodToFils('0.001')).toEqual({ ok: true, fils: 1 });
    expect(parseJodToFils('1')).toEqual({ ok: true, fils: 1000 });
    expect(parseJodToFils(' 2.5 ')).toEqual({ ok: true, fils: 2500 });
    expect(parseJodToFils('1,000')).toEqual({ ok: true, fils: 1000000 });
  });
  it('rejects sub-fils precision, junk and non-positive amounts with codes', () => {
    expect(parseJodToFils('12.3456')).toEqual({ ok: false, code: 'amountScale' });
    expect(parseJodToFils('abc')).toEqual({ ok: false, code: 'amountFormat' });
    expect(parseJodToFils('0')).toEqual({ ok: false, code: 'amountNotPositive' });
    expect(parseJodToFils('-5')).toEqual({ ok: false, code: 'amountNotPositive' });
  });
});

describe('parseCsv', () => {
  it('parses quoted payers and keeps row numbers', () => {
    const r = parseCsv(CSV);
    expect(r.fatal).toBeNull();
    expect(r.issues).toHaveLength(0);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]?.amountFils).toBe(125500);
    expect(r.lines[1]?.payerName).toBe('Sara, K');
    expect(r.lines[1]?.rowNumber).toBe(3);
  });
  it('rejects a bad row with a reason and keeps the good rows', () => {
    const r = parseCsv('date,payer,amount\n2026-13-99,X,10\n2026-11-01,Y,10');
    expect(r.lines).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.rowNumber).toBe(2);
  });
  it('fatals on empty file and missing header', () => {
    expect(parseCsv('   ').fatal?.code).toBe('emptyFile');
    expect(parseCsv('a,b\n1,2').fatal?.code).toBe('missingHeader');
  });
});

describe('planDedupe — core is the authority', () => {
  const existing = [chargeAsBankLineInput({ rowNumber: 90, dateISO: '2026-11-01', payerName: 'Ahmad Ali', amountFils: 125500, reference: 'old' })];
  it('flags a line already stored for the org', () => {
    const rows = planDedupe(existing, parseCsv(CSV).lines);
    expect(rows[0]?.duplicateKind).toBe('existing');
    expect(rows[0]?.duplicateOf?.dateISO).toBe('2026-11-01');
    expect(rows[1]?.duplicateKind).toBeNull();
  });
  it('flags repeats inside one file', () => {
    const dup = 'date,payer,amount\n2026-11-05,Same,10\n2026-11-05,Same,10';
    const rows = planDedupe([], parseCsv(dup).lines);
    expect(rows[0]?.duplicateKind).toBeNull();
    expect(rows[1]?.duplicateKind).toBe('in_file');
  });
});

describe('detectReupload', () => {
  const record: ImportRecord = { id: 'i1', sourceHash: 'abc', fileName: 'f.csv', accountLabel: 'a', lineCount: 2, importedAtISO: '2026-11-01T00:00:00Z' };
  it('matches on the raw source hash', () => {
    expect(detectReupload([record], 'abc')?.id).toBe('i1');
    expect(detectReupload([record], 'xyz')).toBeNull();
  });
});

const charge = (id: string, amountFils: number, dueDateISO: string): Charge => ({
  id, leaseId: 'lease-1', period: '2026-11', kind: 'rent', amountFils, dueDateISO, proratedDays: null,
});
const payer: PayerProfile = { payerId: 'tenant-1', leaseId: 'lease-1', names: ['Ahmad Ali'], accounts: [], confirmed: true };

describe('planMatch — suggestion + oldest-first proposal + postable gate', () => {
  it('auto match with exact cover is postable', () => {
    const line = chargeAsBankLineInput({ rowNumber: 1, dateISO: '2026-11-01', payerName: 'Ahmad Ali', amountFils: 125500, reference: null });
    const plan = planMatch(line, [payer], { 'lease-1': [charge('c1', 125500, '2026-11-01')] });
    expect(plan.suggestion.kind).toBe('auto');
    expect(plan.postable).toBe(true);
    expect(sumPlan(plan.allocations)).toBe(125500);
    expect(plan.suggestion.reason.length).toBeGreaterThan(0);
  });
  it('partial payment proposes oldest-first and stays postable when it covers exactly', () => {
    const line = chargeAsBankLineInput({ rowNumber: 1, dateISO: '2026-11-01', payerName: 'Ahmad Ali', amountFils: 100000, reference: null });
    const plan = planMatch(line, [payer], { 'lease-1': [charge('c1', 60000, '2026-10-01'), charge('c2', 60000, '2026-11-01')] });
    expect(plan.suggestion.kind).toBe('partial');
    expect(plan.allocations[0]?.chargeId).toBe('c1');
    expect(plan.postable).toBe(true);
  });
  it('unknown payer is never postable', () => {
    const line = chargeAsBankLineInput({ rowNumber: 1, dateISO: '2026-11-01', payerName: 'Stranger', amountFils: 1000, reference: null });
    const plan = planMatch(line, [payer], { 'lease-1': [charge('c1', 1000, '2026-11-01')] });
    expect(plan.suggestion.kind).toBe('unknown_payer');
    expect(plan.postable).toBe(false);
  });
});

describe('remainingCharges', () => {
  it('drops settled rows and groups by lease', () => {
    const map = remainingCharges([
      { id: 'c1', leaseId: 'l1', period: '2026-11', kind: 'rent', dueDateISO: '2026-11-01', remainingFils: 500 },
      { id: 'c2', leaseId: 'l1', period: '2026-11', kind: 'rent', dueDateISO: '2026-11-01', remainingFils: 0 },
      { id: 'c3', leaseId: 'l2', period: '2026-11', kind: 'rent', dueDateISO: '2026-11-01', remainingFils: 700 },
    ]);
    expect(map['l1']).toHaveLength(1);
    expect(map['l2']).toHaveLength(1);
    expect(map['l1']?.[0]?.amountFils).toBe(500);
  });
});
