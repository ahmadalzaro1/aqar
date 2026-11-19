import { Hono } from 'hono';
import type { Context } from 'hono';
import { Queue } from 'bullmq';
import { ticketIngestJobSchema, type TicketIngestJob } from '@aqar/contracts';
import { createSql, type Sql } from '@aqar/db';
import type { ChannelsConfig } from './config.js';
import { parseRedisUrl } from './connections.js';
import { deterministicTicketId } from './ids.js';
import { normalizeTelegram, normalizeWhatsApp, PayloadError, type NormalizedInbound } from './payloads.js';
import {
  deleteTicket,
  ensureChannelIdentity,
  findOrganization,
  insertInboundTicket,
} from './store.js';
import { detectLocale, toSubject } from './text.js';
import { secureCompare, verifyTelegramSecret, verifyWhatsAppSignature } from './verify.js';

/** Job name on the shared triage queue. Consumers must subscribe to this name. */
export const TRIAGE_JOB_NAME = 'ticket.ingest';

export type ChannelsRuntime = {
  readonly sql: Sql;
  readonly queue: Queue<TicketIngestJob>;
};

/** BullMQ queue for the frozen triage contract. */
export function createQueue(config: ChannelsConfig): Queue<TicketIngestJob> {
  return new Queue<TicketIngestJob>(config.queueName, {
    connection: parseRedisUrl(config.redisUrl),
  });
}

class IngestError extends Error {
  readonly status: 404 | 409 | 500 | 503;
  constructor(status: 404 | 409 | 500 | 503, message: string) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
  }
}

type IngestOutcome = { readonly ticketId: string; readonly duplicate: boolean };

export type ChannelApp = Hono;

/**
 * Builds the webhook ingress.
 *
 * `runtime` is injectable so tests can hand in their own pooled SQL client and
 * queue (and close them afterwards); production calls `createApp(config)` and
 * lets the app own both resources.
 *
 * Pipeline per inbound text: verify signature over raw bytes → normalize →
 * deterministic ticket id → channel identity → insert ticket (ON CONFLICT DO
 * NOTHING) → enqueue triage job (jobId = ticket id). Signature verification
 * happens before any database write on every path.
 */
