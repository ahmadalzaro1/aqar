/**
 * Tool result helpers.
 *
 * MCP results are content blocks, not exceptions. A failure returns
 * `isError: true` with a machine-readable code and a hint, so the model can
 * recover (retry with different arguments, or tell the user what is missing)
 * instead of seeing a protocol-level crash.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError, isToolError } from './errors.js';

export function ok(data: unknown, note?: string): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  const content: CallToolResult['content'] = [{ type: 'text', text: note === undefined ? text : `${note}\n\n${text}` }];
  return { content };
}

export function fail(error: unknown): CallToolResult {
  const { code, message } = describeError(error);
  const hint = isToolError(error) ? error.hint : undefined;
  const payload = { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/** Wraps a handler so no throw ever escapes as a transport failure. */
export function guarded<Args>(
  fn: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (error) {
      return fail(error);
    }
  };
}
