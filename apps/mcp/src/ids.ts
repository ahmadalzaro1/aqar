import { createHash } from 'node:crypto';
import { argsHash, canonicalJson } from '@aqar/approvals';

// The hash an approval token signs lives in @aqar/approvals so the console and
// the MCP server cannot drift apart. Re-exported here for existing call sites.
export { argsHash, canonicalJson };

/**
 * Deterministic uuid from an idempotency key.
 *
 * Identical to apps/channels/src/ids.ts: same key -> same uuid forever, so a
 * retried tool call becomes a primary-key conflict instead of a duplicate row.
 * RFC-4122 v5 layout so it satisfies z.string().uuid() on the frozen contracts.
 */
export function deterministicId(namespace: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${namespace}:${idempotencyKey}`, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
