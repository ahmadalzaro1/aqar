import { z } from 'zod';
import type { Sql } from '@aqar/db';
import nodemailer from 'nodemailer';
import type { EmailConfig, TelegramConfig, WhatsAppConfig } from './config.js';
import { parseSmtpUrl } from './connections.js';
import { insertOutboundMessage } from './store.js';
import { detectLocale } from './text.js';

/** Raised when a real provider call fails; never swallowed into a fake success. */
export class OutboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundError';
  }
}

export type EmailParams = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
};

export type EmailResult = { readonly messageId: string; readonly accepted: readonly string[] };

/** Real SMTP send (Mailpit on 127.0.0.1:1025 in dev). Returns SMTP `messageId`. */
export async function sendEmail(config: EmailConfig, params: EmailParams): Promise<EmailResult> {
  const transport = nodemailer.createTransport(parseSmtpUrl(config.smtpUrl));
  try {
    const info = await transport.sendMail({
      from: config.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
    return { messageId: info.messageId, accepted: info.accepted.map((value) => String(value)) };
  } finally {
    transport.close();
  }
}

export type OutboundContext = {
  readonly sql: Sql;
  readonly organizationId: string;
  readonly ticketId: string;
};

export type TextParams = {
  readonly to: string;
  readonly text: string;
  readonly locale?: 'ar' | 'en';
};

export type TextResult =
  | { readonly sent: true; readonly channel: 'whatsapp' | 'telegram'; readonly messageId: string }
  | {
      readonly sent: false;
      readonly reason: 'not_configured';
      readonly channel: 'whatsapp' | 'telegram';
      readonly messageId: string;
    };

const graphResponseSchema = z
  .object({
    messages: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1),
  })
  .passthrough();

const telegramResponseSchema = z
  .object({
    ok: z.boolean(),
    result: z.object({ message_id: z.number().int() }).passthrough().optional(),
    description: z.string().optional(),
  })
  .passthrough();

function assertHttpUrl(raw: string, field: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundError(`${field} must be an http(s) URL, got ${url.protocol}`);
  }
  return url.toString().replace(/\/$/u, '');
}

async function persistLocal(
  ctx: OutboundContext,
  channel: 'whatsapp' | 'telegram',
  params: TextParams,
): Promise<string> {
  return insertOutboundMessage(ctx.sql, {
    organizationId: ctx.organizationId,
    ticketId: ctx.ticketId,
    channel,
    body: params.text,
    bodyLocale: params.locale ?? detectLocale(params.text),
    externalId: null,
    sentAt: new Date(),
  });
}

/**
 * Sends a WhatsApp text via the Cloud API.
 *
 * Without `accessToken`/`phoneNumberId` nothing leaves the machine: the message
 * is stored as an outbound `ticket_messages` row and the caller gets
 * `{sent:false, reason:'not_configured'}` — never a fabricated sent id.
 */
export async function sendWhatsApp(
  config: WhatsAppConfig,
  ctx: OutboundContext,
  params: TextParams,
): Promise<TextResult> {
  if (config.accessToken.length === 0 || config.phoneNumberId.length === 0) {
    const messageId = await persistLocal(ctx, 'whatsapp', params);
    return { sent: false, reason: 'not_configured', channel: 'whatsapp', messageId };
  }
  const base = assertHttpUrl(config.graphApiBase, 'WHATSAPP_GRAPH_API_BASE');
  const response = await fetch(`${base}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'text',
      text: { body: params.text, preview_url: false },
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new OutboundError(`WhatsApp send failed (${response.status}): ${raw.slice(0, 300)}`);
  }
  const parsed = graphResponseSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new OutboundError(`WhatsApp send returned an unexpected body: ${raw.slice(0, 300)}`);
  }
  const message = parsed.data.messages[0];
  if (message === undefined) throw new OutboundError('WhatsApp send returned no message id');
  await insertOutboundMessage(ctx.sql, {
    organizationId: ctx.organizationId,
    ticketId: ctx.ticketId,
    channel: 'whatsapp',
    body: params.text,
    bodyLocale: params.locale ?? detectLocale(params.text),
    externalId: message.id,
    sentAt: new Date(),
  });
  return { sent: true, channel: 'whatsapp', messageId: message.id };
}

/**
 * Sends a Telegram text via the Bot API. Same not-configured contract as
 * WhatsApp: persist locally, report `not_configured`, never claim success.
 */
export async function sendTelegram(
  config: TelegramConfig,
  ctx: OutboundContext,
  params: TextParams,
): Promise<TextResult> {
  if (config.botToken.length === 0) {
    const messageId = await persistLocal(ctx, 'telegram', params);
    return { sent: false, reason: 'not_configured', channel: 'telegram', messageId };
  }
  const base = assertHttpUrl(config.apiBase, 'TELEGRAM_API_BASE');
  const response = await fetch(`${base}/bot${config.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: params.to, text: params.text }),
  });
  const raw = await response.text();
  const parsed = telegramResponseSchema.safeParse(
    (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return {};
      }
    })(),
  );
  if (!response.ok || !parsed.success || !parsed.data.ok || parsed.data.result === undefined) {
    const description = parsed.success
      ? (parsed.data.description ?? 'unknown error')
      : raw.slice(0, 300);
    throw new OutboundError(`Telegram send failed (${response.status}): ${description}`);
  }
  const messageId = String(parsed.data.result.message_id);
  await insertOutboundMessage(ctx.sql, {
    organizationId: ctx.organizationId,
    ticketId: ctx.ticketId,
    channel: 'telegram',
    body: params.text,
    bodyLocale: params.locale ?? detectLocale(params.text),
    externalId: messageId,
    sentAt: new Date(),
  });
  return { sent: true, channel: 'telegram', messageId };
}
