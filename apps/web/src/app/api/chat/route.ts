/**
 * The operator chat endpoint.
 *
 * Read-only tools, run in-process through `@aqar/tools` — the same SQL the MCP
 * server exposes. The model chooses a tool and quotes its fields; it never adds
 * money up (LAW 1) and never chooses the organization (fixed from the session).
 *
 * Deliberately not streaming yet: the answer only exists after the tool round,
 * so a partial stream would be a lie about progress. S2b turns this into SSE
 * once the tool trace is the interesting part of the wait.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { providersFromEnv, type ChatMessage, type ChatResponse, type ModelTool } from '@aqar/agents';
import { registry, type ToolContext } from '@aqar/tools';
import type { Sql } from '@aqar/db';
import { getSessionUser } from '@/lib/auth';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ROUNDS = 2;
const MAX_CALLS = 4;
const MAX_TOOL_CHARS = 6_000;

const bodySchema = z.object({
  lane: z.enum(['local', 'strong']).default('local'),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(4_000),
  })).min(1).max(30),
});

const SYSTEM = [
  'You are Aqar, the operations assistant embedded in a property-management console.',
  'Answer only from tool results. Call a tool whenever the answer needs data.',
  'MONEY: quote the JOD string exactly as the tool returns it. Never add, subtract, convert or re-round money — if a total is needed it is already a field.',
  'If the data does not answer the question, say exactly what is missing. Never guess a number.',
  'Reply in the language of the question: an Arabic question gets an Arabic answer, an English one gets English.',
  'Be brief: two or three sentences, with the figures that matter.',
].join(' ');

interface ToolTrace { name: string; ms: number; ok: boolean }

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getSessionUser();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', detail: parsed.error.message }, { status: 400 });
  }
  const { lane, messages } = parsed.data;

  const providers = providersFromEnv(process.env);
  const provider = lane === 'strong' ? providers.strong : providers.local;
  if (provider === null) {
    return NextResponse.json({ error: 'that lane is not configured (CLOUD_BASE_URL)' }, { status: 409 });
  }

  const orgRows = await sql<{ id: string; slug: string; name: string; timezone: string; currency: string }[]>`
    select id, slug, name, timezone, currency from organizations where id = ${session.orgId} limit 1`;
  const org = orgRows[0];
  if (org === undefined) {
    return NextResponse.json({ error: 'organization not found' }, { status: 500 });
  }

  const ctx: ToolContext = {
    sql: sql as unknown as Sql,
    org: { id: org.id, slug: org.slug, name: org.name, timezone: org.timezone, currency: org.currency },
    now: () => new Date(),
  };

  const chatTools: ModelTool[] = registry.list('read').map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

  const transcript: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    ...messages.map((m) => (m.role === 'user'
      ? { role: 'user' as const, content: m.content }
      : { role: 'assistant' as const, content: m.content })),
  ];

  const trace: ToolTrace[] = [];
  let costUsd = 0;
  let totalMs = 0;
  let answer = '';
  let model = provider.model;

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const ask = () => provider.chat({
        messages: transcript,
        maxTokens: 700,
        temperature: 0.1,
        timeoutMs: 60_000,
        tools: chatTools,
      });
      let res: ChatResponse;
      try {
        res = await ask();
      } catch (err) {
        // The local MLX runtime withholds a completion whose visible content still
        // contains thinking delimiters. It is a sampling artifact, not a bad request,
        // so one retry is legitimate — and the second failure is reported verbatim.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/unresolved thinking delimiters|HTTP 50[23]/.test(msg)) throw err;
        res = await ask();
      }
      costUsd += res.estimatedCostUsd;
      totalMs += res.latencyMs;
      model = res.model;

      if (res.toolCalls.length === 0) {
        answer = res.content.trim();
        break;
      }

      transcript.push({ role: 'assistant', content: res.content.length > 0 ? res.content : null, toolCalls: res.toolCalls });

      for (const call of res.toolCalls.slice(0, MAX_CALLS)) {
        const started = Date.now();
        let ok = true;
        let body: string;
        try {
          const args: unknown = call.argumentsJson.trim().length === 0 ? {} : (JSON.parse(call.argumentsJson) as unknown);
          const result = await registry.run(call.name, args, ctx);
          body = JSON.stringify(result).slice(0, MAX_TOOL_CHARS);
        } catch (err) {
          ok = false;
          body = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
        trace.push({ name: call.name, ms: Date.now() - started, ok });
        transcript.push({ role: 'tool', toolCallId: call.id, content: body });
      }
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: messageText, tools: trace }, { status: 502 });
  }

  if (answer.length === 0) {
    // The model spent its rounds calling tools without ever writing an answer
    // (common on small locals). Ask once more with no tools available, so the
    // only thing it can do is summarise what it already fetched.
    try {
      const res = await provider.chat({
        messages: [
          ...transcript,
          { role: 'system', content: 'Answer the user now in one to three sentences, using only the tool results above. Do not call a tool. If they do not answer it, say what is missing.' },
        ],
        maxTokens: 400,
        temperature: 0.1,
        timeoutMs: 45_000,
      });
      costUsd += res.estimatedCostUsd;
      totalMs += res.latencyMs;
      answer = res.content.trim();
    } catch {
      // fall through to the explicit failure message
    }
  }

  if (answer.length === 0) {
    answer = 'I could not finish that within the tool budget. Narrow the question and try again.';
  }

  return NextResponse.json({
    answer,
    model,
    lane: provider.id,
    latencyMs: totalMs,
    costUsd,
    tools: trace,
    strongAvailable: providers.strong !== null,
  });
}
