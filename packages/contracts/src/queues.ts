// Frozen queue contracts (additive, 2026-11-19): the ONLY interface between
// apps/channels (producer) and apps/worker (consumer). Both sides parse with
// these schemas; a payload that fails validation is rejected, never coerced.
import { z } from 'zod';

/** BullMQ queue name — single source of truth for producer and consumer. */
export const TRIAGE_QUEUE_NAME = 'aqar.ticket.triage';

export const ticketChannelSchema = z.enum(['whatsapp', 'telegram', 'email', 'in_app', 'phone']);
export type TicketChannel = z.infer<typeof ticketChannelSchema>;

/** Producer → consumer payload. idempotencyKey makes redelivery safe. */
export const ticketIngestJobSchema = z.object({
  ticketId: z.string().uuid(),
  orgId: z.string().uuid(),
  channel: ticketChannelSchema,
  text: z.string().min(1),
  locale: z.enum(['ar', 'en']),
  tenantId: z.string().uuid().nullable(),
  /** Stable per source message, e.g. `wa:<message-id>` / `tg:<update-id>`. */
  idempotencyKey: z.string().min(8),
});
export type TicketIngestJob = z.infer<typeof ticketIngestJobSchema>;

export const triageSeveritySchema = z.enum(['emergency', 'high', 'medium', 'low', 'cosmetic']);

/** Consumer → audit/result summary persisted with the job outcome. */
export const triageJobResultSchema = z.object({
  ticketId: z.string().uuid(),
  emergencyFlag: z.boolean(),
  severity: triageSeveritySchema,
  category: z.string().min(1),
  handedOffToHuman: z.boolean(),
  traceId: z.string().uuid(),
  proposalCount: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8),
});
export type TriageJobResult = z.infer<typeof triageJobResultSchema>;
