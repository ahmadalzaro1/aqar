// OpenAI-compatible model provider. Two configured endpoints per the brief:
// LOCAL_BASE_URL (default local llama-server/oMLX) and CLOUD_BASE_URL (disabled
// unless explicitly configured). Every call records model, tokens, latency and
// an ESTIMATED cost (local = 0). Tenant text is always sent as data, never as
// instructions — the system prompt carries that contract.
import { z } from 'zod';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatRequest { messages: ChatMessage[]; maxTokens: number; temperature?: number; timeoutMs?: number }
export interface ChatUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface ChatResponse { content: string; model: string; usage: ChatUsage; latencyMs: number; estimatedCostUsd: number }

export class ProviderError extends Error {
  constructor(message: string, readonly kind: 'timeout' | 'http' | 'schema' | 'network') {
    super(message);
    this.name = 'ProviderError';
  }
}

const completionSchema = z.object({
  model: z.string(),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
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

export function createProvider(opts: ProviderOptions): ModelProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  const [costIn, costOut] = opts.costPerMillion ?? [0, 0];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey !== undefined && opts.apiKey.length > 0) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  async function post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok) throw new ProviderError(`HTTP ${res.status} from ${base}${path}`, 'http');
      return (await res.json()) as unknown;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw new ProviderError(`timeout after ${timeoutMs}ms`, 'timeout');
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
      const raw = await post('/chat/completions', {
        model: opts.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0,
      }, req.timeoutMs ?? 30_000);
      const parsed = completionSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError(`malformed completion: ${parsed.error.message}`, 'schema');
      const latencyMs = Math.round(performance.now() - started);
      const usage = parsed.data.usage;
      const first = parsed.data.choices[0];
      if (first === undefined) throw new ProviderError('empty choices', 'schema');
      return {
        content: first.message.content,
        model: parsed.data.model,
        usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
        latencyMs,
        estimatedCostUsd: (usage.prompt_tokens * costIn + usage.completion_tokens * costOut) / 1_000_000,
      };
    },
    async embed(texts) {
      const raw = await post('/embeddings', { model: opts.model, input: texts }, 30_000);
      const parsed = embeddingSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError(`malformed embeddings: ${parsed.error.message}`, 'schema');
      return parsed.data.data.map((d) => d.embedding);
    },
  };
}

/** Resolve configured endpoints from env. Cloud is DISABLED unless CLOUD_BASE_URL is set. */
export function providersFromEnv(env: Record<string, string | undefined>): { local: ModelProvider; strong: ModelProvider | null } {
  const local = createProvider({
    baseUrl: env['LOCAL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1',
    model: env['LOCAL_MODEL'] ?? 'lfm3-local',
  });
  const cloudUrl = env['CLOUD_BASE_URL'];
  const strong = cloudUrl !== undefined && cloudUrl.length > 0
    ? createProvider({
        baseUrl: cloudUrl,
        model: env['CLOUD_MODEL'] ?? 'strong',
        ...(env['CLOUD_API_KEY'] !== undefined ? { apiKey: env['CLOUD_API_KEY'] } : {}),
        costPerMillion: [Number(env['CLOUD_COST_IN'] ?? 0), Number(env['CLOUD_COST_OUT'] ?? 0)],
      })
    : null;
  return { local, strong };
}
