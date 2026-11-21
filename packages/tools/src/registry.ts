/**
 * Transport-agnostic tool core.
 *
 * One implementation per tool, two adapters: the MCP server registers these as
 * MCP tools, and the in-app chat calls `runTool` in-process. The schema is the
 * single source for both validation and the model-facing JSON Schema, so the two
 * can never drift.
 */
import { z } from 'zod';
import type { ToolContext } from './context.js';

export type ToolKind = 'read' | 'propose';

/**
 * A tool as the registry stores it. `run` takes `unknown` and parses its own
 * arguments: every adapter (MCP, HTTP, in-process) gets validation for free, and
 * a typed generic would make the heterogeneous registry unsound to iterate.
 */
export interface ToolDef {
  readonly name: string;
  readonly kind: ToolKind;
  readonly title: string;
  readonly description: string;
  readonly schema: z.ZodType;
  run(ctx: ToolContext, args: unknown): Promise<unknown>;
}

/** JSON Schema for the model, from the same zod schema the handler validates with. */
export function toParameters(tool: ToolDef): Record<string, unknown> {
  const json = tool.schema.toJSONSchema() as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

/** The zod object shape an MCP adapter needs for `inputSchema`. */
export function rawShape(tool: ToolDef): Record<string, z.ZodType> {
  const schema = tool.schema;
  return schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodType>) : {};
}

export interface ToolSummary {
  readonly name: string;
  readonly kind: ToolKind;
  readonly title: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
    this.name = 'ToolNotFoundError';
  }
}

export function makeRegistry(tools: readonly ToolDef[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    tools,
    /** Every tool, or only one kind — the chat panel ships read-only first. */
    list(kind?: ToolKind): ToolSummary[] {
      return tools
        .filter((t) => kind === undefined || t.kind === kind)
        .map((t) => ({
          name: t.name, kind: t.kind, title: t.title, description: t.description, parameters: toParameters(t),
        }));
    },
    get(name: string): ToolDef {
      const found = byName.get(name);
      if (found === undefined) throw new ToolNotFoundError(name);
      return found;
    },
    async run(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
      return byName.get(name)?.run(ctx, args) ?? Promise.reject(new ToolNotFoundError(name));
    },
  };
}

export type Registry = ReturnType<typeof makeRegistry>;
