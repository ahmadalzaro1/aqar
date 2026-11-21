/**
 * Shared plumbing for the MCP adapters over `@aqar/tools`.
 *
 * The core handlers own the SQL and the output shape; this file only maps MCP's
 * request/response envelope onto them, so the in-app chat and a remote MCP client
 * run literally the same code. Errors are re-thrown (not converted to a result
 * envelope) because that is how these tools already failed: the SDK renders a
 * thrown error as its message, and `ToolFailure` keeps that message identical.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isToolFailure, rawShape, type ToolContext as CoreToolContext, type ToolDef } from '@aqar/tools';
import type { ToolContext } from '../context.js';
import { ToolError } from '../errors.js';
import { ok } from '../result.js';

/**
 * The server context carries config and a queue; the core sees the ledger
 * connection, the resolved organization, and the policy snapshot it reports.
 */
export function coreContext(ctx: ToolContext): CoreToolContext {
  return {
    sql: ctx.sql,
    org: ctx.org,
    now: ctx.now,
    policy: {
      actor: ctx.cfg.actorName,
      mode: ctx.cfg.mode,
      quietHoursStart: ctx.cfg.quietHoursStart,
      quietHoursEnd: ctx.cfg.quietHoursEnd,
      tenantMessageDailyCap: ctx.cfg.tenantMessageDailyCap,
      orgDailySpendCapFils: ctx.cfg.orgDailySpendCapFils,
    },
  };
}

/** One core handler as an MCP tool callback: same envelope, same failure text. */
export function readTool(tool: ToolDef, core: CoreToolContext): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      return ok(await tool.run(core, args));
    } catch (error) {
      // Keep the machine-readable code on the MCP side: a ToolError still reaches
      // the SDK, which renders only its message — exactly as before the move.
      if (isToolFailure(error)) throw new ToolError(error.code, error.message, error.hint);
      throw error;
    }
  };
}

/** Registers read-only core tools with their schema, title and annotations. */
export function registerReadTools(
  server: McpServer,
  ctx: ToolContext,
  tools: readonly ToolDef[],
): void {
  const core = coreContext(ctx);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: rawShape(tool),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      readTool(tool, core),
    );
  }
}
