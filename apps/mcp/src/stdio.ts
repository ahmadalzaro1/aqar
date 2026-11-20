/**
 * stdio entry point — the transport Hermes and Claude Desktop use.
 *
 * stdout belongs to the protocol. Diagnostics go to stderr only; a stray
 * console.log here corrupts the JSON-RPC stream and the client sees a hung
 * server rather than an error.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Queue } from 'bullmq';
import type { TicketIngestJob } from '@aqar/contracts';
import { createClient, resolveOrganization } from './db.js';
import { createContext } from './context.js';
import { loadConfig } from './env.js';
import { createTriageQueue } from './queue.js';
import { buildServer } from './server.js';

const config = loadConfig();
const sql = createClient(config);
const organization = await resolveOrganization(sql, config);

/**
 * Redis is optional at boot: read tools keep working during an outage, and the
 * ticket tool reports `triageEnqueued: false` rather than silently dropping the
 * job. A failure here is loud on stderr but never fatal.
 */
let queue: Queue<TicketIngestJob> | null = null;
try {
  queue = createTriageQueue(config.redisUrl);
} catch (error) {
  console.error(
    `[aqar-mcp] triage queue unavailable (${error instanceof Error ? error.message : String(error)}); tickets will be stored but not triaged`,
  );
}

const ctx = createContext(sql, organization, config, queue);
const server = buildServer(ctx);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[aqar-mcp] ready org=${organization.slug} (${organization.id}) mode=${config.mode} actor=${config.actorName} triage=${queue === null ? 'off' : config.redisUrl}`,
);

async function shutdown(signal: string): Promise<void> {
  console.error(`[aqar-mcp] ${signal} received, closing`);
  await server.close();
  if (queue !== null) await queue.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
