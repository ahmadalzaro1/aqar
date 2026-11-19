import { describe, expect, it } from 'vitest';
import { createProvider, ProviderError } from '../provider.js';

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

const VALID = {
  model: 'm', choices: [{ message: { content: 'hi' } }],
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
};

describe('OpenAI-compatible provider', () => {
  it('parses a valid completion and estimates cost', async () => {
    const p = createProvider({ baseUrl: 'http://x/v1/', model: 'm', costPerMillion: [2, 8], fetchImpl: fakeFetch(VALID) });
    const res = await p.chat({ messages: [{ role: 'user', content: 'q' }], maxTokens: 10 });
    expect(res.content).toBe('hi');
    expect(res.usage.totalTokens).toBe(1500);
    expect(res.estimatedCostUsd).toBeCloseTo((1000 * 2 + 500 * 8) / 1_000_000, 10);
  });

  it('local cost defaults to zero', async () => {
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: fakeFetch(VALID) });
    expect((await p.chat({ messages: [], maxTokens: 1 })).estimatedCostUsd).toBe(0);
  });

  it('malformed completion is a schema ProviderError, never a silent pass', async () => {
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: fakeFetch({ nope: 1 }) });
    await expect(p.chat({ messages: [], maxTokens: 1 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('HTTP failure surfaces as ProviderError http', async () => {
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: fakeFetch({}, false) });
    await expect(p.chat({ messages: [], maxTokens: 1 })).rejects.toMatchObject({ kind: 'http' });
  });

  it('timeout aborts and reports kind timeout', async () => {
    const never = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      });
    })) as unknown as typeof fetch;
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: never });
    await expect(p.chat({ messages: [], maxTokens: 1, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('embeddings parse and preserve order', async () => {
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'e', fetchImpl: fakeFetch({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }) });
    expect(await p.embed(['a', 'b'])).toEqual([[1, 2], [3, 4]]);
  });

  it('ProviderError is exported and typed', () => {
    expect(new ProviderError('x', 'network').kind).toBe('network');
  });
});
