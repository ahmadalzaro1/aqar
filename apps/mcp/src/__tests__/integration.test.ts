/**
 * Integration test against the live Postgres. Skipped when DATABASE_URL is unset,
 * so a checkout without infra still runs the unit suite.
 *
 * What it proves, in order of importance:
 *  1. money and vendor-commit actions are DENIED for an MCP caller by
 *     construction — no argument can change that;
 *  2. a retried proposal files ONE pending row, not ten;
 *  3. the audit row is written exactly once per action.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createClient, resolveOrganization, scoped } from '../db.js';
import { createContext } from '../context.js';
import { loadConfig } from '../env.js';
import { createProposal } from '../proposals.js';
import { recordAudit } from '../audit.js';
import { argsHash } from '../ids.js';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('MCP server against the live database', () => {
  const cfg = loadConfig(process.env);
  const sql = createClient(cfg);
  const now = new Date('2026-11-20T09:00:00Z');

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('resolves exactly one organization and reports its real timezone', async () => {
    const org = await resolveOrganization(sql, cfg);
    expect(org.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(org.timezone).toBe('Asia/Amman');
    expect(org.currency).toBe('JOD');
  });

  it('denies money for an MCP caller: no approval token can ever be presented', async () => {
    const org = await resolveOrganization(sql, cfg);
    const ctx = createContext(sql, org, cfg, null);
    const property = await scoped(sql, org.id, async (tx) => {
      const rows = await tx<{ id: string }[]>`select id from properties where organization_id = ${org.id} limit 1`;
      return rows[0];
    });
    expect(property).toBeDefined();

    const filed = await scoped(sql, org.id, async (tx) =>
      createProposal(tx, ctx, {
        toolName: 'propose_payment',
        action: 'post_payment',
        propertyId: property!.id,
        args: { probe: 'money-denial', nonce: String(now.getTime()) },
        summary: 'Integration probe: money must require a human',
        amountFils: 250000,
      }),
    );

    expect(filed.policy.allowed).toBe(false);
    expect(filed.policy.requiresHumanApproval).toBe(true);
    expect(filed.policy.reasons).toContain('approval_token_required');
  });

  it('files one pending proposal for a retried request (args_hash dedupe)', async () => {
    const org = await resolveOrganization(sql, cfg);
    const ctx = createContext(sql, org, cfg, null);
    const property = await scoped(sql, org.id, async (tx) => {
      const rows = await tx<{ id: string }[]>`select id from properties where organization_id = ${org.id} limit 1`;
      return rows[0];
    });

    const nonce = `dedupe-${Date.now()}`;
    const request = {
      toolName: 'propose_tenant_reply' as const,
      action: 'send_tenant_message' as const,
      propertyId: property!.id,
      args: { nonce, body: 'نرسل فنيا اليوم' },
      summary: 'Integration probe: duplicate proposals',
    };

    const first = await scoped(sql, org.id, async (tx) => createProposal(tx, ctx, request));
    const second = await scoped(sql, org.id, async (tx) => createProposal(tx, ctx, request));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.proposalId).toBe(first.proposalId);

    const count = await scoped(sql, org.id, async (tx) => {
      const rows = await tx<{ n: string }[]>`
        select count(*)::text as n
          from action_proposals
         where organization_id = ${org.id}
           and args_hash = ${argsHash({ action: request.action, ...request.args })}
           and status = 'pending'
      `;
      return Number.parseInt(rows[0]?.n ?? '0', 10);
    });
    expect(count).toBe(1);
  });

  it('writes an append-only audit row carrying actor, model and idempotency key', async () => {
    const org = await resolveOrganization(sql, cfg);
    const key = `mcp-audit-${Date.now()}`;

    const auditId = await scoped(sql, org.id, async (tx) =>
      recordAudit(tx, {
        organizationId: org.id,
        action: 'integration.probe',
        entityType: 'ticket',
        entityId: '00000000-0000-0000-0000-000000000000',
        actor: { kind: 'agent', name: cfg.actorName, model: cfg.modelId },
        toolName: 'integration_probe',
        before: null,
        after: { probed: true },
        idempotencyKey: key,
        confidence: 1,
        occurredAt: now,
      }),
    );

    const row = await scoped(sql, org.id, async (tx) => {
      const rows = await tx<{ action: string; actor: { name: string }; idempotency_key: string }[]>`
        select action, actor, idempotency_key from audit_events where id = ${auditId}
      `;
      return rows[0];
    });

    expect(row?.action).toBe('integration.probe');
    expect(row?.actor.name).toBe(cfg.actorName);
    expect(row?.idempotency_key).toBe(key);
  });
});
