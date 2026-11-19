import { z } from 'zod';

export const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('human'), userId: z.string().min(1) }),
  z.object({ type: z.literal('agent'), agentName: z.string().min(1) }),
  z.object({ type: z.literal('system'), component: z.string().min(1) }),
]);
export type Actor = z.infer<typeof actorSchema>;

export const toolCallTraceSchema = z.object({
  tool: z.string().min(1),
  inputHash: z.string().min(1),
  outputHash: z.string().min(1),
  policyAllowed: z.boolean(),
});
export type ToolCallTrace = z.infer<typeof toolCallTraceSchema>;

/** Append-only. Corrections are reversals (reversalOf), never hard deletes. */
export const auditEventSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  actor: actorSchema,
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  modelId: z.string().nullable(),
  promptVersion: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  toolCalls: z.array(toolCallTraceSchema),
  idempotencyKey: z.string().min(1),
  occurredAtISO: z.string().min(1),
  reversalOf: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const agentTraceStepSchema = z.object({
  agentName: z.string().min(1),
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
  inputHash: z.string().min(1),
  outputHash: z.string().min(1),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  /** estimated cost in USD micro-units; labelled estimate, never a billed claim */
  costEstimateMicroUsd: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable(),
  escalatedToStrongModel: z.boolean(),
});
export type AgentTraceStep = z.infer<typeof agentTraceStepSchema>;

export const agentTraceSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  ticketId: z.string().nullable(),
  steps: z.array(agentTraceStepSchema),
  totalTokens: z.number().int().nonnegative(),
  totalLatencyMs: z.number().int().nonnegative(),
  handedOffToHuman: z.boolean(),
  handoffReason: z.string().nullable(),
});
export type AgentTrace = z.infer<typeof agentTraceSchema>;
