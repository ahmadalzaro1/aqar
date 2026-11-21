import type { Sql } from '@aqar/db';

/** The organization a tool is allowed to see. Resolved once at boot, never from arguments. */
export interface OrganizationRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
}

/**
 * The policy snapshot an adapter resolved at boot. Data, not a server config
 * object: only the values a read tool reports verbatim (`aqar_context`), so the
 * core still knows nothing about transports, queues or environment parsing.
 */
export interface ToolPolicy {
  /** Who the agent is acting as; recorded in audit_events.actor. */
  readonly actor: string;
  /** read_only | propose | live. */
  readonly mode: string;
  readonly quietHoursStart: number;
  readonly quietHoursEnd: number;
  readonly tenantMessageDailyCap: number;
  readonly orgDailySpendCapFils: number;
}

/**
 * Everything a tool handler may touch. Deliberately smaller than the MCP
 * server's own context: the tool core must not depend on a transport, a queue,
 * or a server configuration object.
 */
export interface ToolContext {
  readonly sql: Sql;
  readonly org: OrganizationRef;
  /** Injected clock, so tests are deterministic. */
  readonly now: () => Date;
  /**
   * Present when the adapter resolved a policy snapshot. `aqar_context` cannot
   * report the limits in force without it and fails loudly rather than inventing
   * them.
   */
  readonly policy?: ToolPolicy;
}
