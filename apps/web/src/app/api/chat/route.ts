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
import {
  providersFromEnv,
  type ChatMessage,
  type ChatResponse,
  type ModelTool,
} from '@aqar/agents';
import { registry, type ToolContext } from '@aqar/tools';
import type { Sql } from '@aqar/db';
import { getSessionUser } from '@/lib/auth';
import { sql } from '@/lib/db';
import { tableForTool, type ToolTable } from '@/lib/toolTable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ROUNDS = 2;
const MAX_CALLS = 4;
const MAX_TOOL_CHARS = 6_000;

const bodySchema = z.object({
  lane: z.enum(['local', 'strong']).default('local'),
  locale: z.enum(['ar', 'en']).default('ar'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4_000),
      }),
    )
    .min(1)
    .max(30),
});

/**
 * The prompt is built per request because the language is a property of the
 * console, not of the question. A 3B local will follow "reply in the language of
 * the question" about half the time; naming the language outright fixes that.
 */
function systemFor(locale: 'ar' | 'en'): string {
  const language = locale === 'ar' ? 'Arabic' : 'English';
  return [
    'You are Aqar, the operations assistant embedded in a property-management console.',
    'Answer only from tool results. Call a tool whenever the answer needs data.',
    `LANGUAGE: the console is set to ${language}. Write the entire answer in ${language}, including any heading. Never mix languages and never translate names.`,
    'MONEY: money arrives as strings like "885.000", meaning Jordanian dinars. Quote those strings exactly as given. Never convert, never add, never subtract, never re-round, and never print fils — minor-unit amounts are not part of your input.',
    'LISTS: the interface renders the table itself from the same tool result. Write one lead sentence saying what the list shows; do not enumerate rows, do not restate the table, do not end on a dangling name.',
    'Never write field names, camelCase identifiers or JSON keys. Never translate or name the currency: write amounts bare, exactly as given (e.g. 885.000), and let the interface label them.',
    'If the data does not answer the question, say exactly what is missing. Never guess a number.',
    'Be brief: one or two sentences, with only the figures that matter.',
  ].join(' ');
}

/**
 * What the model is allowed to see of a tool result.
 *
 * Two rules, both learned from a real bad answer:
 *  - keys ending in `Fils` are dropped: given both "885000" and "885.000" the
 *    model printed both, side by side, as if they disagreed;
 *  - long arrays are cut to five rows plus an explicit `omitted` count, so it
 *    cannot burn its token budget re-typing 25 records (which truncated a name
 *    mid-word on the live console).
 * Nothing is rounded or recomputed — this only removes.
 */
function projectForModel(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const kept: unknown[] = value.slice(0, 5).map((item) => projectForModel(item, depth + 1));
    if (value.length > 5) kept.push({ omitted: value.length - 5 });
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/fils$/i.test(key)) continue;
    out[key] = projectForModel(item, depth + 1);
  }
  return out;
}

/**
 * Last-resort lead sentence, used when the model answers in the wrong script.
 * Every number here is a field the tool already returned; nothing is summed.
 */
function leadFromTable(locale: 'ar' | 'en', table: ToolTable | null): string | null {
  if (table === null || table.total === undefined) return null;
  return locale === 'ar'
    ? `${table.count} سجلًا مستحقًا، بإجمالي ${table.total} د.أ. الجدول أدناه مرتّب من الأعلى إلى الأدنى.`
    : `${table.count} records outstanding, ${table.total} JOD in total. The table below is sorted highest first.`;
}

const ARABIC = /[\u0600-\u06FF]/;

interface ToolTrace {
  name: string;
  ms: number;
  ok: boolean;
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getSessionUser();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad request', detail: parsed.error.message },
      { status: 400 },
    );
  }
  const { lane, locale, messages } = parsed.data;

  const providers = providersFromEnv(process.env);
  const provider = lane === 'strong' ? providers.strong : providers.local;
  if (provider === null) {
    return NextResponse.json(
      { error: 'that lane is not configured (CLOUD_BASE_URL)' },
      { status: 409 },
    );
  }

  const orgRows = await sql<
    { id: string; slug: string; name: string; timezone: string; currency: string }[]
  >`
    select id, slug, name, timezone, currency from organizations where id = ${session.orgId} limit 1`;
  const org = orgRows[0];
  if (org === undefined) {
    return NextResponse.json({ error: 'organization not found' }, { status: 500 });
  }

  const ctx: ToolContext = {
    sql: sql as unknown as Sql,
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      timezone: org.timezone,
      currency: org.currency,
    },
    now: () => new Date(),
  };

  const chatTools: ModelTool[] = registry.list('read').map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

  const transcript: ChatMessage[] = [
    { role: 'system', content: systemFor(locale) },
    ...messages.map((m) =>
      m.role === 'user'
        ? { role: 'user' as const, content: m.content }
        : { role: 'assistant' as const, content: m.content },
    ),
  ];

  const trace: ToolTrace[] = [];
  let table: ToolTable | null = null;
  let costUsd = 0;
  let totalMs = 0;
  let answer = '';
  let model = provider.model;

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const ask = () =>
        provider.chat({
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

      transcript.push({
        role: 'assistant',
        content: res.content.length > 0 ? res.content : null,
        toolCalls: res.toolCalls,
      });

      for (const call of res.toolCalls.slice(0, MAX_CALLS)) {
        const started = Date.now();
        let ok = true;
        let body: string;
        try {
          const args: unknown =
            call.argumentsJson.trim().length === 0
              ? {}
              : (JSON.parse(call.argumentsJson) as unknown);
          const result = await registry.run(call.name, args, ctx);
          table = tableForTool(call.name, result, locale) ?? table;
          // The model sees a projection: no fils, no 25-row dumps. The table the
          // operator reads is built from the untouched result, below.
          body = JSON.stringify(projectForModel(result)).slice(0, MAX_TOOL_CHARS);
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
          {
            role: 'system',
            content: `${systemFor(locale)} Answer now, in the console language, using only the tool results above. Do not call a tool. If they do not answer it, say what is missing.`,
          },
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

  // When the answer is a list, the interface already renders every row from the
  // tool result. The model's prose adds nothing and costs correctness: on the live
  // console it wrote "جند أردية" (a literal translation of "Jordanian dinar") and
  // leaked field names like "collectedJod". So for list answers the lead sentence
  // is assembled from tool fields and the model's prose is discarded.
  const lead = leadFromTable(locale, table);
  if (lead !== null) {
    answer = lead;
  } else if (locale === 'ar' && answer.length > 0 && !ARABIC.test(answer)) {
    // Language guard for prose answers: an Arabic console must not get Latin-only text.
    answer =
      locale === 'ar'
        ? 'لم أجد صياغة عربية موثوقة لهذه الإجابة؛ الأرقام أعلاه من قاعدة البيانات.'
        : answer;
  }

  if (answer.length === 0) {
    answer =
      locale === 'ar'
        ? 'لم أستطع إكمال الطلب ضمن ميزانية الأدوات. ضيّق السؤال وحاول مرة أخرى.'
        : 'I could not finish that within the tool budget. Narrow the question and try again.';
  }

  return NextResponse.json({
    answer,
    model,
    lane: provider.id,
    latencyMs: totalMs,
    costUsd,
    tools: trace,
    table,
    strongAvailable: providers.strong !== null,
  });
}
