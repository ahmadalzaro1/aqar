/**
 * What a charge IS, beyond its amount.
 *
 * Every line on a tenant statement answers four questions: who bears it, whether
 * it is revenue or someone else's money, whether it can be refunded, and whether
 * VAT applies. Those answers are properties of the KIND, not of the row, so they
 * live here once instead of being re-guessed at every report.
 *
 * `deposit` and `fit_out_deposit` are liabilities: the money is in the trust
 * account and belongs to the tenant until a move-out inspection says otherwise.
 * Treating a deposit as income is the single most common way a property manager
 * ends up spending money they owe back.
 */

export const CHARGE_KINDS = [
  'rent',
  'late_fee',
  'service',
  'service_charge',
  'deposit',
  'insurance',
  'utility',
  'parking',
  'fit_out_deposit',
  'cheque_bounce_fee',
  'vat',
  'penalty',
  'other',
] as const;

export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** Who the money is owed by. `shared` forces a split rule to be supplied. */
export type ChargeBearer = 'tenant' | 'landlord' | 'shared';

/**
 * income       -> landlord revenue
 * liability    -> held for a third party (tenant deposit, VAT owed to the state)
 * recovery     -> a cost we front and pass through without margin
 */
export type ChargeClass = 'income' | 'liability' | 'recovery';

export interface ChargeSemantics {
  readonly bearer: ChargeBearer;
  readonly classification: ChargeClass;
  readonly refundable: boolean;
  readonly vatApplicable: boolean;
  /** A kind that may not be posted before a human classifies it. */
  readonly requiresClassification: boolean;
  /** Grouping used by the tenant statement. */
  readonly statementGroup: 'rent' | 'utilities' | 'security' | 'fees' | 'tax' | 'other';
}

export const CHARGE_SEMANTICS: Readonly<Record<ChargeKind, ChargeSemantics>> = {
  rent: { bearer: 'tenant', classification: 'income', refundable: false, vatApplicable: true, requiresClassification: false, statementGroup: 'rent' },
  late_fee: { bearer: 'tenant', classification: 'income', refundable: false, vatApplicable: false, requiresClassification: false, statementGroup: 'fees' },
  service: { bearer: 'tenant', classification: 'income', refundable: false, vatApplicable: true, requiresClassification: false, statementGroup: 'fees' },
  service_charge: { bearer: 'tenant', classification: 'income', refundable: false, vatApplicable: true, requiresClassification: false, statementGroup: 'fees' },
  deposit: { bearer: 'tenant', classification: 'liability', refundable: true, vatApplicable: false, requiresClassification: false, statementGroup: 'security' },
  insurance: { bearer: 'tenant', classification: 'recovery', refundable: false, vatApplicable: false, requiresClassification: false, statementGroup: 'fees' },
  utility: { bearer: 'tenant', classification: 'recovery', refundable: false, vatApplicable: false, requiresClassification: false, statementGroup: 'utilities' },
  parking: { bearer: 'tenant', classification: 'income', refundable: false, vatApplicable: true, requiresClassification: false, statementGroup: 'fees' },
  fit_out_deposit: { bearer: 'tenant', classification: 'liability', refundable: true, vatApplicable: false, requiresClassification: false, statementGroup: 'security' },
  cheque_bounce_fee: { bearer: 'tenant', classification: 'income', refundable: false, vatApplicable: false, requiresClassification: false, statementGroup: 'fees' },
  vat: { bearer: 'tenant', classification: 'liability', refundable: false, vatApplicable: false, requiresClassification: false, statementGroup: 'tax' },
  penalty: { bearer: 'tenant', classification: 'income', refundable: false, vatApplicable: false, requiresClassification: false, statementGroup: 'fees' },
  other: { bearer: 'shared', classification: 'income', refundable: false, vatApplicable: true, requiresClassification: true, statementGroup: 'other' },
};

/** Money that must never be counted as landlord revenue. */
export function isTrustMoney(kind: ChargeKind): boolean {
  return CHARGE_SEMANTICS[kind].classification === 'liability';
}

/** Kinds that may be posted without a human supplying a classification. */
export function needsHumanClassification(kind: ChargeKind): boolean {
  return CHARGE_SEMANTICS[kind].requiresClassification;
}
