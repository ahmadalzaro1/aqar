// Explicit typed sequential pipeline (brief §3). No free-form agent loop.
// Every step is schema-validated; failures escalate to a human. LAW 2: the
// deterministic pre-check is OR-merged with the model and is sticky.
import { z } from 'zod';
import { mergeClassification, hazardSignalCategory, evaluatePolicy, safetyInstructions } from '@aqar/core';
import {
  mergedClassificationSchema,
  type Classification, type MergedClassification, type PolicyDecision, type PolicyInput,
} from '@aqar/contracts';
import { precheckAgent } from './agents/precheck.js';
import { classifierAgent } from './agents/classifier.js';
import { EscalationError, type AgentContext, type StepTrace } from './types.js';
import { sha256 } from './hashing.js';

export const triageInputSchema = z.object({
  ticketId: z.string().min(1),
  text: z.string().min(1),
  locale: z.enum(['ar', 'en']),
  priorEmergency: z.boolean().default(false),
  /** Everything the policy gate needs except action/amount (set per proposal). */
  policyBase: z.object({
    orgId: z.string(), propertyId: z.string(), actor: z.string(),
    mode: z.enum(['dry_run', 'live']),
    vendorId: z.string().nullable(), vendorOnAllowList: z.boolean(),
    nteLimitFils: z.number().int().nonnegative().nullable(),
    approvalRequiredN: z.number().int().nonnegative(), approvalRequiredM: z.number().int().nonnegative(),
    approvalVotesYes: z.number().int().nonnegative(),
    localHour: z.number().int().min(0).max(23),
    quietHoursStart: z.number().int().min(0).max(23), quietHoursEnd: z.number().int().min(0).max(23),
    tenantMessagesToday: z.number().int().nonnegative(), tenantMessageDailyCap: z.number().int().nonnegative(),
    orgSpendTodayFils: z.number().int().nonnegative(), orgDailySpendCapFils: z.number().int().nonnegative(),
    humanApprovalTokenPresent: z.boolean(),
  }),
});
export type TriageInput = z.infer<typeof triageInputSchema>;

export interface TriageResult {
  ticketId: string;
  merged: MergedClassification;
  safetyInstructions: { ar: string; en: string } | null;
  proposals: { action: PolicyInput['action']; decision: PolicyDecision }[];
  steps: StepTrace[];
  handedOffToHuman: boolean;
  handoffReason: string | null;
  tokensUsed: number;
  totalLatencyMs: number;
  estimatedCostUsd: number;
  routedToStrongModel: boolean;
}

function fallbackClassification(text: string, emergency: boolean, signals: string[]): Classification {
  const hazardCategory = signals.map((s) => hazardSignalCategory(s)).find((c) => c !== undefined);
  return {
    category: hazardCategory ?? 'other',
    severity: emergency ? 'emergency' : 'medium',
    emergencyFlag: emergency,
    confidence: 0,
    rationale: `Model unavailable or invalid; deterministic pre-check only. Human review required. Text hash ${sha256(text).slice(0, 12)}.`,
  };
}

