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

  it('HTTP failure carries the response body, so a withheld completion is diagnosable', async () => {
    const withBody = (async () => ({
      ok: false, status: 502,
      text: async () => '{"error": "Model returned unresolved thinking delimiters; response withheld."}',
    })) as unknown as typeof fetch;
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: withBody });
    await expect(p.chat({ messages: [], maxTokens: 1 })).rejects.toMatchObject({
      kind: 'http', message: expect.stringContaining('unresolved thinking delimiters') as unknown as string,
    });
  });

  it('an unreadable error body still reports http, never network', async () => {
    const broken = (async () => ({
      ok: false, status: 503,
      text: async () => { throw new Error('body stream already consumed'); },
    })) as unknown as typeof fetch;
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: broken });
    await expect(p.chat({ messages: [], maxTokens: 1 })).rejects.toMatchObject({ kind: 'http', message: expect.stringContaining('HTTP 503') as unknown as string });
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

  it('parses a tool-call completion: content is empty, calls survive', async () => {
    const body = {
      model: 'm',
      choices: [{
        message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'portfolio_summary', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: fakeFetch(body) });
    const res = await p.chat({ messages: [{ role: 'user', content: 'q' }], maxTokens: 10 });
    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'portfolio_summary', argumentsJson: '{}' }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('a completion with neither prose nor tool calls is a schema error, not an empty answer', async () => {
    const body = {
      model: 'm', choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    };
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: fakeFetch(body) });
    await expect(p.chat({ messages: [], maxTokens: 1 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('sends tools and tool turns on the wire, and omits tools for text-only calls', async () => {
    const sent: Record<string, unknown>[] = [];
    const capture = ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Promise.resolve({ ok: true, status: 200, json: async () => VALID });
    }) as unknown as typeof fetch;
    const p = createProvider({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: capture });

    await p.chat({ messages: [{ role: 'user', content: 'q' }], maxTokens: 10 });
    expect(sent[0]).not.toHaveProperty('tools');

    await p.chat({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'portfolio_summary', argumentsJson: '{}' }] },
        { role: 'tool', toolCallId: 'c1', content: '{"units":24}' },
      ],
      maxTokens: 10,
      tools: [{ type: 'function', function: { name: 'portfolio_summary', description: 'summary', parameters: { type: 'object', properties: {} } } }],
    });
    const wire = sent[1];
    expect(wire?.['tool_choice']).toBe('auto');
    const tools = wire?.['tools'] as { function: { name: string } }[];
    expect(tools[0]?.function.name).toBe('portfolio_summary');
    const messages = wire?.['messages'] as Record<string, unknown>[];
    expect(messages[1]?.['tool_calls']).toEqual([{ id: 'c1', type: 'function', function: { name: 'portfolio_summary', arguments: '{}' } }]);
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"units":24}' });
  });
});
