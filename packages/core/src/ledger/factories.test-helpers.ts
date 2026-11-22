// Test-only factories. Named *.test-helpers.ts so vitest does not collect it as a suite.
import type {
  Allocation,
  Charge,
  ChargeKind,
  IsoDate,
  JournalLine,
  LeaseMoneyTerms,
  Payment,
  PaymentMethod,
  Period,
} from '@aqar/contracts';

export interface ChargeInput {
  id?: string;
  leaseId?: string;
  period?: Period;
  kind?: ChargeKind;
  amountFils?: number;
  dueDateISO?: IsoDate;
  proratedDays?: number | null;
}

export function makeCharge(input: ChargeInput = {}): Charge {
  return {
    id: input.id ?? 'charge-1',
    leaseId: input.leaseId ?? 'lease-a',
    period: input.period ?? '2026-03',
    kind: input.kind ?? 'rent',
    amountFils: input.amountFils ?? 300000,
    dueDateISO: input.dueDateISO ?? '2026-03-05',
    proratedDays: input.proratedDays === undefined ? null : input.proratedDays,
  };
}

export interface LeaseInput {
  leaseId?: string;
  rentFils?: number;
  depositFils?: number;
  dueDay?: number;
  startISO?: IsoDate;
  endISO?: IsoDate;
  status?: LeaseMoneyTerms['status'];
}

export function makeLease(input: LeaseInput = {}): LeaseMoneyTerms {
  return {
    leaseId: input.leaseId ?? 'lease-a',
    rentFils: input.rentFils ?? 300000,
    depositFils: input.depositFils ?? 300000,
    dueDay: input.dueDay ?? 5,
    startISO: input.startISO ?? '2026-01-01',
    endISO: input.endISO ?? '2026-12-31',
    lateFeeRule: null,
    escalationRule: { kind: 'none' },
    status: input.status ?? 'active',
  };
}

export interface PaymentInput {
  id?: string;
  payerId?: string;
  amountFils?: number;
  receivedDateISO?: IsoDate;
  method?: PaymentMethod;
  referencePeriod?: Period | null;
  referenceText?: string | null;
}

export function makePayment(input: PaymentInput = {}): Payment {
  return {
    id: input.id ?? 'pay-1',
    payerId: input.payerId ?? 'tenant-1',
    amountFils: input.amountFils ?? 100000,
    receivedDateISO: input.receivedDateISO ?? '2026-03-10',
    method: input.method ?? 'cash',
    referencePeriod: input.referencePeriod === undefined ? null : input.referencePeriod,
    referenceText: input.referenceText === undefined ? null : input.referenceText,
    chequeStatus: null,
  };
}

export function makeAllocation(
  paymentId: string,
  chargeId: string,
  amountFils: number,
): Allocation {
  return { paymentId, chargeId, amountFils };
}

export interface JournalLineInput {
  accountCode?: JournalLine['accountCode'];
  debitFils?: number;
  creditFils?: number;
  memo?: string;
  sourceType?: string;
  sourceId?: string;
  period?: Period;
}

export function makeJournalLine(input: JournalLineInput = {}): JournalLine {
  return {
    accountCode: input.accountCode ?? 'tenant_ar',
    debitFils: input.debitFils ?? 0,
    creditFils: input.creditFils ?? 0,
    memo: input.memo ?? 'rent 2026-03',
    sourceType: input.sourceType ?? 'charge',
    sourceId: input.sourceId ?? 'charge-1',
    period: input.period ?? '2026-03',
  };
}
