// Worker bootstrap: one BullMQ consumer for the triage queue.
//
// Run: pnpm --filter @aqar/worker start   (or `tsx src/index.ts`)
// Env: DATABASE_URL (required, no placeholder fallback), REDIS_URL, LOCAL_*.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql } from '@aqar/db';
import { createProcessorDeps, processTriageJob } from './processor.js';
import type { TriageJobResult } from '@aqar/contracts';
import { createTriageQueue, createTriageWorker, TRIAGE_JOB_NAME } from './queue.js';
import { startProactiveRuntime, type ProactiveRuntime } from './proactive.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Dev convenience only: load the repo-root .env when nothing is exported. */
function loadRepoEnvIfUnset(): void {
  if (process.env['DATABASE_URL'] !== undefined) return;
  const candidate = resolve(HERE, '../../../.env');
  if (!existsSync(candidate)) return;
  process.loadEnvFile(candidate);
  console.info(`[worker] loaded environment from ${candidate}`);
}

function describeResult(ticketId: string, result: TriageJobResult): string {
  return [
    `ticket=${ticketId}`,
    `emergency=${result.emergencyFlag}`,
    `severity=${result.severity}`,
    `category=${result.category}`,
    `handoff=${result.handedOffToHuman}`,
    `proposals=${result.proposalCount}`,
    `trace=${result.traceId}`,
    `mode=dry_run`,
  ].join(' ');
}

async function main(): Promise<void> {
  loadRepoEnvIfUnset();

  const deps = createProcessorDeps();
  const queue = createTriageQueue();
  const worker = createTriageWorker(
    async (job) => {
      const result = await processTriageJob(job.data, deps);
      console.info(
        `[worker] completed job ${String(job.id)} ${describeResult(result.ticketId, result)}`,
      );
      return result;
    },
    { concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${String(job?.id)} failed: ${err.message}`);
  });
  worker.on('error', (err) => {
    console.error(`[worker] worker error: ${err.message}`);
  });

  await worker.waitUntilReady();
  console.info(`[worker] listening on ${TRIAGE_JOB_NAME} (concurrency 2)`);

  // The proactive engine needs an organization to scope to. Resolved once at
  // boot and never from a job payload, so a scheduler cannot be pointed at
  // another tenant.
  const sql = createSql(undefined, 6);
  const slug = process.env['AQAR_ORG_SLUG'] ?? 'aqar-demo';
  const orgs = await sql<{ id: string }[]>`select id from organizations where slug = ${slug}`;
  const org = orgs[0];
  if (org === undefined) {
    throw new Error(`AQAR_ORG_SLUG '${slug}' does not match any organization`);
  }

  let proactive: ProactiveRuntime | null = await startProactiveRuntime({
    sql,
    orgId: org.id,
    log: (line) => {
      console.info(line);
    },
    // Dev: prove the wiring immediately instead of waiting a quarter hour.
    runOnBoot: process.env['AQAR_PROACTIVE_RUN_ON_BOOT'] !== 'false',
  });
  console.info(`[worker] proactive schedules up for org ${slug}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[worker] ${signal} received — draining in-flight jobs`);
    try {
      await worker.close();
      await queue.close();
      if (proactive !== null) {
        await proactive.close();
        await sql.end({ timeout: 5 });
        proactive = null;
      }
      console.info('[worker] closed cleanly');
    } catch (err) {
      console.error(`[worker] shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

await main();
