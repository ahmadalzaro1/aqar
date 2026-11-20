/**
 * Audit trail writer.
 *
 * LAW 3: every action is attributed and reversible. This is the only place the
 * MCP server writes `audit_events`, and it writes the same shape the worker does:
 * actor, before/after, model id, prompt version, tool call list, idempotency key.
 *
 * `audit_events` is append-only at the database level (the app role holds SELECT
 * and INSERT only), so there is deliberately no update or delete path here.
 */
import type { TransactionSql } from 'postgres';

export interface AuditActor {
  readonly kind: 'agent' | 'user' | 'system';
  readonly name: string;
  readonly model: string | undefined;
}

export interface AuditEntry {
  readonly organizationId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actor: AuditActor;
  readonly toolName: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly idempotencyKey?: string;
  readonly confidence?: number;
  readonly occurredAt: Date;
}

export async function recordAudit(tx: TransactionSql, entry: AuditEntry): Promise<string> {
  const actor = {
    kind: entry.actor.kind,
    name: entry.actor.name,
    ...(entry.actor.model === undefined ? {} : { model: entry.actor.model }),
  };
  const toolCalls = [{ tool: entry.toolName, at: entry.occurredAt.toISOString() }];

  const rows = await tx<{ id: string }[]>`
    insert into audit_events (
      organization_id, actor, action, entity_type, entity_id,
      before, after, model_id, prompt_version, confidence,
      tool_calls, idempotency_key, occurred_at
    ) values (
      ${entry.organizationId},
      ${tx.json(actor)},
      ${entry.action},
      ${entry.entityType},
      ${entry.entityId},
      ${entry.before === undefined ? null : tx.json(entry.before)},
      ${entry.after === undefined ? null : tx.json(entry.after)},
      ${entry.actor.model ?? null},
      ${'mcp@0.1.0'},
      ${entry.confidence ?? null},
      ${tx.json(toolCalls)},
      ${entry.idempotencyKey ?? null},
      ${entry.occurredAt}
    )
    returning id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('audit insert returned no row');
  return row.id;
}
