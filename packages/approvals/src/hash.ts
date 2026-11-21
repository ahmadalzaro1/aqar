import { createHash } from 'node:crypto';

/**
 * Stable hash of tool arguments: the value an approval signature covers.
 *
 * Copied verbatim from apps/mcp/src/ids.ts when the approval layer needed the
 * same bytes. Changing this function invalidates every pending proposal's
 * args_hash and every token minted from one, so it is frozen: extend, never edit.
 */
export function argsHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * JSON with sorted keys, so `{a,b}` and `{b,a}` hash identically. Arrays keep
 * order: argument order can be meaningful, object key order never is.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
