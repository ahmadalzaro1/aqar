import { z } from 'zod';

/** JOD has 3 decimals. ALL money is integer fils (1 JOD = 1000 fils). Never floats. */
export const filsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type Fils = z.infer<typeof filsSchema>;

/** ISO calendar date, YYYY-MM-DD. Core never reads the wall clock; dates are inputs. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type IsoDate = z.infer<typeof isoDateSchema>;

/** Billing period, YYYY-MM. */
export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export type Period = z.infer<typeof periodSchema>;

export const chargeKindSchema = z.enum(['rent', 'late_fee', 'service', 'deposit', 'other']);
export type ChargeKind = z.infer<typeof chargeKindSchema>;

/** Derived from money, NEVER stored as a manually-set field. */
export const chargeStatusSchema = z.enum(['open', 'partial', 'paid', 'overdue']);
export type ChargeStatus = z.infer<typeof chargeStatusSchema>;

export const paymentMethodSchema = z.enum(['cash', 'cliq', 'bank_transfer', 'cheque']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const chequeStatusSchema = z.enum(['received', 'deposited', 'cleared', 'bounced']);
export type ChequeStatus = z.infer<typeof chequeStatusSchema>;

export const lateFeeRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flat'),
    amountFils: filsSchema,
    graceDays: z.number().int().nonnegative(),
    capFils: filsSchema.nullable(),
  }),
  z.object({
    kind: z.literal('percent'),
    /** basis points of the outstanding charge amount; 500 = 5% */
    basisPoints: z.number().int().nonnegative().max(10000),
    graceDays: z.number().int().nonnegative(),
    capFils: filsSchema.nullable(),
  }),
]);
export type LateFeeRule = z.infer<typeof lateFeeRuleSchema>;

export const escalationRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('percent'),
    basisPoints: z.number().int().nonnegative().max(10000),
    everyMonths: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('flat'),
    amountFils: filsSchema,
    everyMonths: z.number().int().positive(),
  }),
]);
export type EscalationRule = z.infer<typeof escalationRuleSchema>;

/** Money terms of a lease, as consumed by pure charge/proration math. */
export const leaseMoneyTermsSchema = z.object({
  leaseId: z.string().min(1),
  rentFils: filsSchema,
  depositFils: filsSchema,
  /** day of month rent is due, 1..28 to avoid month-length edge cases */
  dueDay: z.number().int().min(1).max(28),
  startISO: isoDateSchema,
  endISO: isoDateSchema,
  lateFeeRule: lateFeeRuleSchema.nullable(),
  escalationRule: escalationRuleSchema,
  status: z.enum(['upcoming', 'active', 'ended', 'cancelled']),
});
export type LeaseMoneyTerms = z.infer<typeof leaseMoneyTermsSchema>;

export const chargeSchema = z.object({
  id: z.string().min(1),
  leaseId: z.string().min(1),
  period: periodSchema,
  kind: chargeKindSchema,
  amountFils: filsSchema,
  dueDateISO: isoDateSchema,
  /** set for prorated first/last periods; informational */
  proratedDays: z.number().int().nonnegative().nullable(),
});
export type Charge = z.infer<typeof chargeSchema>;

export const paymentSchema = z.object({
  id: z.string().min(1),
  payerId: z.string().min(1),
  amountFils: filsSchema,
  receivedDateISO: isoDateSchema,
  method: paymentMethodSchema,
  /** trusted period hint ONLY when a human confirmed it; junk references never drive matching */
  referencePeriod: periodSchema.nullable(),
  referenceText: z.string().nullable(),
  chequeStatus: chequeStatusSchema.nullable(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const allocationSchema = z.object({
  paymentId: z.string().min(1),
  chargeId: z.string().min(1),
  amountFils: filsSchema.positive(),
});
export type Allocation = z.infer<typeof allocationSchema>;

export const accountCodeSchema = z.enum([
  'tenant_ar',
  'trust_cash',
  'operating_cash',
  'deposit_liability',
  'owner_payable',
  'expense',
  'income',
  'late_fee_income',
  'service_income',
  'cheques_in_transit',
  'suspense',
]);
export type AccountCode = z.infer<typeof accountCodeSchema>;

/** Exactly one of debitFils/creditFils is positive; the other is zero. */
export const journalLineSchema = z.object({
  accountCode: accountCodeSchema,
  debitFils: filsSchema,
  creditFils: filsSchema,
  memo: z.string(),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  period: periodSchema,
});
export type JournalLine = z.infer<typeof journalLineSchema>;

export const bankLineSchema = z.object({
  id: z.string().min(1),
  statementId: z.string().min(1),
  dateISO: isoDateSchema,
  /** positive = money in (credit to our account) */
  amountFils: filsSchema,
  payerName: z.string(),
  payerAccount: z.string().nullable(),
  reference: z.string().nullable(),
});
export type BankLine = z.infer<typeof bankLineSchema>;

export const matchKindSchema = z.enum(['auto', 'review', 'ambiguous', 'unknown_payer', 'partial']);
export type MatchKind = z.infer<typeof matchKindSchema>;

export const matchSuggestionSchema = z.object({
  bankLineId: z.string().min(1),
  kind: matchKindSchema,
  /** candidate lease ids, best first; empty for unknown_payer */
  leaseIds: z.array(z.string()),
  payerId: z.string().nullable(),
  amountFils: filsSchema,
  /** 0..1 deterministic score */
  confidence: z.number().min(0).max(1),
  /** human-readable reason, always shown in the UI */
  reason: z.string().min(1),
});
export type MatchSuggestion = z.infer<typeof matchSuggestionSchema>;

export const ownerShareSchema = z.object({
  ownerId: z.string().min(1),
  /** basis points of ownership; all shares of one property sum to exactly 10000 */
  shareBps: z.number().int().nonnegative().max(10000),
});
export type OwnerShare = z.infer<typeof ownerShareSchema>;

export const sharedAllocationModeSchema = z.enum(['per_unit', 'by_area', 'by_headcount', 'by_ampere', 'flat']);
export type SharedAllocationMode = z.infer<typeof sharedAllocationModeSchema>;

export const agingBucketSchema = z.enum(['current', 'd0_30', 'd31_60', 'd61_90', 'd90_plus']);
export type AgingBucket = z.infer<typeof agingBucketSchema>;
