/**
 * MCP server configuration.
 *
 * Everything is read from the environment so Hermes (or any other MCP client)
 * can launch this process with no arguments. Nothing secret is baked in.
 *
 * Mode ladder — the important design choice:
 *   read_only : no writes at all. Safe for a chat client that only asks questions.
 *   propose   : (default) reads + reversible records (tickets, messages, promises)
 *               and *proposals* for money/vendor actions. Nothing moves.
 *   live      : same as propose. It does NOT unlock money: a live policy still
 *               requires a human approval token, and an MCP caller can never
 *               present one. Money execution lives in the server job, not here.
 */
export type McpMode = 'read_only' | 'propose' | 'live';

const MODES: readonly McpMode[] = ['read_only', 'propose', 'live'];

export interface Config {
  readonly databaseUrl: string | undefined;
  /** Redis for the shared triage queue; defaults to the local compose port. */
  readonly redisUrl: string;
  /** Explicit org id wins; otherwise the slug is resolved; otherwise a lone org is used. */
  readonly organizationId: string | undefined;
  readonly organizationSlug: string;
  /** Recorded in audit_events.actor — who the agent is, never a guess. */
  readonly actorName: string;
  /** Recorded in audit_events.model_id. */
  readonly modelId: string;
  readonly mode: McpMode;
  readonly quietHoursStart: number;
  readonly quietHoursEnd: number;
  readonly tenantMessageDailyCap: number;
  readonly orgDailySpendCapFils: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawMode = (env['AQAR_MCP_MODE'] ?? 'propose').trim();
  const mode = MODES.find((candidate) => candidate === rawMode);
  if (mode === undefined) {
    throw new Error(
      `AQAR_MCP_MODE must be one of ${MODES.join(' | ')}, got ${JSON.stringify(rawMode)}`,
    );
  }
  return {
    databaseUrl: env['DATABASE_URL'],
    redisUrl: env['REDIS_URL'] ?? 'redis://127.0.0.1:6380',
    organizationId: env['AQAR_ORG_ID'],
    organizationSlug: env['AQAR_ORG_SLUG'] ?? 'aqar-demo',
    actorName: env['AQAR_MCP_ACTOR'] ?? 'hermes',
    modelId: env['AQAR_MCP_MODEL'] ?? 'unknown',
    mode,
    // Mirrors apps/worker/src/processor.ts so one mental model covers both.
    quietHoursStart: intFromEnv(env, 'AQAR_QUIET_START', 22),
    quietHoursEnd: intFromEnv(env, 'AQAR_QUIET_END', 7),
    tenantMessageDailyCap: intFromEnv(env, 'AQAR_TENANT_MSG_CAP', 3),
    orgDailySpendCapFils: intFromEnv(env, 'AQAR_ORG_SPEND_CAP_FILS', 2_000_000),
  };
}

export function canWrite(mode: McpMode): boolean {
  return mode !== 'read_only';
}
