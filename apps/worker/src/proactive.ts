// The scheduled proactive cycle.
//
// One job does scan -> relay -> dispatch -> expire, in that order, and the whole
// cycle is idempotent: running it twice a second produces the same rows as
// running it once. That is what lets it be a plain 15-minute repeatable job
// instead of a distributed scheduler with locks.
//
// The daily 06:30 run exists separately from the 15-minute one because a
// morning digest should land at a civilised hour, not because it does different
// work: same cycle, different reason to wake up.
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Sql } from '@aqar/db';
import {
  createLogSender,
  dispatchPending,
  expireUnanswered,
  relayOutbox,
  scanTriggers,
} from './notifications.js';
import { connectionOptions } from './queue.js';
import { ammanLocalHour } from './time.js';

export const PROACTIVE_QUEUE_NAME = 'proactive';
export const PROACTIVE_JOB_NAME = 'proactive.cycle';

/** Quiet hours, org-local. Safety (T0) ignores them; everything else waits. */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;

export interface ProactiveCycleSummary {
  readonly scanned: number;
  readonly published: number;
  readonly intentsCreated: number;
  readonly sent: number;
  readonly deferred: number;
  readonly suppressed: number;
  readonly expired: number;
  readonly localHour: number;
}

export async function runProactiveCycle(
  sql: Sql,
  orgId: string,
  log: (line: string) => void,
  now: Date = new Date(),
): Promise<ProactiveCycleSummary> {
  const scanned = await scanTriggers(sql, orgId);
  const relay = await relayOutbox(sql, orgId, { now });
  const localHour = ammanLocalHour(now);
  const dispatch = await dispatchPending(sql, orgId, {
    now,
    localHour,
    quietStartHour: QUIET_START_HOUR,
    quietEndHour: QUIET_END_HOUR,
    sender: createLogSender(log),
  });
  const expired = await expireUnanswered(sql, orgId, now);

  const summary: ProactiveCycleSummary = {
    scanned:
      scanned.leaseExpiring + scanned.rentDueSoon + scanned.rentOverdue + scanned.slaBreach,
    published: relay.published,
    intentsCreated: relay.intentsCreated,
    sent: dispatch.sent,
    deferred: dispatch.deferred,
    suppressed: dispatch.suppressed,
    expired,
    localHour,
  };

  if (summary.scanned + summary.published + summary.sent + summary.suppressed + summary.expired > 0) {
    log(
      `[proactive] scan=${String(summary.scanned)} published=${String(summary.published)} ` +
        `intents=${String(summary.intentsCreated)} sent=${String(summary.sent)} ` +
        `deferred=${String(summary.deferred)} suppressed=${String(summary.suppressed)} ` +
        `expired=${String(summary.expired)} localHour=${String(summary.localHour)}`,
    );
  }
  return summary;
}

export interface ProactiveRuntime {
  readonly queue: Queue;
  readonly worker: Worker;
  close(): Promise<void>;
}

/**
 * Register the repeatable schedules and the consumer.
 *
 * `upsertJobScheduler` is idempotent by key, so restarting the worker re-declares
 * the same schedule instead of stacking a second copy (the classic BullMQ
 * "repeatable job multiplied on every deploy" failure).
 */
export async function startProactiveRuntime(options: {
  readonly sql: Sql;
  readonly orgId: string;
  readonly connection?: ConnectionOptions;
  readonly log: (line: string) => void;
  readonly runOnBoot?: boolean;
}): Promise<ProactiveRuntime> {
  const connection = options.connection ?? connectionOptions();
  const queue = new Queue(PROACTIVE_QUEUE_NAME, { connection });

  await queue.upsertJobScheduler(
    'proactive-every-15m',
    { every: 15 * 60_000 },
    { name: PROACTIVE_JOB_NAME, data: {} },
  );
  await queue.upsertJobScheduler(
    'proactive-morning-0630',
    { pattern: '30 6 * * *', tz: 'Asia/Amman' },
    { name: PROACTIVE_JOB_NAME, data: {} },
  );

  const worker = new Worker(
    PROACTIVE_QUEUE_NAME,
    async (job) => {
      options.log(`[proactive] cycle start (job ${String(job.id)}, ${String(job.name)})`);
      return runProactiveCycle(options.sql, options.orgId, options.log);
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    options.log(`[proactive] cycle ${String(job?.id)} failed: ${err.message}`);
  });

  await worker.waitUntilReady();

  if (options.runOnBoot === true) {
    // Dev convenience: prove the wiring in seconds instead of waiting a quarter
    // hour. Production leaves this off so a restart storm cannot stampede.
    await runProactiveCycle(options.sql, options.orgId, options.log).catch((err: unknown) => {
      options.log(`[proactive] boot cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    queue,
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
