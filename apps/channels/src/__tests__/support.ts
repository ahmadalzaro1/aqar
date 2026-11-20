import { randomUUID } from 'node:crypto';
import { TRIAGE_QUEUE_NAME, type TicketIngestJob } from '@aqar/contracts';
import { createSql, type Sql } from '@aqar/db';
import type { Queue } from 'bullmq';
import type { Hono } from 'hono';
import { createApp, createQueue } from '../app.js';
import { loadConfig, type ChannelsConfig } from '../config.js';
import { loadRepoEnv } from '../env.js';
import { findOrganization, type OrgRef } from '../store.js';

/** Fixed test secrets: the suites must prove real HMAC verification, not a mock. */
export const TEST_WA_APP_SECRET = 'wa-app-secret-integration-7f3c9a';
export const TEST_WA_VERIFY_TOKEN = 'wa-verify-token-integration-7f3c9a';
export const TEST_TG_WEBHOOK_SECRET = 'tg-webhook-secret-integration-7f3c9a';

export type Harness = {
  readonly config: ChannelsConfig;
  readonly sql: Sql;
  readonly queue: Queue<TicketIngestJob>;
  readonly app: Hono;
  readonly org: OrgRef;
  /** Ticket ids created by the suite; cleaned up in `close`. */
  readonly ticketIds: string[];
  /** channel_identities.external_id values created by the suite. */
  readonly externalIds: string[];
  readonly close: () => Promise<void>;
};

export type HarnessOptions = {
  /** Overrides applied after the env-derived config is built. */
  readonly queueName?: string;
  readonly whatsappAppSecret?: string;
  readonly telegramSecret?: string;
};

/**
 * Builds a real app + real pooled SQL client + real BullMQ queue.
 *
 * Outbound provider credentials are forced empty so `sendWhatsApp` /
 * `sendTelegram` take the honest "not configured" path instead of calling Meta
 * or Telegram from a test.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  loadRepoEnv();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: process.env['DATABASE_URL'],
    WHATSAPP_APP_SECRET: options.whatsappAppSecret ?? TEST_WA_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: TEST_WA_VERIFY_TOKEN,
    WHATSAPP_ACCESS_TOKEN: '',
    WHATSAPP_TOKEN: '',
    WHATSAPP_PHONE_NUMBER_ID: '',
    TELEGRAM_WEBHOOK_SECRET: options.telegramSecret ?? TEST_TG_WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: '',
  };
  const base = loadConfig(env);
  const config: ChannelsConfig = {
    ...base,
    queueName: options.queueName ?? TRIAGE_QUEUE_NAME,
  };

  const sql = createSql(config.databaseUrl, 5);
  const queue = createQueue(config);
  const app = createApp(config, { sql, queue });

  const org = await findOrganization(sql, config.orgSlug);
  if (org === null) {
    await sql.end({ timeout: 5 });
    throw new Error(
      `seed missing: organization '${config.orgSlug}' not found in ${new URL(config.databaseUrl).pathname.slice(1)}`,
    );
  }

  const ticketIds: string[] = [];
  const externalIds: string[] = [];

  return {
    config,
    sql,
    queue,
    app,
    org,
    ticketIds,
    externalIds,
    close: async () => {
      for (const ticketId of ticketIds) {
        const job = await queue.getJob(ticketId);
        // A dev running `apps/worker` will grab these jobs and hold the lock.
        // That is a normal local setup, not a test failure: the assertions have
        // already run by now, so drop what we can and let the worker's own
        // retention remove the rest. Never let teardown decide pass/fail.
        if (job !== undefined) {
          await job.remove().catch(() => undefined);
        }
      }
      await queue.close();
      if (ticketIds.length > 0) {
        await sql.begin(async (tx) => {
          await tx`select set_config('app.organization_id', ${org.id}, true)`;
          await tx`delete from tickets where organization_id = ${org.id} and id = any(${ticketIds}::uuid[])`;
        });
      }
      if (externalIds.length > 0) {
        await sql.begin(async (tx) => {
          await tx`select set_config('app.organization_id', ${org.id}, true)`;
          await tx`delete from channel_identities
                   where organization_id = ${org.id} and external_id = any(${externalIds}::text[])`;
        });
      }
      await sql.end({ timeout: 5 });
    },
  };
}

/** A phone-number-shaped handle unique to this run (avoids collisions across runs). */
export function uniquePhone(): string {
  const digits = randomUUID().replace(/[^0-9]/gu, '').padEnd(8, '0').slice(0, 8);
  return `96279${digits}`;
}

