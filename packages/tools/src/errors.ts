/**
 * A tool failure the caller is meant to read, not a crash.
 *
 * The message is the contract: adapters render it verbatim (MCP surfaces a
 * thrown error as its `message`), so it must say what the caller can act on.
 * `code` stays machine-readable for adapters that carry it into a richer
 * envelope.
 */
export class ToolFailure extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ToolFailure';
    this.code = code;
    this.hint = hint;
  }
}

export function isToolFailure(value: unknown): value is ToolFailure {
  return value instanceof ToolFailure;
}
