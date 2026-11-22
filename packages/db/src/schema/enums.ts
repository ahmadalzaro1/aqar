import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums mirror the zod enums in @aqar/contracts 1:1 (same member order).
 * Values are the source of truth for both the DB and the generated types.
 */

/** contracts/entities.ts unitStatusSchema */
export const unitStatusEnum = pgEnum('unit_status', [
  'vacant',
  'occupied',
  'turnover',
  'unavailable',
]);

/** contracts/entities.ts leaseStatusSchema */
export const leaseStatusEnum = pgEnum('lease_status', ['upcoming', 'active', 'ended', 'cancelled']);

/** contracts/entities.ts roleSchema ('user_role' because `role` is a reserved-ish identifier) */
export const userRoleEnum = pgEnum('user_role', [
  'owner_admin',
  'property_manager',
  'maintenance_coordinator',
  'accountant',
  'leasing_agent',
  'vendor',
  'tenant',
  'owner',
  'agent',
]);

/** contracts/entities.ts meterKindSchema */
export const meterKindEnum = pgEnum('meter_kind', ['water', 'electric', 'generator']);

/** contracts/entities.ts ticketStatusSchema */
export const ticketStatusEnum = pgEnum('ticket_status', [
  'new',
  'triaged',
  'awaiting_tenant',
  'approved',
  'dispatched',
  'in_progress',
  'completed',
  'closed',
  'cancelled',
]);

/** contracts/entities.ts applicationStatusSchema */
export const applicationStatusEnum = pgEnum('application_status', [
  'received',
  'screening',
  'documents_pending',
  'ready_for_decision',
  'approved',
  'rejected',
  'withdrawn',
]);

/** contracts/entities.ts localeSchema */
export const localeEnum = pgEnum('locale', ['ar', 'en']);

/** contracts/money.ts chargeKindSchema */
export const chargeKindEnum = pgEnum('charge_kind', [
  'rent',
  'late_fee',
  'service',
  'deposit',
  'other',
]);

/** contracts/money.ts paymentMethodSchema */
export const paymentMethodEnum = pgEnum('payment_method', [
  'cash',
  'cliq',
  'bank_transfer',
  'cheque',
]);

/** contracts/money.ts chequeStatusSchema */
export const chequeStatusEnum = pgEnum('cheque_status', [
  'received',
  'deposited',
  'cleared',
  'bounced',
]);

/** contracts/money.ts accountCodeSchema */
export const accountCodeEnum = pgEnum('account_code', [
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

/** contracts/money.ts matchKindSchema */
export const matchKindEnum = pgEnum('match_kind', [
  'auto',
  'review',
  'ambiguous',
  'unknown_payer',
  'partial',
]);

/** contracts/ops.ts severitySchema */
export const severityEnum = pgEnum('severity', ['emergency', 'high', 'medium', 'low', 'cosmetic']);

/** contracts/ops.ts ticketCategorySchema */
export const ticketCategoryEnum = pgEnum('ticket_category', [
  'gas',
  'fire',
  'electrical',
  'plumbing',
  'sewage',
  'water',
  'hvac',
  'structural',
  'lock',
  'elevator',
  'appliance',
  'pest',
  'common_area',
  'generator',
  'other',
]);

/** contracts/ops.ts responsibilitySchema */
export const responsibilityEnum = pgEnum('responsibility', [
  'landlord',
  'tenant',
  'shared',
  'warranty',
]);

/** contracts/ops.ts ticketInputSchema channel */
export const ticketChannelEnum = pgEnum('ticket_channel', [
  'whatsapp',
  'telegram',
  'email',
  'in_app',
  'phone',
]);

/** Outbound/inbound direction of a stored ticket message. */
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);

/** Who decided a classification/responsibility: deterministic rule, model, or human. */
export const decisionActorEnum = pgEnum('decision_actor', ['rule', 'model', 'human']);

/** M2 listing lifecycle. */
export const listingStatusEnum = pgEnum('listing_status', ['draft', 'live', 'paused', 'closed']);

/** M2 inquiry lifecycle. */
export const inquiryStatusEnum = pgEnum('inquiry_status', [
  'new',
  'contacted',
  'qualified',
  'dropped',
]);

/** M2 showing outcome. */
export const showingOutcomeEnum = pgEnum('showing_outcome', [
  'scheduled',
  'attended',
  'no_show',
  'cancelled',
]);

/** M2 decision outcomes. */
export const applicationDecisionEnum = pgEnum('application_decision', [
  'approve',
  'reject',
  'waitlist',
]);

/** M3 renewal offer lifecycle. */
export const offerStatusEnum = pgEnum('offer_status', [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
]);

/** M3 notices. */
export const noticeKindEnum = pgEnum('notice_kind', [
  'rent_increase',
  'eviction',
  'maintenance_entry',
  'termination',
  'general',
]);

export const noticeDirectionEnum = pgEnum('notice_direction', ['to_tenant', 'from_tenant']);

/** M5 work order lifecycle. */
export const workOrderStatusEnum = pgEnum('work_order_status', [
  'draft',
  'approved',
  'dispatched',
  'in_progress',
  'completed',
  'cancelled',
]);

/** M5 vendor dispatch lifecycle. */
export const dispatchStatusEnum = pgEnum('dispatch_status', [
  'offered',
  'accepted',
  'declined',
  'expired',
]);

/** M6 vendor quote lifecycle. */
export const quoteStatusEnum = pgEnum('quote_status', [
  'requested',
  'received',
  'selected',
  'rejected',
  'expired',
]);

/** M6 vendor invoice lifecycle. */
export const invoiceStatusEnum = pgEnum('invoice_status', [
  'received',
  'approved',
  'scheduled',
  'paid',
  'disputed',
]);

/** M6 vendor job lifecycle. */
export const vendorJobStatusEnum = pgEnum('vendor_job_status', [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
]);

/** M7 owner distribution lifecycle. */
export const distributionStatusEnum = pgEnum('distribution_status', [
  'draft',
  'pending_approval',
  'approved',
  'paid',
  'cancelled',
]);

/** M7 owner approval vote. */
export const ownerVoteEnum = pgEnum('owner_vote', ['yes', 'no', 'abstain']);

/** M7 spend type under owner approval. */
export const spendKindEnum = pgEnum('spend_kind', ['capex', 'opex', 'emergency']);

/** M8 document lifecycle (versioned records). */
export const documentStatusEnum = pgEnum('document_status', [
  'draft',
  'active',
  'superseded',
  'archived',
]);

/** Auth: channel identity kinds. */
export const identityChannelEnum = pgEnum('identity_channel', [
  'whatsapp',
  'telegram',
  'sms',
  'email',
  'in_app',
]);
