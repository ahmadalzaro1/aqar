import { describe, expect, it } from 'vitest';
import { canWrite, loadConfig } from '../env.js';

describe('loadConfig', () => {
  it('defaults to propose — a fresh install can write reversible records but moves no money', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('propose');
    expect(canWrite(cfg.mode)).toBe(true);
  });

  it('defaults the local development conventions so Hermes needs almost no env', () => {
    const cfg = loadConfig({});
    expect(cfg.organizationSlug).toBe('aqar-demo');
    expect(cfg.actorName).toBe('hermes');
    expect(cfg.redisUrl).toBe('redis://127.0.0.1:6380');
    // Same numbers as apps/worker/src/processor.ts: quiet 22–07, 3 msgs/day, 2000 JOD.
    expect(cfg.quietHoursStart).toBe(22);
    expect(cfg.quietHoursEnd).toBe(7);
    expect(cfg.tenantMessageDailyCap).toBe(3);
    expect(cfg.orgDailySpendCapFils).toBe(2_000_000);
  });

  it('reads read_only and refuses writes in that mode', () => {
    const cfg = loadConfig({ AQAR_MCP_MODE: 'read_only' });
    expect(cfg.mode).toBe('read_only');
    expect(canWrite(cfg.mode)).toBe(false);
  });

  it('accepts live, which still cannot move money without a human approval token', () => {
    expect(loadConfig({ AQAR_MCP_MODE: 'live' }).mode).toBe('live');
  });

  it('rejects an unknown mode instead of silently falling back', () => {
    expect(() => loadConfig({ AQAR_MCP_MODE: 'writes' })).toThrow(/AQAR_MCP_MODE must be one of/);
  });

  it('rejects a non-integer cap instead of coercing it to zero', () => {
    expect(() => loadConfig({ AQAR_TENANT_MSG_CAP: 'three' })).toThrow(/must be an integer/);
  });

  it('honours explicit org identity and model id for the audit trail', () => {
    const cfg = loadConfig({
      AQAR_ORG_ID: 'b6f74d65-a498-5278-a74a-cea3018850ce',
      AQAR_ORG_SLUG: 'other-org',
      AQAR_MCP_ACTOR: 'hermes-desktop',
      AQAR_MCP_MODEL: 'deepseek-v4.1-flash',
    });
    expect(cfg.organizationId).toBe('b6f74d65-a498-5278-a74a-cea3018850ce');
    expect(cfg.organizationSlug).toBe('other-org');
    expect(cfg.actorName).toBe('hermes-desktop');
    expect(cfg.modelId).toBe('deepseek-v4.1-flash');
  });
});