export function createApp(config: ChannelsConfig, runtime?: ChannelsRuntime): ChannelApp {
  const sql: Sql = runtime?.sql ?? createSql(config.databaseUrl, 5);
  const queue: Queue<TicketIngestJob> = runtime?.queue ?? createQueue(config);
  const app = new Hono();

  const ingestOne = async (inbound: NormalizedInbound): Promise<IngestOutcome> => {
    const org = await findOrganization(sql, config.orgSlug);
    if (org === null) {
      throw new IngestError(500, `organization '${config.orgSlug}' is not seeded`);
    }
    const identity = await ensureChannelIdentity(sql, {
      organizationId: org.id,
      channel: inbound.source,
      externalId: inbound.externalId,
      displayName: inbound.displayName,
    });
    const ticketId = deterministicTicketId(inbound.idempotencyKey);
    const bodyLocale = detectLocale(inbound.body);
    const inserted = await insertInboundTicket(sql, org.id, {
      ticketId,
      channel: inbound.source,
      subject: toSubject(inbound.body),
      body: inbound.body,
      bodyLocale,
      openedAt: inbound.receivedAt,
      tenantId: identity.tenantId,
    });
    if (!inserted.inserted) {
      // Provider redelivery: the deterministic primary key already exists.
      return { ticketId: inserted.id, duplicate: true };
    }

    // Parse with the frozen contract before it ever reaches Redis: the consumer
    // rejects anything that fails validation, so the producer must not emit it.
    const payload: TicketIngestJob = ticketIngestJobSchema.parse({
      ticketId: inserted.id,
      orgId: org.id,
      channel: inbound.source,
      text: inbound.body,
      locale: bodyLocale,
      tenantId: identity.tenantId,
      idempotencyKey: inbound.idempotencyKey,
    });
    try {
      await queue.add(TRIAGE_JOB_NAME, payload, {
        // Same uuid as the ticket: BullMQ's own dedupe on top of the DB one.
        jobId: inserted.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      });
    } catch (error) {
      // No queue → no triage. Remove the ticket so the provider's retry is not
      // swallowed as a duplicate, and tell it to try again.
      await deleteTicket(sql, org.id, inserted.id);
      const reason = error instanceof Error ? error.message : 'unknown queue error';
      throw new IngestError(503, `triage queue unavailable: ${reason}`);
    }
    return { ticketId: inserted.id, duplicate: false };
  };

  const ingestBatch = async (inbound: readonly NormalizedInbound[]): Promise<IngestOutcome[]> => {
    const outcomes: IngestOutcome[] = [];
    for (const message of inbound) {
      outcomes.push(await ingestOne(message));
    }
    return outcomes;
  };

  const jsonResult = (c: Context, outcomes: readonly IngestOutcome[]): Response => {
    const duplicateCount = outcomes.filter((outcome) => outcome.duplicate).length;
    return c.json({
      ok: true,
      accepted: outcomes.length,
      duplicates: duplicateCount,
      tickets: outcomes.map((outcome) => ({ id: outcome.ticketId, duplicate: outcome.duplicate })),
    });
  };

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Meta subscription handshake. The verify token is a shared secret, so it is
  // compared in constant time too.
  app.get('/webhooks/whatsapp', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (config.whatsapp.verifyToken.length === 0) {
      return c.json({ error: 'verify_token_not_configured' }, 403);
    }
    if (mode !== 'subscribe' || token === undefined || challenge === undefined) {
      return c.json({ error: 'invalid_verification_request' }, 403);
    }
    if (!secureCompare(token, config.whatsapp.verifyToken)) {
      return c.json({ error: 'invalid_verify_token' }, 403);
    }
    return c.text(challenge, 200);
  });

  app.post('/webhooks/whatsapp', async (c) => {
    const rawBody = await c.req.text();
    const header = c.req.header('x-hub-signature-256');
    if (config.whatsapp.appSecret.length === 0) {
      return c.json({ error: 'signature_not_configured' }, 403);
    }
    if (header === undefined) {
      return c.json({ error: 'missing_signature' }, 401);
    }
    if (!verifyWhatsAppSignature({ rawBody, header, appSecret: config.whatsapp.appSecret })) {
      return c.json({ error: 'invalid_signature' }, 403);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    let inbound: NormalizedInbound[];
    try {
      inbound = normalizeWhatsApp(payload);
    } catch (error) {
      if (error instanceof PayloadError) return c.json({ error: 'invalid_payload' }, 400);
      throw error;
    }
    return jsonResult(c, await ingestBatch(inbound));
  });

  app.post('/webhooks/telegram', async (c) => {
    const rawBody = await c.req.text();
    const header = c.req.header('x-telegram-bot-api-secret-token');
    if (config.telegram.webhookSecret.length === 0) {
      return c.json({ error: 'secret_token_not_configured' }, 403);
    }
    if (header === undefined) {
      return c.json({ error: 'missing_secret_token' }, 401);
    }
    if (!verifyTelegramSecret({ header, webhookSecret: config.telegram.webhookSecret })) {
      return c.json({ error: 'invalid_secret_token' }, 403);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    let inbound: NormalizedInbound[];
    try {
      inbound = normalizeTelegram(payload);
    } catch (error) {
      if (error instanceof PayloadError) return c.json({ error: 'invalid_payload' }, 400);
      throw error;
    }
    return jsonResult(c, await ingestBatch(inbound));
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((error, c) => {
    if (error instanceof IngestError) {
      return c.json({ error: 'ingest_failed', detail: error.message }, error.status);
    }
    console.error('channels: unhandled error', error);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
