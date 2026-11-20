import type { Queue } from 'bullmq';
import type { TicketIngestJob } from '@aqar/contracts';
import type { Config } from './env.js';
import type { Db, Organization } from './db.js';

/**
 * Everything a tool handler may touch. `org` is resolved once at startup from
 * configuration — never from tool arguments — so a prompt cannot switch tenants.
 *
 * `queue` is null when Redis is unreachable at boot. Tools that need it report
 * the degradation instead of pretending the work was dispatched.
 */
export interface ToolContext {
  readonly sql: Db;
  readonly org: Organization;
  readonly cfg: Config;
  readonly queue: Queue<TicketIngestJob> | null;
  /** Injected clock, so tests are deterministic. */
  readonly now: () => Date;
}

export function createContext(
  sql: Db,
  org: Organization,
  cfg: Config,
  queue: Queue<TicketIngestJob> | null,
): ToolContext {
  return { sql, org, cfg, queue, now: () => new Date() };
}
