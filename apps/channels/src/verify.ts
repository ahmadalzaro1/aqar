import { createHmac, timingSafeEqual } from 'node:crypto';

/** WhatsApp Cloud API signs `sha256=<lowercase hex HMAC-SHA256>` over the raw body. */
export const WHATSAPP_SIGNATURE_PREFIX = 'sha256=';

/** Lowercase hex SHA-256 digest is exactly 64 characters. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on unequal lengths, so the length check happens
 * first (length is not secret — it is fixed for both callers: 64 hex chars for
 * the WhatsApp digest, and the operator-chosen secret for Telegram).
 */
export function secureCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** HMAC-SHA256 of the raw request body, lowercase hex. */
export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** `sha256=` + hex HMAC over the exact bytes received (never the re-serialized JSON). */
export function whatsAppSignature(secret: string, rawBody: string): string {
  return `${WHATSAPP_SIGNATURE_PREFIX}${hmacSha256Hex(secret, rawBody)}`;
}

export type WhatsAppVerifyInput = {
  readonly rawBody: string;
  readonly header: string | null | undefined;
  readonly appSecret: string;
};

/**
 * Verifies `X-Hub-Signature-256`.
 *
 * Fails closed: an unconfigured secret, a missing header, a wrong prefix, a
 * malformed digest or a digest for different bytes all return false — callers
 * must never process the payload in that case.
 */
export function verifyWhatsAppSignature(input: WhatsAppVerifyInput): boolean {
  const { rawBody, header, appSecret } = input;
  if (appSecret.length === 0) return false;
  if (header === null || header === undefined) return false;
  if (!header.startsWith(WHATSAPP_SIGNATURE_PREFIX)) return false;
  const provided = header.slice(WHATSAPP_SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (!HEX_SHA256.test(provided)) return false;
  return secureCompare(provided, hmacSha256Hex(appSecret, rawBody));
}

export type TelegramVerifyInput = {
  readonly header: string | null | undefined;
  readonly webhookSecret: string;
};

/**
 * Verifies `X-Telegram-Bot-Api-Secret-Token`.
 *
 * The header is a plain shared secret (not an HMAC), compared in constant time.
 * Fails closed when the server has no secret configured.
 */
export function verifyTelegramSecret(input: TelegramVerifyInput): boolean {
  const { header, webhookSecret } = input;
  if (webhookSecret.length === 0) return false;
  if (header === null || header === undefined) return false;
  return secureCompare(header, webhookSecret);
}