export function uniqueTelegramId(): number {
  // Telegram user ids are positive int32-ish; keep well inside that range.
  const digits = randomUUID().replace(/[^0-9]/gu, '').padEnd(6, '0').slice(0, 6);
  return 700_000_000 + Number.parseInt(digits, 10);
}

export type WhatsAppMessageSpec = {
  readonly messageId: string;
  readonly from: string;
  readonly body: string;
  readonly profileName?: string;
};

/** Minimal but faithful WhatsApp Cloud API `messages` webhook envelope. */
export function whatsAppPayload(spec: WhatsAppMessageSpec): string {
  const profileName = spec.profileName ?? 'Test Tenant';
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-test-0001',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '962790000000', phone_number_id: 'pn-test-0001' },
              contacts: [{ profile: { name: profileName }, wa_id: spec.from }],
              messages: [
                {
                  from: spec.from,
                  id: spec.messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: spec.body },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

export type TelegramMessageSpec = {
  readonly updateId: number;
  readonly userId: number;
  readonly chatId?: number;
  readonly text: string;
  readonly firstName?: string;
};

/** Minimal but faithful Telegram Bot API `message` update envelope. */
export function telegramPayload(spec: TelegramMessageSpec): string {
  return JSON.stringify({
    update_id: spec.updateId,
    message: {
      message_id: spec.updateId,
      date: Math.floor(Date.now() / 1000),
      text: spec.text,
      chat: { id: spec.chatId ?? spec.userId, type: 'private' },
      from: {
        id: spec.userId,
        is_bot: false,
        first_name: spec.firstName ?? 'Telegram Tester',
        language_code: 'en',
      },
    },
  });
}

export type TicketRow = {
  readonly id: string;
  readonly organization_id: string;
  readonly channel: string;
  readonly status: string;
  readonly body: string;
  readonly body_locale: string;
  readonly subject: string | null;
  readonly emergency_flag: boolean;
  readonly tenant_id: string | null;
};

/** Direct read under the org GUC (RLS-safe, same path the apps use). */
export async function readTicket(
  sql: Sql,
  organizationId: string,
  ticketId: string,
): Promise<TicketRow | null> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    const rows = await tx<TicketRow[]>`
      select id, organization_id, channel::text as channel, status::text as status,
             body, body_locale::text as body_locale, subject, emergency_flag, tenant_id
      from tickets where id = ${ticketId}
    `;
    return rows[0] ?? null;
  }) as Promise<TicketRow | null>;
}

export type OutboundRow = {
  readonly id: string;
  readonly direction: string;
  readonly channel: string;
  readonly body: string;
  readonly body_locale: string;
  readonly external_id: string | null;
};

export async function readOutboundMessages(
  sql: Sql,
  organizationId: string,
  ticketId: string,
): Promise<OutboundRow[]> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return tx<OutboundRow[]>`
      select id, direction::text as direction, channel::text as channel, body,
             body_locale::text as body_locale, external_id
      from ticket_messages
      where ticket_id = ${ticketId} and direction = 'outbound'::message_direction
      order by sent_at asc
    `;
  }) as Promise<OutboundRow[]>;
}

/** Counts all BullMQ jobs (any state) whose id is the ticket id. */
export async function countJobsForTicket(
  queue: Queue<TicketIngestJob>,
  ticketId: string,
): Promise<number> {
  // BullMQ 6 dropped the `paused` job state (pause is now a queue-level flag,
  // not a job state) and added `prioritized` — a prioritized ingest job would
  // otherwise be invisible to this counter.
  const jobs = await queue.getJobs(
    ['waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed', 'waiting-children'],
    0,
    500,
    true,
  );
  return jobs.filter((job) => job.id === ticketId).length;
}
