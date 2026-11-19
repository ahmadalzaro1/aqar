import { describe, expect, it } from 'vitest';
import { assertToolAllowed, toolsForRole, ToolDeniedError, TOOL_REGISTRY } from '../tools.js';

describe('tool registry — opt-in categories, fail-closed money gate', () => {
  it('classifier only sees m5 read tools', () => {
    const tools = toolsForRole('classifier');
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) { expect(t.category).toBe('m5'); expect(t.kind).toBe('read'); }
  });

  it('no role loads the whole registry', () => {
    for (const role of ['classifier', 'triage', 'leasing', 'collections', 'dispatcher', 'owner-accounting', 'compliance', 'reporting'] as const) {
      expect(toolsForRole(role).length).toBeLessThan(TOOL_REGISTRY.length);
    }
  });

  it('money tools require a human approval token even for permitted roles', () => {
    expect(() => assertToolAllowed('collections', 'post_payment', { humanApprovalTokenPresent: false })).toThrow(ToolDeniedError);
    expect(assertToolAllowed('collections', 'post_payment', { humanApprovalTokenPresent: true }).kind).toBe('money');
  });

  it('cross-role tool use is denied', () => {
    expect(() => assertToolAllowed('classifier', 'post_payment', { humanApprovalTokenPresent: true })).toThrow(/may not use/);
    expect(() => assertToolAllowed('reporting', 'dispatch_vendor', { humanApprovalTokenPresent: true })).toThrow(/may not use/);
  });

  it('unknown tools fail closed', () => {
    expect(() => assertToolAllowed('dispatcher', 'rm_rf', { humanApprovalTokenPresent: true })).toThrow(/unknown tool/);
  });

  it('owner-accounting can propose distributions but only with a token', () => {
    expect(() => assertToolAllowed('owner-accounting', 'propose_distribution', { humanApprovalTokenPresent: false })).toThrow(ToolDeniedError);
    expect(assertToolAllowed('owner-accounting', 'propose_distribution', { humanApprovalTokenPresent: true }).name).toBe('propose_distribution');
  });
});
