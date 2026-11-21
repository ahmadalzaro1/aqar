/**
 * MCP adapter for the portfolio tools.
 *
 * The SQL lives in `@aqar/tools`; this file only translates MCP's request shape
 * onto it, so the in-app chat and a remote MCP client run literally the same
 * code. `ToolContext` here carries more than the core needs (config, queue), and
 * is structurally accepted by it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listExpiringLeases, listVacantUnits, portfolioSummary, rawShape } from '@aqar/tools';
import type { ToolContext } from '../context.js';
import { guarded, ok } from '../result.js';

const TOOLS = [portfolioSummary, listVacantUnits, listExpiringLeases] as const;

export function registerPortfolioTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: rawShape(tool),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      guarded(async (args: unknown) => ok(await tool.run(ctx, args))),
    );
  }
}
