// Offline unit tests for the triage job processor. Every dependency is
// injected — no Postgres, no Redis, no model. These prove the consumer's
// contract: parse-don't-coerce, idempotent redelivery, dry_run hardwired,
// org scoping, and the LAW-2 emergency floor surviving the job boundary.
import { describe, expect, it, vi } from 'vitest';
import {
  triageJobResultSchema,
  type MergedClassification,
  type TriageJobResult,
} from '@aqar/contracts';
import type { ModelProvider, TriageInput, TriageResult } from '@aqar/agents';
import {
  buildTriageInput,
  JobValidationError,
  processTriageJob,
  TicketNotFoundError,
  TRIAGE_ACTOR,
  type ProcessorDeps,
} from '../processor.js';
import type {
  PersistTriageInput,
  PersistTriageOutcome,
  TicketRecord,
  TriageStore,
} from '../store.js';
import { ammanLocalHour } from '../time.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';
const PROPERTY = '55555555-5555-4555-8555-555555555555';
const TENANT = '66666666-6666-4666-8666-666666666666';
const KEY = 'wa:msg-000001';
const NOW = '2026-11-19T21:00:00.000Z'; // 00:00 in Amman (UTC+3)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const job = {
  ticketId: TICKET,
  orgId: ORG,
  channel: 'whatsapp' as const,
  text: 'ريحة غاز قوية بالمطبخ',
  locale: 'ar' as const,
  tenantId: TENANT,
  idempotencyKey: KEY,
};

/** Offline stub: the fake triage fn never calls a model, so these must never run. */
const offlineProvider: ModelProvider = {
  id: 'offline-stub',
  model: 'none',
  chat: () => Promise.reject(new Error('offline test: provider.chat must not be called')),
  embed: () => Promise.reject(new Error('offline test: provider.embed must not be called')),
};

function ticketRecord(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: TICKET,
    organizationId: ORG,
    propertyId: PROPERTY,
    tenantId: TENANT,
    channel: 'whatsapp',
    body: job.text,
    bodyLocale: 'ar',
    emergencyFlag: false,
    ...overrides,
  };
}

function merged(overrides: Partial<MergedClassification> = {}): MergedClassification {
  return {
    category: 'gas',
    severity: 'emergency',
    emergencyFlag: true,
    confidence: 0.97,
    rationale: 'gas odor reported',
    deterministicEmergency: true,
    modelSeverity: 'emergency',
    modelEmergencyFlag: true,
    ...overrides,
  };
}

function triageResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    ticketId: TICKET,
    merged: merged(),
    safetyInstructions: { ar: 'أغلق المحبس وافتح النوافذ', en: 'Shut the valve, open windows' },
    proposals: [],
    steps: [],
    handedOffToHuman: true,
    handoffReason: 'emergency',
    tokensUsed: 120,
    totalLatencyMs: 900,
    estimatedCostUsd: 0,
    routedToStrongModel: false,
    ...overrides,
  };
}

interface FakeStore extends TriageStore {
  calls: { prior: number; load: number; persist: number };
  lastPersist: PersistTriageInput | null;
}

function fakeStore(
  opts: {
    prior?: TriageJobResult | null;
    ticket?: TicketRecord | null;
    outcome?: PersistTriageOutcome;
  } = {},
): FakeStore {
  const store: FakeStore = {
    calls: { prior: 0, load: 0, persist: 0 },
    lastPersist: null,
    async findPriorResult() {
      store.calls.prior += 1;
      return opts.prior ?? null;
    },
    async loadTicket() {
      store.calls.load += 1;
      return opts.ticket === undefined ? ticketRecord() : opts.ticket;
    },
    async persist(input) {
      store.calls.persist += 1;
      store.lastPersist = input;
      // Like the real store: the persisted jobResult is what comes back.
      return opts.outcome ?? { result: input.jobResult, deduped: false };
    },
  };
  return store;
}

function deps(store: TriageStore, triage: ProcessorDeps['triage']): ProcessorDeps {
  return {
    store,
    now: () => new Date(NOW),
    providers: { local: offlineProvider, strong: null },
    triage,
    tokenBudget: 100_000,
  };
}

describe('processTriageJob — payload contract', () => {
  it('rejects a malformed payload without touching the store', async () => {
    const store = fakeStore();
    const triage = vi.fn();
    await expect(
      processTriageJob({ ticketId: 'not-a-uuid' }, deps(store, triage)),
    ).rejects.toBeInstanceOf(JobValidationError);
    expect(store.calls).toEqual({ prior: 0, load: 0, persist: 0 });
    expect(triage).not.toHaveBeenCalled();
  });

  it('rejects a payload missing the idempotency key', async () => {
    const rest: Record<string, unknown> = { ...job };
    delete rest['idempotencyKey'];
    const store = fakeStore();
    await expect(processTriageJob(rest, deps(store, vi.fn()))).rejects.toBeInstanceOf(
      JobValidationError,
    );
    expect(store.calls.persist).toBe(0);
  });

  it('rejects an unknown channel instead of coercing it', async () => {
    const store = fakeStore();
    await expect(
      processTriageJob({ ...job, channel: 'sms' }, deps(store, vi.fn())),
    ).rejects.toBeInstanceOf(JobValidationError);
  });
});

