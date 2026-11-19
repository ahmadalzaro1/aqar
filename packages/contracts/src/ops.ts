import { z } from 'zod';
import { isoDateSchema } from './money.js';

export const severitySchema = z.enum(['emergency', 'high', 'medium', 'low', 'cosmetic']);
export type Severity = z.infer<typeof severitySchema>;

export const ticketCategorySchema = z.enum([
  'gas', 'fire', 'electrical', 'plumbing', 'sewage', 'water', 'hvac', 'structural',
  'lock', 'elevator', 'appliance', 'pest', 'common_area', 'generator', 'other',
]);
export type TicketCategory = z.infer<typeof ticketCategorySchema>;

export const responsibilitySchema = z.enum(['landlord', 'tenant', 'shared', 'warranty']);
export type Responsibility = z.infer<typeof responsibilitySchema>;

/** Deterministic pre-classifier output. emergency=true is STICKY for the ticket's life. */
export const emergencyPrecheckSchema = z.object({
  emergency: z.boolean(),
  /** matched hazard signal ids, e.g. 'gas_smell', 'fire', 'sewage', 'no_water', 'electrical_hazard' */
  signals: z.array(z.string()),
  /** safety instructions key to render immediately, null when not emergency */
  safetyInstructionsKey: z.string().nullable(),
});
export type EmergencyPrecheck = z.infer<typeof emergencyPrecheckSchema>;

export const classificationSchema = z.object({
  category: ticketCategorySchema,
  severity: severitySchema,
  emergencyFlag: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type Classification = z.infer<typeof classificationSchema>;

/**
 * Merge law (LAW 2): emergency = deterministicFlag OR modelFlag.
 * A model may RAISE severity, never lower an emergency flag.
 */
export const mergedClassificationSchema = classificationSchema.extend({
  deterministicEmergency: z.boolean(),
  modelSeverity: severitySchema,
  modelEmergencyFlag: z.boolean(),
});
export type MergedClassification = z.infer<typeof mergedClassificationSchema>;

/** Configurable service-standard pack. NEVER presented as law. */
export const serviceStandardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  propertyClass: z.string().min(1),
  clocks: z.record(severitySchema, z.object({
    responseMinutes: z.number().int().nonnegative(),
    resolutionMinutes: z.number().int().nonnegative(),
  })),
});
export type ServiceStandard = z.infer<typeof serviceStandardSchema>;

export const slaStateSchema = z.object({
  responseDueISO: z.string(),
  resolutionDueISO: z.string(),
  responseBreached: z.boolean(),
  resolutionBreached: z.boolean(),
});
export type SlaState = z.infer<typeof slaStateSchema>;

export const policyActionSchema = z.enum([
  'dispatch_vendor', 'post_payment', 'approve_quote', 'send_tenant_message',
  'create_charge', 'move_money', 'award_work', 'draft_only',
]);
export type PolicyAction = z.infer<typeof policyActionSchema>;

export const policyInputSchema = z.object({
  action: policyActionSchema,
  orgId: z.string().min(1),
  propertyId: z.string().min(1),
  actor: z.string().min(1),
  /** agent runs in dry_run until a human enables live mode per property */
  mode: z.enum(['dry_run', 'live']),
  amountFils: z.number().int().nonnegative().nullable(),
  vendorId: z.string().nullable(),
  vendorOnAllowList: z.boolean(),
  /** NTE = not-to-exceed limit for the property, fils */
  nteLimitFils: z.number().int().nonnegative().nullable(),
  /** owner approval group: required votes N of M */
  approvalRequiredN: z.number().int().nonnegative(),
  approvalRequiredM: z.number().int().nonnegative(),
  approvalVotesYes: z.number().int().nonnegative(),
  /** local hour 0..23 and quiet-hours window for tenant contact */
  localHour: z.number().int().min(0).max(23),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  tenantMessagesToday: z.number().int().nonnegative(),
  tenantMessageDailyCap: z.number().int().nonnegative(),
  orgSpendTodayFils: z.number().int().nonnegative(),
  orgDailySpendCapFils: z.number().int().nonnegative(),
  humanApprovalTokenPresent: z.boolean(),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

export const policyDecisionSchema = z.object({
  allowed: z.boolean(),
  requiresHumanApproval: z.boolean(),
  /** machine-readable denial reasons, e.g. 'nte_exceeded', 'quiet_hours', 'dry_run' */
  reasons: z.array(z.string()),
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const vendorScoreInputSchema = z.object({
  jobsTotal: z.number().int().nonnegative(),
  jobsCompleted: z.number().int().nonnegative(),
  jobsOnTime: z.number().int().nonnegative(),
  /** sum of (actual - quoted) / quoted in basis points, can be negative */
  costVarianceBpsSum: z.number().int(),
  jobsReworked: z.number().int().nonnegative(),
});
export type VendorScoreInput = z.infer<typeof vendorScoreInputSchema>;

export const ticketInputSchema = z.object({
  text: z.string(),
  channel: z.enum(['whatsapp', 'telegram', 'email', 'in_app', 'phone']),
  hasPhoto: z.boolean(),
  receivedAtISO: isoDateSchema,
});
export type TicketInput = z.infer<typeof ticketInputSchema>;
