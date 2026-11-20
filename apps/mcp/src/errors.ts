/**
 * Typed error carrier for tool handlers.
 *
 * MCP tools fail by returning `isError: true` content, not by throwing at the
 * transport: a thrown error reaches the client as an opaque protocol failure and
 * the model learns nothing. Every handler error becomes `{code, message, hint}`.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

export function describeError(error: unknown): { code: string; message: string } {
  if (isToolError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'internal_error', message: error.message };
  return { code: 'internal_error', message: String(error) };
}
