// Typed agent contract (brief §3). Sequential explicit orchestration only —
// no autonomous free-form loop. Zod validates in AND out; a validation failure
// escalates to a human, never silently continues.
import type { z } from 'zod';
import type { ModelProvider } from './provider.js';

export interface StepTrace {
  step: string;
  agent: string;
  promptVersion: string;
  model: string | null;
  promptHash: string | null;
  inputHash: string;
  outputHash: string;
  tokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  confidence: number | null;
  ok: boolean;
  detail: string;
}

export interface AgentResult<TOut> {
  output: TOut;
  trace: StepTrace;
}

export interface AgentContext {
  orgId: string;
  propertyId: string;
  actor: string;
  locale: 'ar' | 'en';
  /** Injected clock — agents never read the wall clock for domain decisions. */
  nowISO: string;
  provider: ModelProvider;
  strongProvider: ModelProvider | null;
  tokenBudget: number;
}

export interface IAgent<TIn, TOut> {
  readonly name: string;
  readonly promptVersion: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly outputSchema: z.ZodType<TOut>;
  run(input: TIn, ctx: AgentContext): Promise<AgentResult<TOut>>;
}

export class EscalationError extends Error {
  constructor(message: string, readonly reason: 'schema' | 'budget' | 'provider' | 'policy') {
    super(message);
    this.name = 'EscalationError';
  }
}
