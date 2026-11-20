// Persistence boundary for ticket triage.
//
// Everything here is RLS-correct: every tenant-scoped read and write runs inside
// `withOrganization`, so the same code works for the `aqar_app` (NOBYPASSRLS)
// role in production and for the superuser in dev.
//
// Invariants enforced by this module (and by the DB):
//  - one triage job => exactly one audit_events row (unique idempotency_key);
//  - the classification, the trace, the audit row, the safety messages and the
//    sticky emergency flag commit together or not at all;
//  - tickets.emergency_flag is only ever raised here, never cleared.
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  policyActionSchema,
  policyDecisionSchema,
  triageJobResultSchema,
  type AgentTraceStep,
  type Actor,
  type TicketChannel,
  type TicketIngestJob,
  type TriageJobResult,
} from '@aqar/contracts';
import type { StepTrace, TriageResult } from '@aqar/agents';
import {
  agentTraces,
  auditEvents,
  classifications,
  ticketMessages,
  tickets,
  withOrganization,
  type Db,
} from '@aqar/db';

/** Actor identity used for every worker-originated write. */
export const TRIAGE_ACTOR = 'agent:triage';

/** Audit action written for every processed triage job. */
export const TRIAGE_AUDIT_ACTION = 'ticket.triage.classified';

/** The audit payload. Read back verbatim to answer a redelivery (idempotency). */
export const triageAuditPayloadSchema = z.object({
  result: triageJobResultSchema,
  proposals: z.array(
    z.object({ action: policyActionSchema, decision: policyDecisionSchema }),
  ),
  safetyInstructions: z.object({ ar: z.string(), en: z.string() }).nullable(),
});
export type TriageAuditPayload = z.infer<typeof triageAuditPayloadSchema>;

/** Ticket columns the triage decision actually depends on. */
export interface TicketRecord {
  id: string;
  organizationId: string;
  propertyId: string;
  tenantId: string | null;
  channel: TicketChannel;
  body: string;
  bodyLocale: 'ar' | 'en';
  emergencyFlag: boolean;
}

export interface PersistTriageInput {
  job: TicketIngestJob;
  ticket: TicketRecord;
  result: TriageResult;
  jobResult: TriageJobResult;
  /** Pre-generated so the trace id can be reported before the insert lands. */
  traceId: string;
  nowISO: string;
}

export interface PersistTriageOutcome {
  result: TriageJobResult;
  /** true when a concurrent/redelivered job had already written this key. */
  deduped: boolean;
}

export interface TriageStore {
  /** Prior result for this idempotencyKey, or null when this is the first run. */
  findPriorResult(orgId: string, idempotencyKey: string): Promise<TriageJobResult | null>;
  loadTicket(orgId: string, ticketId: string): Promise<TicketRecord | null>;
  /** One transaction; returns the winning result if the key was taken meanwhile. */
  persist(input: PersistTriageInput): Promise<PersistTriageOutcome>;
}

const AUDIT_IDEMPOTENCY_CONSTRAINT = 'audit_events_idempotency_uq';

/** postgres.js throws a plain object; we only need `code` (+ constraint name). */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; constraint_name?: unknown };
  if (candidate.code !== '23505') return false;
  return candidate.constraint_name === undefined || candidate.constraint_name === constraint;
}

/**
 * Orchestrator steps -> contracts AgentTraceStep rows.
 *
 * The orchestrator reports one combined token count per step, so the split is
 * genuinely unknown: we record it on the input side and zero on the output side
 * (totals stay correct, no invented precision). Non-model steps get the sentinel
 * model id 'none' because the column is NOT NULL.
 */
type PersistedStep = AgentTraceStep & { step: string; detail: string };

function toTraceSteps(steps: readonly StepTrace[]): PersistedStep[] {
  return steps.map((step) => ({
    agentName: step.agent,
    promptVersion: step.promptVersion,
    modelId: step.model ?? 'none',
    inputHash: step.inputHash,
    outputHash: step.outputHash,
    tokensIn: step.tokens,
    tokensOut: 0,
    latencyMs: step.latencyMs,
    costEstimateMicroUsd: Math.round(step.estimatedCostUsd * 1_000_000),
    confidence: step.confidence,
    escalatedToStrongModel: step.step === 'classify-strong',
    step: step.step,
    detail: step.detail,
  }));
}

/** Model verdict actually recorded, if a model step ran at all. */
function modelStepOf(result: TriageResult): StepTrace | undefined {
  return result.steps.find((step) => step.step === 'classify-strong')
    ?? result.steps.find((step) => step.step === 'classify');
}

function rationaleFor(result: TriageResult): string {
  const modelStep = modelStepOf(result);
  if (modelStep !== undefined) return result.merged.rationale;
  return `${result.merged.rationale} modelSeverity mirrors the merged severity: no model verdict was recorded (deterministic fallback), so model_severity must not be read as a model opinion.`;
}

