// REAL end-to-end proof, no mocks:
//
//   Postgres (dev DB) + Redis (BullMQ) + the local OpenAI-compatible model.
//
// It inserts a NEW Arabic gas-leak ticket, enqueues a real TicketIngestJob,
// runs the real worker in-process, waits for BullMQ to report completion, then
// reads the persisted rows back from Postgres and prints them. Finally it
// replays the SAME job (same idempotencyKey) and proves nothing was written
// twice and no vendor dispatch / work order was created (dry_run).
//
// Run:
//   DATABASE_URL=postgres://aqar:...@127.0.0.1:5433/aqar \
//   REDIS_URL=redis://127.0.0.1:6380 \
//   pnpm --filter @aqar/worker exec tsx src/e2e.ts
//
// Exit code 0 only when every assertion holds.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { QueueEvents, type Job } from 'bullmq';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agentTraceStepSchema, TRIAGE_QUEUE_NAME, ticketIngestJobSchema, type TicketIngestJob, type TriageJobResult } from '@aqar/contracts';

/** The worker persists AgentTraceStep plus a step label + detail; parse, never coerce. */
const persistedStepSchema = agentTraceStepSchema.extend({ step: z.string(), detail: z.string() });
import {
  agentTraces,
  auditEvents,
  classifications,
  createDb,
  dispatches,
  organizations,
  ticketMessages,
  tickets,
  withOrganization,
  workOrders,
} from '@aqar/db';
import { createProcessorDeps, processTriageJob } from './processor.js';
import {
  connectionOptions,
  createTriageQueue,
  createTriageWorker,
  enqueueTicketIngest,
} from './queue.js';
import { triageAuditPayloadSchema } from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARABIC_GAS_REPORT = 'ريحة غاز قوية بالمطبخ من ساعة، سكرت الغاز والريحة لسا موجودة';
const DEMO_ORG_SLUG = 'aqar-demo';
const JOB_TIMEOUT_MS = 120_000;

function loadEnvIfUnset(): void {
  if (process.env['DATABASE_URL'] !== undefined) return;
  const candidate = resolve(HERE, '../../../.env');
  if (!existsSync(candidate)) return;
  process.loadEnvFile(candidate);
}

function banner(step: string): void {
  console.info(`\n=== ${step} ${'='.repeat(Math.max(0, 68 - step.length))}`);
}

function print(label: string, value: unknown): void {
  console.info(`${label}:\n${inspect(value, { depth: 6, colors: false, breakLength: 110 })}`);
}

interface Evidence {
  classification: {
    id: string;
    category: string;
    severity: string;
    emergencyFlag: boolean;
    confidence: string;
    deterministicEmergency: boolean;
    modelSeverity: string;
    rationale: string;
    modelId: string | null;
    promptVersion: string | null;
  } | null;
  trace: {
    id: string;
    totalTokens: number;
    totalLatencyMs: number;
    handedOffToHuman: boolean;
    handoffReason: string | null;
    steps: { step: string; agentName: string; modelId: string; tokensIn: number; latencyMs: number }[];
  } | null;
  audit: {
    id: string;
    actor: unknown;
    action: string;
    entityType: string;
    entityId: string;
    modelId: string | null;
    promptVersion: string | null;
    confidence: string | null;
    idempotencyKey: string;
    occurredAt: Date;
    after: unknown;
  } | null;
  messages: { id: string; direction: string; channel: string; bodyLocale: string; externalId: string | null; body: string }[];
  dispatchCount: number;
  workOrderCount: number;
  ticketEmergencyFlag: boolean | null;
}

