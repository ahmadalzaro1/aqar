/**
 * Triage queue producer.
 *
 * The point of this file: a ticket filed through MCP must enter the *same*
 * pipeline as a WhatsApp message. Otherwise Hermes creates rows that nobody ever
 * classifies, and the ledger quietly fills with untriaged work.
 *
 * The job name and payload are contract-frozen in @aqar/contracts; the name
 * `ticket.ingest` matches apps/channels/src/app.ts (the worker registers its
 * processor on the queue, not on the job name).
 */
import { Queue, type ConnectionOptions } from 'bullmq';
import { TRIAGE_QUEUE_NAME, type TicketIngestJob } from '@aqar/contracts';

export const TRIAGE_JOB_NAME = 'ticket.ingest';

/** Same URL handling as apps/worker/src/queue.ts — one Redis, one convention. */
export function connectionOptions(url: string): ConnectionOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must use redis:// or rediss://, got ${parsed.protocol}`);
  }
  const portText = parsed.port;
  const port = portText === '' ? 6379 : Number(portText);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`REDIS_URL has an invalid port: ${portText}`);
  }
  const dbText = parsed.pathname.replace(/^\//, '');
  const db = dbText === '' ? undefined : Number(dbText);
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new Error(`REDIS_URL has an invalid database index: ${dbText}`);
  }
  const password = parsed.password === '' ? undefined : decodeURIComponent(parsed.password);
  const username = parsed.username === '' ? undefined : decodeURIComponent(parsed.username);

  return {
    host: parsed.hostname,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(db === undefined ? {} : { db }),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export function createTriageQueue(redisUrl: string): Queue<TicketIngestJob> {
  const queue = new Queue<TicketIngestJob>(TRIAGE_QUEUE_NAME, {
    connection: connectionOptions(redisUrl),
  });
  // An idle Redis outage must not crash the MCP server: the agent keeps its read
  // tools and simply reports that triage is unavailable.
  queue.on('error', (error: Error) => {
    console.error(`[aqar-mcp] triage queue error: ${error.message}`);
  });
  return queue;
}

export interface EnqueueOutcome {
  readonly enqueued: boolean;
  readonly error?: string;
}

export async function enqueueTriage(
  queue: Queue<TicketIngestJob>,
  payload: TicketIngestJob,
): Promise<EnqueueOutcome> {
  try {
    await queue.add(TRIAGE_JOB_NAME, payload, {
      // Same uuid as the ticket: BullMQ dedupe sits on top of the DB one.
      jobId: payload.ticketId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
    });
    return { enqueued: true };
  } catch (error) {
    return { enqueued: false, error: error instanceof Error ? error.message : String(error) };
  }
}