export async function runTriage(input: TriageInput, ctx: AgentContext): Promise<TriageResult> {
  const parsed = triageInputSchema.parse(input);
  const steps: StepTrace[] = [];
  let tokensUsed = 0;
  let totalLatencyMs = 0;
  let estimatedCostUsd = 0;
  let handedOff = false;
  let handoffReason: string | null = null;
  let routedToStrong = false;

  const account = (trace: StepTrace): void => {
    steps.push(trace);
    tokensUsed += trace.tokens;
    totalLatencyMs += trace.latencyMs;
    estimatedCostUsd += trace.estimatedCostUsd;
  };

  // 1. Deterministic pre-check — always runs, never skipped.
  const pre = await precheckAgent.run({ text: parsed.text }, ctx);
  account(pre.trace);

  // 2. Model classification (cheap/local first). Failure ⇒ deterministic
  //    fallback + human handoff; the emergency floor still holds.
  let modelClassification: Classification | null = null;
  let schemaFailedOnce = false;
  try {
    const cls = await classifierAgent.run({ text: parsed.text, locale: parsed.locale }, ctx);
    modelClassification = cls.output;
    account(cls.trace);
  } catch (err) {
    const reason = err instanceof EscalationError ? err.reason : 'provider';
    if (reason === 'schema') schemaFailedOnce = true;
    handedOff = true;
    handoffReason = `classifier escalated (${reason}): ${err instanceof Error ? err.message : String(err)}`;
    modelClassification = fallbackClassification(parsed.text, pre.output.emergency, pre.output.signals);
    steps.push({
      step: 'classify-fallback', agent: 'orchestrator', promptVersion: 'det-1.0.0',
      model: null, promptHash: null, inputHash: sha256(parsed.text),
      outputHash: sha256(JSON.stringify(modelClassification)),
      tokens: 0, latencyMs: 0, estimatedCostUsd: 0, confidence: 0, ok: false, detail: handoffReason,
    });
  }

  // 3. LAW-2 merge: emergency = deterministic || model || prior. Sticky.
  let merged = mergedClassificationSchema.parse(
    mergeClassification(pre.output, modelClassification, parsed.priorEmergency),
  );
  steps.push({
    step: 'merge', agent: 'orchestrator', promptVersion: 'det-1.0.0', model: null, promptHash: null,
    inputHash: sha256(JSON.stringify({ pre: pre.output, model: modelClassification })),
    outputHash: sha256(JSON.stringify(merged)),
    tokens: 0, latencyMs: 0, estimatedCostUsd: 0, confidence: merged.confidence, ok: true,
    detail: `emergency=${merged.emergencyFlag} (deterministic=${merged.deterministicEmergency}, model=${merged.modelEmergencyFlag}, prior=${parsed.priorEmergency})`,
  });

  // 4. Cost routing: escalate to the stronger model when confidence < 0.7 OR
  //    severity >= high OR schema failed once. No strong model configured ⇒
  //    human handoff (never silent truncation).
  const needsStrong = merged.confidence < 0.7 || merged.severity === 'emergency' || merged.severity === 'high' || schemaFailedOnce;
  if (needsStrong && modelClassification !== null && !handedOff) {
    if (ctx.strongProvider !== null) {
      try {
        const strongCtx: AgentContext = { ...ctx, provider: ctx.strongProvider };
        const cls = await classifierAgent.run({ text: parsed.text, locale: parsed.locale }, strongCtx);
        account({ ...cls.trace, step: 'classify-strong', detail: `cost routing: ${cls.trace.detail}` });
        routedToStrong = true;
        merged = mergedClassificationSchema.parse(mergeClassification(pre.output, cls.output, parsed.priorEmergency || merged.emergencyFlag));
      } catch (err) {
        handedOff = true;
        handoffReason = `strong model escalation failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      handedOff = true;
      handoffReason = 'cost routing requires a stronger model (confidence < 0.7 or severity >= high or schema retry); CLOUD_BASE_URL not configured — human review';
    }
  }

  // 5. Token budget — over budget is a human handoff, not silent truncation.
  if (tokensUsed > ctx.tokenBudget) {
    handedOff = true;
    handoffReason = `token budget exceeded: ${tokensUsed} > ${ctx.tokenBudget}`;
  }

  // 6. Policy gate on PROPOSED actions. The orchestrator never executes writes.
  const base = parsed.policyBase;
  const proposals: TriageResult['proposals'] = [];
  const propose = (action: PolicyInput['action'], amountFils: number | null): void => {
    const decision = evaluatePolicy({ ...base, action, amountFils });
    proposals.push({ action, decision });
    steps.push({
      step: `policy:${action}`, agent: 'policy-engine', promptVersion: 'det-1.0.0', model: null, promptHash: null,
      inputHash: sha256(JSON.stringify({ ...base, action, amountFils })),
      outputHash: sha256(JSON.stringify(decision)),
      tokens: 0, latencyMs: 0, estimatedCostUsd: 0, confidence: null, ok: decision.allowed,
      detail: decision.allowed ? 'allowed' : `denied: ${decision.reasons.join(', ')}`,
    });
  };
  propose('draft_only', null);
  propose('send_tenant_message', null);
  if (merged.emergencyFlag) propose('dispatch_vendor', null);

  const safety = merged.emergencyFlag
    ? {
        ar: safetyInstructions(pre.output.safetyInstructionsKey ?? 'generic', 'ar'),
        en: safetyInstructions(pre.output.safetyInstructionsKey ?? 'generic', 'en'),
      }
    : null;

  return {
    ticketId: parsed.ticketId, merged, safetyInstructions: safety, proposals, steps,
    handedOffToHuman: handedOff, handoffReason, tokensUsed, totalLatencyMs, estimatedCostUsd,
    routedToStrongModel: routedToStrong,
  };
}