async function main(): Promise<void> {
  loadEnvIfUnset();

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL must be set for the e2e run');
  }
  const { db, client } = createDb(databaseUrl, 3);

  let queue: ReturnType<typeof createTriageQueue> | null = null;
  let worker: ReturnType<typeof createTriageWorker> | null = null;
  let events: QueueEvents | null = null;

  try {
    banner('1/6 environment');
    const orgRows = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.slug, DEMO_ORG_SLUG))
      .limit(1);
    const org = orgRows[0];
    if (org === undefined) throw new Error(`organization slug '${DEMO_ORG_SLUG}' not found — run pnpm db:seed`);
    const orgId = org.id;
    console.info(`database: ${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}`);
    console.info(`redis:    ${process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6380'}`);
    console.info(`model:    ${process.env['LOCAL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1'} ${process.env['LOCAL_MODEL'] ?? 'lfm3-local'}`);
    console.info(`org:      ${org.slug} (${orgId})`);

    banner('2/6 fixture ticket');
    const baseline = await withOrganization(db, orgId, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(tickets).where(eq(tickets.organizationId, orgId)),
    );
    const baselineTickets = baseline[0]?.n ?? 0;

    const anchorRows = await withOrganization(db, orgId, (tx) =>
      tx
        .select({ propertyId: tickets.propertyId, unitId: tickets.unitId, tenantId: tickets.tenantId })
        .from(tickets)
        .where(
          and(
            eq(tickets.organizationId, orgId),
            isNotNull(tickets.unitId),
            isNotNull(tickets.tenantId),
          ),
        )
        .limit(1),
    );
    const anchor = anchorRows[0];
    if (anchor === undefined || anchor.unitId === null) {
      throw new Error('no seeded ticket with a unit and a tenant to anchor the fixture on');
    }

    const subject = `E2E triage ${new Date().toISOString()} ${randomUUID().slice(0, 8)}`;
    const inserted = await withOrganization(db, orgId, (tx) =>
      tx
        .insert(tickets)
        .values({
          organizationId: orgId,
          propertyId: anchor.propertyId,
          unitId: anchor.unitId,
          tenantId: anchor.tenantId,
          channel: 'whatsapp',
          status: 'new',
          openedAt: new Date(),
          subject,
          body: ARABIC_GAS_REPORT,
          bodyLocale: 'ar',
          emergencyFlag: false,
        })
        .returning({ id: tickets.id, emergencyFlag: tickets.emergencyFlag }),
    );
    const fixture = inserted[0];
    if (fixture === undefined) throw new Error('failed to insert the fixture ticket');
    const ticketId = fixture.id;
    console.info(`inserted ticket ${ticketId}`);
    console.info(`  subject:     ${subject}`);
    console.info(`  body (ar):   ${ARABIC_GAS_REPORT}`);
    console.info(`  emergency_flag before triage: ${fixture.emergencyFlag}`);
    console.info(`  org ticket count before:      ${baselineTickets}`);

    const idempotencyKey = `e2e:${randomUUID()}`;
    const payload: TicketIngestJob = ticketIngestJobSchema.parse({
      ticketId,
      orgId,
      channel: 'whatsapp',
      text: ARABIC_GAS_REPORT,
      locale: 'ar',
      tenantId: anchor.tenantId,
      idempotencyKey,
    });
    console.info(`  idempotencyKey: ${idempotencyKey}`);

    banner('3/6 worker + queue');
    const deps = createProcessorDeps({ env: process.env, db });
    queue = createTriageQueue();
    events = new QueueEvents(TRIAGE_QUEUE_NAME, { connection: connectionOptions() });
    await events.waitUntilReady();
    worker = createTriageWorker(async (job) => processTriageJob(job.data, deps), { concurrency: 1 });
    await worker.waitUntilReady();
    console.info(`worker listening on ${TRIAGE_QUEUE_NAME}`);

    const started = Date.now();
    const job1: Job<unknown, TriageJobResult> = await enqueueTicketIngest(queue, payload);
    const result1 = await job1.waitUntilFinished(events, JOB_TIMEOUT_MS);
    const elapsed1 = Date.now() - started;
    console.info(`job ${String(job1.id)} finished in ${elapsed1} ms`);
    print('triageJobResult (run 1)', result1);

    const readEvidence = async (): Promise<Evidence> => {
      const [cls] = await withOrganization(db, orgId, (tx) =>
        tx
          .select({
            id: classifications.id,
            category: classifications.category,
            severity: classifications.severity,
            emergencyFlag: classifications.emergencyFlag,
            confidence: classifications.confidence,
            deterministicEmergency: classifications.deterministicEmergency,
            modelSeverity: classifications.modelSeverity,
            rationale: classifications.rationale,
            modelId: classifications.modelId,
            promptVersion: classifications.promptVersion,
          })
          .from(classifications)
          .where(eq(classifications.ticketId, ticketId)),
      );

      const traceRows = await withOrganization(db, orgId, (tx) =>
        tx
          .select({
            id: agentTraces.id,
            totalTokens: agentTraces.totalTokens,
            totalLatencyMs: agentTraces.totalLatencyMs,
            handedOffToHuman: agentTraces.handedOffToHuman,
            handoffReason: agentTraces.handoffReason,
            steps: agentTraces.steps,
          })
          .from(agentTraces)
          .where(eq(agentTraces.ticketId, ticketId)),
      );
      const traceRow = traceRows[0];

      const [audit] = await withOrganization(db, orgId, (tx) =>
        tx
          .select({
            id: auditEvents.id,
            actor: auditEvents.actor,
            action: auditEvents.action,
            entityType: auditEvents.entityType,
            entityId: auditEvents.entityId,
            modelId: auditEvents.modelId,
            promptVersion: auditEvents.promptVersion,
            confidence: auditEvents.confidence,
            idempotencyKey: auditEvents.idempotencyKey,
            occurredAt: auditEvents.occurredAt,
            after: auditEvents.after,
          })
          .from(auditEvents)
          .where(
            and(eq(auditEvents.organizationId, orgId), eq(auditEvents.idempotencyKey, idempotencyKey)),
          ),
      );

      const messages = await withOrganization(db, orgId, (tx) =>
        tx
          .select({
            id: ticketMessages.id,
            direction: ticketMessages.direction,
            channel: ticketMessages.channel,
            bodyLocale: ticketMessages.bodyLocale,
            externalId: ticketMessages.externalId,
            body: ticketMessages.body,
          })
          .from(ticketMessages)
          .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.direction, 'outbound'))),
      );

      const [dispatchCount] = await withOrganization(db, orgId, (tx) =>
        tx.select({ n: sql<number>`count(*)::int` }).from(dispatches).where(eq(dispatches.ticketId, ticketId)),
      );
      const [workOrderCount] = await withOrganization(db, orgId, (tx) =>
        tx.select({ n: sql<number>`count(*)::int` }).from(workOrders).where(eq(workOrders.ticketId, ticketId)),
      );

      const [ticketRow] = await withOrganization(db, orgId, (tx) =>
        tx
          .select({ emergencyFlag: tickets.emergencyFlag })
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, orgId))),
      );

      return {
        classification: cls ?? null,
        trace:
          traceRow === undefined
            ? null
            : {
                id: traceRow.id,
                totalTokens: traceRow.totalTokens,
                totalLatencyMs: traceRow.totalLatencyMs,
                handedOffToHuman: traceRow.handedOffToHuman,
                handoffReason: traceRow.handoffReason,
                steps: traceRow.steps.map((raw) => {
                  const step = persistedStepSchema.parse(raw);
                  return {
                    step: step.step,
                    agentName: step.agentName,
                    modelId: step.modelId,
                    tokensIn: step.tokensIn,
                    latencyMs: step.latencyMs,
                  };
                }),
              },
        audit: audit ?? null,
        messages,
        dispatchCount: dispatchCount?.n ?? -1,
        workOrderCount: workOrderCount?.n ?? -1,
        ticketEmergencyFlag: ticketRow?.emergencyFlag ?? null,
      };
    };

    banner('4/6 rows read back from Postgres');
    const first = await readEvidence();
    print('classifications row', first.classification);
    print('agent_traces row', first.trace);
    print('audit_events row', {
      ...first.audit,
      after: first.audit === null ? null : 'see payload below',
    });
    const payloadParsed = triageAuditPayloadSchema.parse(first.audit?.after);
    print('audit_events.after (payload)', {
      result: payloadParsed.result,
      safetyInstructions: {
        ar: `${payloadParsed.safetyInstructions?.ar.slice(0, 70) ?? ''}… (${payloadParsed.safetyInstructions?.ar.length ?? 0} chars)`,
        en: `${payloadParsed.safetyInstructions?.en.slice(0, 70) ?? ''}… (${payloadParsed.safetyInstructions?.en.length ?? 0} chars)`,
      },
      proposals: payloadParsed.proposals,
    });
    print(
      'ticket_messages (outbound)',
      first.messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        channel: message.channel,
        bodyLocale: message.bodyLocale,
        externalId: message.externalId,
        body: `${message.body.slice(0, 70).replace(/\n/g, ' / ')}… (${message.body.length} chars)`,
      })),
    );

    // ---- assertions on run 1 ------------------------------------------------
    assert.ok(first.classification !== null, 'classification row missing');
    assert.equal(first.classification.emergencyFlag, true, 'emergency flag must be raised');
    assert.equal(first.classification.severity, 'emergency', 'severity must be emergency');
    assert.equal(first.classification.category, 'gas', 'hazard signal must win the category');
    assert.equal(first.classification.deterministicEmergency, true, 'deterministic pre-check must fire');
    assert.ok(first.classification.modelSeverity.length > 0, 'model_severity is NOT NULL');
    assert.ok(first.classification.rationale.length > 0, 'rationale is NOT NULL');
    assert.ok(first.classification.confidence.length > 0, 'confidence recorded');

    assert.ok(first.trace !== null, 'agent_traces row missing');
    assert.equal(first.trace.id, result1.traceId, 'traceId must match the persisted trace row');
    assert.ok(first.trace.steps.length >= 3, 'trace must carry precheck + classify + merge steps');
    assert.ok(first.trace.totalLatencyMs >= 0, 'latency recorded');

    assert.ok(first.audit !== null, 'audit_events row missing');
    assert.equal(first.audit.action, 'ticket.triage.classified');
    assert.equal(first.audit.entityType, 'ticket');
    assert.equal(first.audit.entityId, ticketId);
    assert.equal(first.audit.idempotencyKey, idempotencyKey);
    assert.deepEqual(first.audit.actor, { type: 'agent', agentName: 'agent:triage' });
    assert.equal(payloadParsed.result.traceId, result1.traceId);

    // dry_run: the dispatch proposal exists (emergency) but is DENIED, and
    // nothing was dispatched or ordered in the database.
    const dispatchProposal = payloadParsed.proposals.find((p) => p.action === 'dispatch_vendor');
    assert.ok(dispatchProposal !== undefined, 'emergency must propose dispatch_vendor');
    assert.equal(dispatchProposal.decision.allowed, false, 'dry_run must deny vendor dispatch');
    assert.ok(dispatchProposal.decision.reasons.includes('dry_run'), 'denial reason must be dry_run');
    assert.equal(first.dispatchCount, 0, 'no dispatches row may exist (dry_run)');
    assert.equal(first.workOrderCount, 0, 'no work order may exist (dry_run)');
    assert.equal(payloadParsed.result.proposalCount, payloadParsed.proposals.length);

    // Human paging = audit row + outbound safety messages in both locales.
    assert.equal(first.messages.length, 2, 'exactly two outbound safety messages (ar + en)');
    assert.deepEqual(
      first.messages.map((m) => m.bodyLocale).sort(),
      ['ar', 'en'],
      'safety advisory must exist in Arabic and English',
    );
    assert.ok(first.messages.every((m) => m.externalId === null), 'nothing was actually sent (dry_run)');
    assert.equal(first.ticketEmergencyFlag, true, 'tickets.emergency_flag must be raised');
    console.info('assertions (run 1): OK');

    banner('5/6 idempotency replay (same idempotencyKey)');
    const job2: Job<unknown, TriageJobResult> = await enqueueTicketIngest(queue, payload);
    const result2 = await job2.waitUntilFinished(events, JOB_TIMEOUT_MS);
    print('triageJobResult (run 2)', result2);
    const second = await readEvidence();
    const [counts] = await client<{
      classifications: number;
      traces: number;
      audits: number;
      messages: number;
      tickets: number;
    }[]>`
      select
        (select count(*)::int from classifications where ticket_id = ${ticketId}) as classifications,
        (select count(*)::int from agent_traces where ticket_id = ${ticketId}) as traces,
        (select count(*)::int from audit_events where idempotency_key = ${idempotencyKey}) as audits,
        (select count(*)::int from ticket_messages where ticket_id = ${ticketId}) as messages,
        (select count(*)::int from tickets where organization_id = ${orgId}) as tickets
    `;
    print('row counts after replay', counts);

    assert.equal(result2.traceId, result1.traceId, 'replay must return the recorded result, not a new run');
    assert.equal(result2.idempotencyKey, result1.idempotencyKey);
    assert.deepEqual(second.classification, first.classification, 'classification must not change on replay');
    assert.deepEqual(second.trace?.id, first.trace?.id, 'no second agent_traces row');
    assert.deepEqual(second.audit?.id, first.audit?.id, 'no second audit_events row');
    assert.equal(second.messages.length, first.messages.length, 'no duplicated safety messages');
    assert.equal(counts?.classifications, 1, 'exactly one classification');
    assert.equal(counts?.traces, 1, 'exactly one agent_traces row');
    assert.equal(counts?.audits, 1, 'exactly one audit_events row');
    assert.equal(counts?.messages, 2, 'exactly two ticket_messages rows');
    assert.equal(counts?.tickets, baselineTickets + 1, 'only the fixture ticket was added');
    assert.equal(second.dispatchCount, 0, 'still no dispatch after replay');
    console.info('assertions (run 2): OK');

    banner('6/6 summary');
    console.info(`ticket:                ${ticketId}`);
    console.info(`classification id:     ${first.classification.id}`);
    console.info(`trace id:              ${first.trace.id}`);
    console.info(`audit id:              ${first.audit.id}`);
    console.info(`emergency flag:        ${String(first.ticketEmergencyFlag)}`);
    console.info(`severity / category:   ${first.classification.severity} / ${first.classification.category}`);
    console.info(`model severity:        ${first.classification.modelSeverity} (modelId ${String(first.classification.modelId)}, prompt ${String(first.classification.promptVersion)})`);
    console.info(`tokens / latency:      ${first.trace.totalTokens} / ${first.trace.totalLatencyMs} ms`);
    console.info(`handed off to human:   ${String(first.trace.handedOffToHuman)} — ${String(first.trace.handoffReason)}`);
    console.info(`proposals:             ${payloadParsed.proposals.map((p) => `${p.action}=${p.decision.allowed ? 'allowed' : `denied(${p.decision.reasons.join('|')})`}`).join(', ')}`);
    console.info(`dispatches / work orders: ${first.dispatchCount} / ${first.workOrderCount} (dry_run)`);
    console.info(`job latencies:         ${elapsed1} ms (first), replay returned the recorded result`);

    if (worker !== null) await worker.close();
    if (events !== null) await events.close();
    if (queue !== null) {
      await queue.remove(job1.id ?? '');
      await queue.remove(job2.id ?? '');
      await queue.close();
    }

    console.info('\nE2E PASSED');
  } finally {
    await client.end({ timeout: 5 });
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error('\nE2E FAILED');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  if (err instanceof Error && err.stack !== undefined) console.error(err.stack);
  process.exit(1);
}
