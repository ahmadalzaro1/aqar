import { z } from 'zod';
import { telegramIdempotencyKey, whatsAppIdempotencyKey } from './ids.js';

/** A single inbound text message, normalized from either provider's envelope. */
export type NormalizedInbound = {
  readonly source: 'whatsapp' | 'telegram';
  /** The channel handle that owns the conversation (wa_id / telegram user id). */
  readonly externalId: string;
  readonly displayName: string | null;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly receivedAt: Date;
};

/** Raised when the envelope is well-signed but not a shape we can normalize. */
export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

/** Timestamps arrive as unix seconds; anything unparsable falls back to now. */
function toDate(unixSeconds: string | number | undefined): Date {
  if (unixSeconds === undefined) return new Date();
  const seconds = typeof unixSeconds === 'number' ? unixSeconds : Number.parseInt(unixSeconds, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

const waMessageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.union([z.string(), z.number()]).optional(),
    type: z.string().min(1),
    text: z.object({ body: z.string() }).passthrough().optional(),
  })
  .passthrough();

const waContactSchema = z
  .object({
    wa_id: z.string().optional(),
    profile: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const waChangeSchema = z
  .object({
    field: z.string().optional(),
    value: z
      .object({
        metadata: z.object({ phone_number_id: z.string().optional() }).passthrough().optional(),
        contacts: z.array(waContactSchema).optional(),
        messages: z.array(waMessageSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const waPayloadSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(z.object({ changes: z.array(waChangeSchema) }).passthrough()),
  })
  .passthrough();

/**
 * WhatsApp Cloud API webhook → text messages only.
 *
 * Non-text messages (image, audio, location, status receipts) are intentionally
 * dropped rather than turned into empty tickets; `body` has a DB CHECK that
 * rejects blank text.
 */
export function normalizeWhatsApp(payload: unknown): NormalizedInbound[] {
  const parsed = waPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PayloadError(
      `unrecognized WhatsApp webhook envelope: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  const out: NormalizedInbound[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== undefined && change.field !== 'messages') continue;
      const messages = change.value.messages;
      if (messages === undefined) continue;
      const names = new Map<string, string>();
      for (const contact of change.value.contacts ?? []) {
        const name = contact.profile?.name;
        if (contact.wa_id !== undefined && name !== undefined && name.length > 0) {
          names.set(contact.wa_id, name);
        }
      }
      for (const message of messages) {
        if (message.type !== 'text') continue;
        const text = message.text?.body.trim();
        if (text === undefined || text.length === 0) continue;
        out.push({
          source: 'whatsapp',
          externalId: message.from,
          displayName: names.get(message.from) ?? null,
          idempotencyKey: whatsAppIdempotencyKey(message.id),
          body: text,
          receivedAt: toDate(message.timestamp),
        });
      }
    }
  }
  return out;
}

const tgPayloadSchema = z
  .object({
    update_id: z.union([z.number().int(), z.string().min(1)]),
    message: z
      .object({
        message_id: z.number().int().optional(),
        date: z.number().int().optional(),
        text: z.string().optional(),
        chat: z.object({ id: z.union([z.number(), z.string()]) }).passthrough(),
        from: z
          .object({
            id: z.union([z.number(), z.string()]),
            first_name: z.string().optional(),
            username: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Telegram Bot API webhook → text messages only.
 *
 * Identity is `from.id` (the human), falling back to `chat.id` for channel-ish
 * chats. Idempotency is the update id: Telegram re-delivers the same update
 * until it gets a 2xx, so this is the natural dedupe key.
 */
export function normalizeTelegram(payload: unknown): NormalizedInbound[] {
  const parsed = tgPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PayloadError(
      `unrecognized Telegram webhook envelope: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  const message = parsed.data.message;
  if (message === undefined) return [];
  const text = message.text?.trim();
  if (text === undefined || text.length === 0) return [];
  const sender = message.from;
  const externalId = String(sender?.id ?? message.chat.id);
  const displayName = sender?.first_name ?? sender?.username ?? null;
  return [
    {
      source: 'telegram',
      externalId,
      displayName,
      idempotencyKey: telegramIdempotencyKey(parsed.data.update_id),
      body: text,
      receivedAt: toDate(message.date),
    },
  ];
}
