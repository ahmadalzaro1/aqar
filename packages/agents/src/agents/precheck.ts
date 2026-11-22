// Deterministic emergency pre-check agent — NO LLM. This is the LAW-2 floor.
import { z } from 'zod';
import { emergencyPrecheck as corePrecheck } from '@aqar/core';
import { emergencyPrecheckSchema, type EmergencyPrecheck } from '@aqar/contracts';
import type { AgentContext, AgentResult, IAgent } from '../types.js';
import { sha256 } from '../hashing.js';

const inputSchema = z.object({ text: z.string().min(1) });
type In = z.infer<typeof inputSchema>;

export const precheckAgent: IAgent<In, EmergencyPrecheck> = {
  name: 'emergency-precheck',
  promptVersion: 'det-1.0.0',
  inputSchema,
  outputSchema: emergencyPrecheckSchema,
  async run(input, _ctx: AgentContext): Promise<AgentResult<EmergencyPrecheck>> {
    const started = performance.now();
    const parsedIn = inputSchema.parse(input);
    const output = emergencyPrecheckSchema.parse(corePrecheck(parsedIn.text));
    return {
      output,
      trace: {
        step: 'precheck',
        agent: 'emergency-precheck',
        promptVersion: 'det-1.0.0',
        model: null,
        promptHash: null,
        inputHash: sha256(parsedIn.text),
        outputHash: sha256(JSON.stringify(output)),
        tokens: 0,
        latencyMs: Math.round(performance.now() - started),
        estimatedCostUsd: 0,
        confidence: 1,
        ok: true,
        detail: output.emergency
          ? `deterministic hazard signals: ${output.signals.join(', ')}`
          : 'no deterministic hazard signal',
      },
    };
  },
};
