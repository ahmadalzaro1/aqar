// BullMQ wiring. The queue name comes from @aqar/contracts (single source of
// truth shared with apps/channels); the connection is parsed from REDIS_URL so
// no Redis default host/port is ever guessed at runtime.
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { TRIAGE_QUEUE_NAME, type TicketIngestJob, type TriageJobResult } from '@aqar/contracts';

export const TRIAGE_JOB_NAME = 'ticket.ingest';

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6380';

export function redisUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env['REDIS_URL'];
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_REDIS_URL;
}

/**
 * ioredis options parsed from a redis:// URL.
 *
 * `maxRetriesPerRequest: null` is mandatory for BullMQ workers: a blocking
 * connection must not abort a command after N retries.
 */
export function connectionOptions(url: string = redisUrl()): ConnectionOptions {
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
  return {
    host: parsed.hostname,
    port,
    ...(parsed.username !== '' ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password !== '' ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(db !== undefined ? { db } : {}),
    maxRetriesPerRequest: null,
  };
}

export function createTriageQueue(url: string = redisUrl()): Queue<unknown, TriageJobResult> {
  return new Queue<unknown, TriageJobResult>(TRIAGE_QUEUE_NAME, {
    connection: connectionOptions(url),
    defaultJobOptions: {
      // Retries are safe because every job carries an idempotencyKey and the
      // audit insert is unique on it; a redelivery never double-writes.
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 1_000 },
    },
  });
}

export type TriageJobProcessor = (job: Job<unknown, TriageJobResult>) => Promise<TriageJobResult>;

export function createTriageWorker(
  processor: TriageJobProcessor,
  options: { url?: string; concurrency?: number } = {},
): Worker<unknown, TriageJobResult> {
  const url = options.url ?? redisUrl();
  return new Worker<unknown, TriageJobResult>(TRIAGE_QUEUE_NAME, processor, {
    connection: connectionOptions(url),
    concurrency: options.concurrency ?? 2,
  });
}

/** Producer-side helper (mirrors what apps/channels will call). */
export async function enqueueTicketIngest(
  queue: Queue<unknown, TriageJobResult>,
  payload: TicketIngestJob,
): Promise<Job<unknown, TriageJobResult>> {
  return queue.add(TRIAGE_JOB_NAME, payload);
}
