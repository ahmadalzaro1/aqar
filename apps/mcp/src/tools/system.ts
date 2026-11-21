/**
 * MCP adapter for the orientation tool.
 *
 * The SQL and the payload live in `@aqar/tools`; this file registers it. It is
 * deliberately registered without an `inputSchema`, as before: it takes no
 * arguments, so the listing carries the SDK's default empty object schema.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { aqarContext } from '@aqar/tools';
import type { ToolContext } from '../context.js';
import { coreContext, readTool } from './core.js';

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    aqarContext.name,
    {
      title: aqarContext.title,
      description: aqarContext.description,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    readTool(aqarContext, coreContext(ctx)),
  );
}
