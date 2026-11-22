// OpenAI-compatible model provider. Two configured endpoints per the brief:
// LOCAL_BASE_URL (default local llama-server/oMLX) and CLOUD_BASE_URL (disabled
// unless explicitly configured). Every call records model, tokens, latency and
// an ESTIMATED cost (local = 0). Tenant text is always sent as data, never as
// instructions — the system prompt carries that contract.
import { z } from 'zod';

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
/** A function tool as the wire format names it. Distinct from `@aqar/agents` ToolSpec (a policy entry). */
export interface ModelTool {
  type: 'function';
  function: FunctionDefinition;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  /** Function tools the model may call. Absent ⇒ text-only call, unchanged. */
  tools?: ModelTool[];
}
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface ChatResponse {
  /** Empty string when the model answered with tool calls only. */
  content: string;
  /** Empty array when the model answered in prose. */
  toolCalls: ToolCall[];
  finishReason: string | null;
  model: string;
  usage: ChatUsage;
  latencyMs: number;
  estimatedCostUsd: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'http' | 'schema' | 'network',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const completionSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(toolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

const embeddingSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })).min(1),
});

export interface ProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** USD per 1M tokens, [input, output]. Local defaults to zero. */
  costPerMillion?: [number, number];
  fetchImpl?: typeof fetch;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Internal message shape → OpenAI wire shape. Kept explicit so a tool turn is never sent as prose. */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant') {
    const wire: Record<string, unknown> = { role: 'assistant', content: m.content };
    if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
      wire['tool_calls'] = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.argumentsJson },
      }));
    }
    return wire;
  }
  return { role: m.role, content: m.content };
}

export function createProvider(opts: ProviderOptions): ModelProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  const [costIn, costOut] = opts.costPerMillion ?? [0, 0];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey !== undefined && opts.apiKey.length > 0)
    headers['Authorization'] = `Bearer ${opts.apiKey}`;

  async function post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // A bare status cannot distinguish a rejected prefill from an overloaded
        // server, so carry a slice of the body — but never let reading it turn an
        // HTTP failure into a mislabelled network failure.
        let detail = '';
        try {
          if (typeof res.text === 'function')
            detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
        } catch {
          detail = '';
        }
        throw new ProviderError(
          `HTTP ${res.status} from ${base}${path}${detail.length > 0 ? ` — ${detail}` : ''}`,
          'http',
        );
      }
      return (await res.json()) as unknown;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError')
        throw new ProviderError(`timeout after ${timeoutMs}ms`, 'timeout');
      throw new ProviderError(err instanceof Error ? err.message : String(err), 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: base,
    model: opts.model,
    async chat(req) {
      const started = performance.now();
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: req.messages.map(toWireMessage),
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0,
      };
      if (req.tools !== undefined && req.tools.length > 0) {
        body['tools'] = req.tools;
        body['tool_choice'] = 'auto';
      }
      const raw = await post('/chat/completions', body, req.timeoutMs ?? 30_000);
      const parsed = completionSchema.safeParse(raw);
      if (!parsed.success)
        throw new ProviderError(`malformed completion: ${parsed.error.message}`, 'schema');
      const latencyMs = Math.round(performance.now() - started);
      const usage = parsed.data.usage;
      const first = parsed.data.choices[0];
      if (first === undefined) throw new ProviderError('empty choices', 'schema');
      const content = first.message.content ?? '';
      const toolCalls: ToolCall[] = (first.message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        argumentsJson: c.function.arguments,
      }));
      // A completion with neither prose nor a tool call is a provider defect, not an empty answer.
      if (content.length === 0 && toolCalls.length === 0) {
        throw new ProviderError('completion had neither content nor tool_calls', 'schema');
      }
      return {
        content,
        toolCalls,
        finishReason: first.finish_reason ?? null,
        model: parsed.data.model,
        usage: {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        },
        latencyMs,
        estimatedCostUsd:
          (usage.prompt_tokens * costIn + usage.completion_tokens * costOut) / 1_000_000,
      };
    },
    async embed(texts) {
      const raw = await post('/embeddings', { model: opts.model, input: texts }, 30_000);
      const parsed = embeddingSchema.safeParse(raw);
      if (!parsed.success)
        throw new ProviderError(`malformed embeddings: ${parsed.error.message}`, 'schema');
      return parsed.data.data.map((d) => d.embedding);
    },
  };
}

/** Resolve configured endpoints from env. Cloud is DISABLED unless CLOUD_BASE_URL is set. */
export function providersFromEnv(env: Record<string, string | undefined>): {
  local: ModelProvider;
  strong: ModelProvider | null;
} {
  const local = createProvider({
    baseUrl: env['LOCAL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1',
    model: env['LOCAL_MODEL'] ?? 'lfm3-local',
  });
  const cloudUrl = env['CLOUD_BASE_URL'];
  const strong =
    cloudUrl !== undefined && cloudUrl.length > 0
      ? createProvider({
          baseUrl: cloudUrl,
          model: env['CLOUD_MODEL'] ?? 'strong',
          ...(env['CLOUD_API_KEY'] !== undefined ? { apiKey: env['CLOUD_API_KEY'] } : {}),
          costPerMillion: [Number(env['CLOUD_COST_IN'] ?? 0), Number(env['CLOUD_COST_OUT'] ?? 0)],
        })
      : null;
  return { local, strong };
}
