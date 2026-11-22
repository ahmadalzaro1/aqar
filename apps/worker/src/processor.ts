// Triage job processor.
//
// One job = one ticket ingest event. Laws honoured here:
//  - payloads are parsed, never coerced: an invalid job is rejected before any
//    DB or model work happens;
//  - idempotency: a redelivery returns the recorded result and writes nothing;
//  - dry_run: the agent only ever *proposes*; the worker executes no vendor
//    dispatch and moves no money;
//  - attribution: every write carries actor 'agent:triage' plus the job's
//    idempotencyKey in audit_events.
import { randomUUID } from 'node:crypto';
import { providersFromEnv, runTriage, type ModelProvider, type TriageResult } from '@aqar/agents';
import {
  triageJobResultSchema,
  ticketIngestJobSchema,
  type TicketIngestJob,
  type TriageJobResult,
} from '@aqar/contracts';
import type { AgentContext } from '@aqar/agents';
import type { TriageInput } from '@aqar/agents';
import { createDb, type Db } from '@aqar/db';
import {
  createDrizzleTriageStore,
  TRIAGE_ACTOR,
  type TicketRecord,
  type TriageStore,
} from './store.js';
import { ammanLocalHour } from './time.js';

export { TRIAGE_ACTOR };

/** Raised when the payload does not satisfy ticketIngestJobSchema. */
export class JobValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid triage job payload: ${issues.join('; ')}`);
    this.name = 'JobValidationError';
  }
}

/** Raised when the ticket does not exist inside the job's organization. */
export class TicketNotFoundError extends Error {
  constructor(
    readonly ticketId: string,
    readonly orgId: string,
  ) {
    super(`ticket ${ticketId} not found in organization ${orgId}`);
    this.name = 'TicketNotFoundError';
  }
}

/** Org-wide daily spend ceiling used for the policy inputs (2,000 JOD). */
export const ORG_DAILY_SPEND_CAP_FILS = 2_000_000;
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 7;
export const TENANT_MESSAGE_DAILY_CAP = 3;
export const DEFAULT_TOKEN_BUDGET = 100_000;

export interface TriageProviders {
  local: ModelProvider;
  strong: ModelProvider | null;
}

export type TriageFn = (input: TriageInput, ctx: AgentContext) => Promise<TriageResult>;

/** Everything the processor needs. Fully injected: no hidden globals. */
export interface ProcessorDeps {
  readonly store: TriageStore;
  /** Injected clock — the only source of "now" for this process. */
  readonly now: () => Date;
  readonly providers: TriageProviders;
  readonly triage: TriageFn;
  readonly tokenBudget: number;
}

export interface ProcessorDepsOptions {
  env?: Record<string, string | undefined>;
  db?: Db;
  store?: TriageStore;
  now?: () => Date;
  providers?: TriageProviders;
  triage?: TriageFn;
  tokenBudget?: number;
}

function openDbFromEnv(env: Record<string, string | undefined>): Db {
  const url = env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    throw new Error(
      'DATABASE_URL is required: @aqar/db DEFAULT_DATABASE_URL carries a placeholder password, so the worker never falls back to it',
    );
  }
  return createDb(url).db;
}

export function createProcessorDeps(options: ProcessorDepsOptions = {}): ProcessorDeps {
  const env = options.env ?? process.env;
  const store = options.store ?? createDrizzleTriageStore(options.db ?? openDbFromEnv(env));
  return {
    store,
    now: options.now ?? (() => new Date()),
    providers: options.providers ?? providersFromEnv(env),
    triage: options.triage ?? runTriage,
    tokenBudget: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
  };
}

/**
 * Build the orchestrator input from the job + the stored ticket.
 *
 * mode is hard-wired to 'dry_run': nothing in this worker can dispatch a vendor
 * or move money, whatever the payload says.
 */
export function buildTriageInput(
  job: TicketIngestJob,
  ticket: TicketRecord,
  now: Date,
): TriageInput {
  return {
    ticketId: job.ticketId,
    text: job.text,
    locale: job.locale,
    priorEmergency: ticket.emergencyFlag,
    policyBase: {
      orgId: job.orgId,
      propertyId: ticket.propertyId,
      actor: TRIAGE_ACTOR,
      mode: 'dry_run',
      vendorId: null,
      vendorOnAllowList: false,
      nteLimitFils: null,
      approvalRequiredN: 0,
      approvalRequiredM: 0,
      approvalVotesYes: 0,
      localHour: ammanLocalHour(now),
      quietHoursStart: QUIET_HOURS_START,
      quietHoursEnd: QUIET_HOURS_END,
      tenantMessagesToday: 0,
      tenantMessageDailyCap: TENANT_MESSAGE_DAILY_CAP,
      orgSpendTodayFils: 0,
      orgDailySpendCapFils: ORG_DAILY_SPEND_CAP_FILS,
      humanApprovalTokenPresent: false,
    },
  };
}

function parseJob(raw: unknown): TicketIngestJob {
  const parsed = ticketIngestJobSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JobValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * Process one triage job. Returns the persisted result; throws on invalid
 * payloads and on unresolvable tickets (BullMQ then retries / marks it failed).
 */
export async function processTriageJob(
  raw: unknown,
  deps: ProcessorDeps,
): Promise<TriageJobResult> {
  const job = parseJob(raw);

  // (1) Idempotency pre-check: a redelivery never re-runs the model.
  const prior = await deps.store.findPriorResult(job.orgId, job.idempotencyKey);
  if (prior !== null) {
    return triageJobResultSchema.parse(prior);
  }

  // (2) Load the ticket inside the organization's RLS scope.
  const ticket = await deps.store.loadTicket(job.orgId, job.ticketId);
  if (ticket === null) {
    throw new TicketNotFoundError(job.ticketId, job.orgId);
  }
  if (ticket.organizationId !== job.orgId) {
    // Defensive: RLS should make this unreachable.
    throw new TicketNotFoundError(job.ticketId, job.orgId);
  }

  // (3) Run the deterministic-first pipeline.
  const now = deps.now();
  const nowISO = now.toISOString();
  const input = buildTriageInput(job, ticket, now);
  const ctx: AgentContext = {
    orgId: job.orgId,
    propertyId: ticket.propertyId,
    actor: TRIAGE_ACTOR,
    locale: job.locale,
    nowISO,
    provider: deps.providers.local,
    strongProvider: deps.providers.strong,
    tokenBudget: deps.tokenBudget,
  };
  const result = await deps.triage(input, ctx);

  const traceId = randomUUID();
  const jobResult = triageJobResultSchema.parse({
    ticketId: job.ticketId,
    emergencyFlag: result.merged.emergencyFlag,
    severity: result.merged.severity,
    category: result.merged.category,
    handedOffToHuman: result.handedOffToHuman,
    traceId,
    proposalCount: result.proposals.length,
    idempotencyKey: job.idempotencyKey,
  });

  // (4) One transaction: classification + trace + audit + safety messages +
  //     sticky flag. A racing duplicate loses on the unique audit key and we
  //     return its result instead (deduped: true).
  const outcome = await deps.store.persist({ job, ticket, result, jobResult, traceId, nowISO });
  return outcome.result;
}
