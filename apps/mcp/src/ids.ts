import { createHash } from 'node:crypto';

/**
 * Deterministic uuid from an idempotency key.
 *
 * Identical to apps/channels/src/ids.ts: same key -> same uuid forever, so a
 * retried tool call becomes a primary-key conflict instead of a duplicate row.
 * RFC-4122 v5 layout so it satisfies z.string().uuid() on the frozen contracts.
 */
export function deterministicId(namespace: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${namespace}:${idempotencyKey}`, 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Stable hash of tool arguments, used to dedupe pending proposals. */
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
