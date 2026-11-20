/**
 * Database access for the MCP server.
 *
 * Two rules, both inherited from packages/db/src/client.ts:
 *   1. Every tenant query runs inside `scoped()`, which sets the
 *      `app.organization_id` GUC transaction-locally. Pooled connections never
 *      leak a tenant scope, and RLS fails closed when the GUC is unset.
 *   2. The organization id is resolved once at startup, never taken from a tool
 *      argument. A model cannot choose which tenant it is talking to.
 */
import { createSql, type Sql } from '@aqar/db';
import type { TransactionSql } from 'postgres';
import type { Config } from './env.js';
import { ToolError } from './errors.js';

export type Db = Sql;

export interface Organization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
}

export function createClient(config: Config): Db {
  return createSql(config.databaseUrl, 5);
}

/**
 * Runs `fn` in a transaction whose organization scope is set for its duration.
 * Equivalent to `withOrganization` in @aqar/db, adapted to the raw client so the
 * MCP server can issue plain SQL without ORM type gymnastics.
 */
export async function scoped<T>(
  sql: Db,
  organizationId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx);
  });
}

export async function resolveOrganization(sql: Db, config: Config): Promise<Organization> {
  interface Row {
    id: string;
    slug: string;
    name: string;
    timezone: string;
    currency: string;
  }

  if (config.organizationId !== undefined) {
    const rows = await sql<Row[]>`
      select id, slug, name, timezone, currency
        from organizations
       where id = ${config.organizationId}
       limit 1
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new ToolError(
        'org_not_found',
        `AQAR_ORG_ID ${config.organizationId} does not match any organization`,
        'Check AQAR_ORG_ID, or leave it unset and set AQAR_ORG_SLUG instead.',
      );
    }
    return row;
  }

  const bySlug = await sql<Row[]>`
    select id, slug, name, timezone, currency
      from organizations
     where slug = ${config.organizationSlug}
     limit 1
  `;
  const match = bySlug[0];
  if (match !== undefined) return match;

  // Single-tenant deployments (the dev fixture) need no configuration at all.
  const all = await sql<Row[]>`
    select id, slug, name, timezone, currency from organizations limit 2
  `;
  const only = all[0];
  if (only !== undefined && all.length === 1) return only;

  throw new ToolError(
    'org_ambiguous',
    `No organization with slug ${JSON.stringify(config.organizationSlug)}, and the database holds ${String(all.length)} organizations`,
    'Set AQAR_ORG_SLUG or AQAR_ORG_ID to pick one.',
  );
}