export function createDrizzleTriageStore(db: Db): TriageStore {
  return {
    async findPriorResult(orgId, idempotencyKey) {
      const rows = await withOrganization(db, orgId, (tx) =>
        tx
          .select({ after: auditEvents.after })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.organizationId, orgId),
              eq(auditEvents.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1),
      );
      const row = rows[0];
      if (row === undefined) return null;
      const payload = triageAuditPayloadSchema.safeParse(row.after);
      return payload.success ? payload.data.result : null;
    },

    async loadTicket(orgId, ticketId) {
      const rows = await withOrganization(db, orgId, (tx) =>
        tx
          .select({
            id: tickets.id,
            organizationId: tickets.organizationId,
            propertyId: tickets.propertyId,
            tenantId: tickets.tenantId,
            channel: tickets.channel,
            body: tickets.body,
            bodyLocale: tickets.bodyLocale,
            emergencyFlag: tickets.emergencyFlag,
          })
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, orgId)))
          .limit(1),
      );
      return rows[0] ?? null;
    },

    async persist(input) {
      const { job, ticket, result, jobResult, traceId, nowISO } = input;
      const occurredAt = new Date(nowISO);
      const modelStep = modelStepOf(result);
      const actor: Actor = { type: 'agent', agentName: TRIAGE_ACTOR };

      const payload: TriageAuditPayload = {
        result: jobResult,
        proposals: result.proposals,
        safetyInstructions: result.safetyInstructions,
      };

      try {
        await withOrganization(db, job.orgId, async (tx) => {
          await tx.insert(classifications).values({
            organizationId: job.orgId,
            ticketId: ticket.id,
            category: result.merged.category,
            severity: result.merged.severity,
            emergencyFlag: result.merged.emergencyFlag,
            confidence: result.merged.confidence.toFixed(3),
            deterministicEmergency: result.merged.deterministicEmergency,
            modelSeverity: result.merged.modelSeverity,
            rationale: rationaleFor(result),
            modelId: modelStep?.model ?? null,
            promptVersion: modelStep?.promptVersion ?? 'det-1.0.0',
          });

          await tx.insert(agentTraces).values({
            id: traceId,
            organizationId: job.orgId,
            ticketId: ticket.id,
            steps: toTraceSteps(result.steps),
            totalTokens: result.tokensUsed,
            totalLatencyMs: result.totalLatencyMs,
            handedOffToHuman: result.handedOffToHuman,
            handoffReason: result.handoffReason,
          });

          await tx.insert(auditEvents).values({
            organizationId: job.orgId,
            actor,
            action: TRIAGE_AUDIT_ACTION,
            entityType: 'ticket',
            entityId: ticket.id,
            before: null,
            after: payload,
            modelId: modelStep?.model ?? null,
            promptVersion: modelStep?.promptVersion ?? null,
            confidence: result.merged.confidence.toFixed(3),
            toolCalls: [],
            idempotencyKey: job.idempotencyKey,
            occurredAt,
          });

          // Emergency => the tenant gets the safety advisory in both locales.
          // Human paging IS this audit row + these outbound rows; dry_run means
          // no vendor was dispatched and nothing external was sent (externalId
          // stays null: the channel adapter owns delivery, not the worker).
          // Safety text is life-safety, so it is emitted regardless of quiet
          // hours — the policy gate governs agent-initiated conversation, not
          // hazards. None of this executes any money or vendor action.
          if (result.safetyInstructions !== null) {
            await tx.insert(ticketMessages).values([
              {
                organizationId: job.orgId,
                ticketId: ticket.id,
                direction: 'outbound',
                channel: ticket.channel,
                tenantId: ticket.tenantId,
                body: result.safetyInstructions.ar,
                bodyLocale: 'ar',
                sentAt: occurredAt,
                externalId: null,
              },
              {
                organizationId: job.orgId,
                ticketId: ticket.id,
                direction: 'outbound',
                channel: ticket.channel,
                tenantId: ticket.tenantId,
                body: result.safetyInstructions.en,
                bodyLocale: 'en',
                sentAt: occurredAt,
                externalId: null,
              },
            ]);
          }

          // The ONLY ticket mutation the worker performs: raise the sticky flag.
          // It is never cleared here (a DB trigger rejects clearing it anyway).
          if (result.merged.emergencyFlag && !ticket.emergencyFlag) {
            await tx
              .update(tickets)
              .set({ emergencyFlag: true })
              .where(
                and(
                  eq(tickets.id, ticket.id),
                  eq(tickets.organizationId, job.orgId),
                  eq(tickets.emergencyFlag, false),
                ),
              );
          }
        });
      } catch (err) {
        if (isUniqueViolation(err, AUDIT_IDEMPOTENCY_CONSTRAINT)) {
          const prior = await this.findPriorResult(job.orgId, job.idempotencyKey);
          if (prior === null) {
            throw new Error(
              `idempotency key ${job.idempotencyKey} already exists but its audit payload is unreadable; refusing to return a partial result`,
              { cause: err },
            );
          }
          return { result: prior, deduped: true };
        }
        throw err;
      }

      return { result: jobResult, deduped: false };
    },
  };
}