describe('processTriageJob — scoping and existence', () => {
  it('throws TicketNotFoundError when the ticket does not exist', async () => {
    const store = fakeStore({ ticket: null });
    await expect(processTriageJob(job, deps(store, vi.fn()))).rejects.toBeInstanceOf(
      TicketNotFoundError,
    );
    expect(store.calls.persist).toBe(0);
  });

  it('refuses a ticket that belongs to another organization', async () => {
    const store = fakeStore({ ticket: ticketRecord({ organizationId: OTHER_ORG }) });
    await expect(processTriageJob(job, deps(store, vi.fn()))).rejects.toBeInstanceOf(
      TicketNotFoundError,
    );
    expect(store.calls.persist).toBe(0);
  });
});

describe('processTriageJob — idempotency', () => {
  it('returns the prior result on redelivery without re-running triage', async () => {
    const prior: TriageJobResult = {
      ticketId: TICKET,
      emergencyFlag: true,
      severity: 'emergency',
      category: 'gas',
      handedOffToHuman: true,
      traceId: '77777777-7777-4777-8777-777777777777',
      proposalCount: 2,
      idempotencyKey: KEY,
    };
    const store = fakeStore({ prior });
    const triage = vi.fn();
    const out = await processTriageJob(job, deps(store, triage));
    expect(out).toEqual(prior);
    expect(triage).not.toHaveBeenCalled();
    expect(store.calls.persist).toBe(0);
  });

  it('returns the concurrent winner when persist reports a dedupe race', async () => {
    const winner: TriageJobResult = {
      ticketId: TICKET,
      emergencyFlag: true,
      severity: 'emergency',
      category: 'gas',
      handedOffToHuman: true,
      traceId: '77777777-7777-4777-8777-777777777777',
      proposalCount: 1,
      idempotencyKey: KEY,
    };
    const store = fakeStore({ outcome: { result: winner, deduped: true } });
    const out = await processTriageJob(
      job,
      deps(store, async () => triageResult()),
    );
    expect(out).toEqual(winner);
    expect(store.calls.persist).toBe(1);
  });
});

describe('processTriageJob — execution contract', () => {
  it('runs triage once in dry_run with the orchestrator actor and persists one result', async () => {
    const store = fakeStore();
    const inputs: TriageInput[] = [];
    const triage: ProcessorDeps['triage'] = async (input) => {
      inputs.push(input);
      return triageResult();
    };
    const out = await processTriageJob(job, deps(store, triage));
    expect(triageJobResultSchema.safeParse(out).success).toBe(true);
    expect(out.traceId).toMatch(UUID_RE);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.policyBase.mode).toBe('dry_run');
    expect(inputs[0]?.policyBase.actor).toBe(TRIAGE_ACTOR);
    expect(inputs[0]?.ticketId).toBe(TICKET);
    expect(store.calls.persist).toBe(1);
    expect(store.lastPersist?.jobResult.idempotencyKey).toBe(KEY);
    expect(store.lastPersist?.traceId).toBe(out.traceId);
    expect(store.lastPersist?.nowISO).toBe(NOW);
  });

  it('carries the stored emergency flag into triage as priorEmergency', async () => {
    const store = fakeStore({ ticket: ticketRecord({ emergencyFlag: true }) });
    const inputs: TriageInput[] = [];
    await processTriageJob(
      job,
      deps(store, async (input) => {
        inputs.push(input);
        return triageResult();
      }),
    );
    expect(inputs[0]?.priorEmergency).toBe(true);
  });

  it('LAW-2 floor: a model-raised emergency survives the job boundary', async () => {
    // Ticket not yet flagged; the merged classification says emergency.
    const store = fakeStore({ ticket: ticketRecord({ emergencyFlag: false }) });
    const out = await processTriageJob(
      job,
      deps(store, async () =>
        triageResult({
          merged: merged({ deterministicEmergency: false, modelEmergencyFlag: true }),
        }),
      ),
    );
    expect(out.emergencyFlag).toBe(true);
    expect(out.severity).toBe('emergency');
    expect(store.lastPersist?.jobResult.emergencyFlag).toBe(true);
  });

  it('counts proposals from the orchestrator output', async () => {
    const store = fakeStore();
    const out = await processTriageJob(
      job,
      deps(store, async () =>
        triageResult({
          proposals: [
            {
              action: 'dispatch_vendor',
              decision: { allowed: false, requiresHumanApproval: true, reasons: ['dry_run'] },
            },
          ],
        }),
      ),
    );
    expect(out.proposalCount).toBe(1);
  });
});

describe('buildTriageInput + Amman clock', () => {
  it('hardwires dry_run regardless of job content', () => {
    const input = buildTriageInput(job, ticketRecord(), new Date(NOW));
    expect(input.policyBase.mode).toBe('dry_run');
    expect(input.policyBase.actor).toBe(TRIAGE_ACTOR);
    expect(input.policyBase.localHour).toBe(0); // 21:00Z == 00:00 Amman
  });

  it('converts UTC instants to Asia/Amman local hours', () => {
    expect(ammanLocalHour(new Date('2026-11-19T21:00:00Z'))).toBe(0);
    expect(ammanLocalHour(new Date('2026-11-19T09:00:00Z'))).toBe(12);
    expect(ammanLocalHour(new Date('2026-11-19T20:59:00Z'))).toBe(23);
  });
});
