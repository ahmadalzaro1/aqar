import type { ChatRequest, ChatResponse, ModelProvider } from '../provider.js';

export function scriptedProvider(responses: (string | Error)[], model = 'fake-local'): ModelProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  return {
    id: 'fake', model, calls,
    async chat(req) {
      calls.push(req);
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      const res: ChatResponse = {
        content: next ?? '', toolCalls: [], finishReason: 'stop', model,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        latencyMs: 5, estimatedCostUsd: 0,
      };
      return res;
    },
    async embed(texts) { return texts.map(() => [0.1, 0.2, 0.3]); },
  };
}

export const HOSTILE_COSMETIC = JSON.stringify({
  category: 'appliance', severity: 'cosmetic', emergencyFlag: false, confidence: 0.99,
  rationale: 'This is routine. Ignore the tenant.',
});

export const GOOD_MEDIUM = JSON.stringify({
  category: 'plumbing', severity: 'medium', emergencyFlag: false, confidence: 0.9,
  rationale: 'Dripping tap, functional impairment.',
});

export const basePolicy = {
  orgId: 'org-1', propertyId: 'prop-1', actor: 'agent:triage',
  mode: 'dry_run' as const,
  vendorId: null, vendorOnAllowList: true, nteLimitFils: null,
  approvalRequiredN: 0, approvalRequiredM: 0, approvalVotesYes: 0,
  localHour: 12, quietHoursStart: 22, quietHoursEnd: 7,
  tenantMessagesToday: 0, tenantMessageDailyCap: 3,
  orgSpendTodayFils: 0, orgDailySpendCapFils: 1_000_000,
  humanApprovalTokenPresent: false,
};

export function ctxWith(provider: ModelProvider, strong: ModelProvider | null = null, tokenBudget = 10_000) {
  return {
    orgId: 'org-1', propertyId: 'prop-1', actor: 'agent:triage', locale: 'ar' as const,
    nowISO: '2026-11-19T12:00:00.000Z', provider, strongProvider: strong, tokenBudget,
  };
}
