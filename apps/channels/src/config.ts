import { TRIAGE_QUEUE_NAME } from '@aqar/contracts';

/** Port the ingress listens on in dev (8787 is reserved for apps/channels). */
export const DEFAULT_PORT = 8787;

export type WhatsAppConfig = {
  /** Meta app secret. Empty string = verification cannot succeed (fail closed). */
  readonly appSecret: string;
  /** `hub.verify_token` value registered in the Meta console. */
  readonly verifyToken: string;
  readonly phoneNumberId: string;
  /** Graph API access token; empty = outbound persists locally instead of sending. */
  readonly accessToken: string;
  readonly graphApiBase: string;
};

export type TelegramConfig = {
  /** `secret_token` passed to setWebhook. Empty string = fail closed. */
  readonly webhookSecret: string;
  /** Bot token; empty = outbound persists locally instead of sending. */
  readonly botToken: string;
  readonly apiBase: string;
};

export type EmailConfig = {
  /** SMTP URL, e.g. smtp://127.0.0.1:1025 (Mailpit in dev). */
  readonly smtpUrl: string;
  readonly from: string;
};

export type ChannelsConfig = {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** Organization slug whose tickets inbound messages create. */
  readonly orgSlug: string;
  readonly queueName: string;
  readonly port: number;
  readonly whatsapp: WhatsAppConfig;
  readonly telegram: TelegramConfig;
  readonly email: EmailConfig;
};

/** Thrown at boot when a required setting is absent; never at request time. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function str(env: NodeJS.ProcessEnv, key: string, fallback = ''): string {
  const value = env[key];
  return value === undefined ? fallback : value.trim();
}

/**
 * Builds the runtime config from an env bag (injectable so tests never touch
 * the real process environment shape). Secrets may be empty: the app then
 * refuses every webhook for that channel instead of trusting unsigned input.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ChannelsConfig {
  const databaseUrl = str(env, 'DATABASE_URL');
  if (databaseUrl.length === 0) {
    throw new ConfigError('DATABASE_URL is required (no placeholder default is used)');
  }
  const redisUrl = str(env, 'REDIS_URL', 'redis://127.0.0.1:6380');
  const orgSlug = str(env, 'CHANNELS_ORG_SLUG', 'aqar-demo');
  const portRaw = str(env, 'PORT', String(DEFAULT_PORT));
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`PORT is not a valid TCP port: ${portRaw}`);
  }

  return {
    databaseUrl,
    redisUrl,
    orgSlug,
    queueName: TRIAGE_QUEUE_NAME,
    port,
    whatsapp: {
      appSecret: str(env, 'WHATSAPP_APP_SECRET'),
      verifyToken: str(env, 'WHATSAPP_VERIFY_TOKEN'),
      phoneNumberId: str(env, 'WHATSAPP_PHONE_NUMBER_ID'),
      // The repo .env names this WHATSAPP_ACCESS_TOKEN; older docs use
      // WHATSAPP_TOKEN. Accept either, prefer the explicit ACCESS name.
      accessToken: str(env, 'WHATSAPP_ACCESS_TOKEN') || str(env, 'WHATSAPP_TOKEN'),
      graphApiBase: str(env, 'WHATSAPP_GRAPH_API_BASE', 'https://graph.facebook.com/v20.0'),
    },
    telegram: {
      webhookSecret: str(env, 'TELEGRAM_WEBHOOK_SECRET'),
      botToken: str(env, 'TELEGRAM_BOT_TOKEN'),
      apiBase: str(env, 'TELEGRAM_API_BASE', 'https://api.telegram.org'),
    },
    email: {
      smtpUrl: str(env, 'SMTP_URL', 'smtp://127.0.0.1:1025'),
      from: str(env, 'EMAIL_FROM', 'Aqar <no-reply@aqar.local>'),
    },
  };
}
