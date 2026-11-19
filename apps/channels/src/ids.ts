import { createHash } from 'node:crypto';

/**
 * Deterministic ticket id derived from the source message id.
 *
 * Same idempotency key → same uuid, forever. That turns provider redelivery
 * (WhatsApp retries, Telegram re-sends the same update) into a primary-key
 * conflict instead of a duplicate ticket, with no extra table or unique index
 * needed on `tickets`.
 *
 * Shape: RFC-4122 v5 layout (version nibble 5, variant nibble a) so it passes
 * `z.string().uuid()` in the frozen triage contract.
 */
export function deterministicTicketId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`aqar.ticket:${idempotencyKey}`, 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Idempotency key for a WhatsApp Cloud API message id. */
export function whatsAppIdempotencyKey(messageId: string): string {
  return `wa:${messageId}`;
}

/** Idempotency key for a Telegram update id. */
export function telegramIdempotencyKey(updateId: number | string): string {
  return `tg:${String(updateId)}`;
}
