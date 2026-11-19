import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ticketIngestJobSchema, type TicketIngestJob } from '@aqar/contracts';
import type { Queue } from 'bullmq';
import { deterministicTicketId } from '../ids.js';
import { sendTelegram, sendWhatsApp } from '../outbound.js';
import { whatsAppSignature } from '../verify.js';
import {
  countJobsForTicket,
  createHarness,
  readOutboundMessages,
  readTicket,
  telegramPayload,
  uniquePhone,
  uniqueTelegramId,
  whatsAppPayload,
  type Harness,
} from './support.js';

type IngestResponse = {
  ok: boolean;
  accepted: number;
  duplicates: number;
  tickets: { id: string; duplicate: boolean }[];
};

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u;

async function postWhatsApp(
  harness: Harness,
  rawBody: string,
  options: { readonly signature?: string | null } = {},
): Promise<Response> {
  const signature =
    options.signature === null
      ? null
      : (options.signature ?? whatsAppSignature(harness.config.whatsapp.appSecret, rawBody));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return harness.app.request('/webhooks/whatsapp', { method: 'POST', headers, body: rawBody });
}

async function postTelegram(
  harness: Harness,
  rawBody: string,
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['x-telegram-bot-api-secret-token'] = token;
  return harness.app.request('/webhooks/telegram', { method: 'POST', headers, body: rawBody });
}

describe('channels ingress (real Postgres + real Redis)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('serves /healthz', async () => {
    const response = await harness.app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('completes the WhatsApp subscription handshake with the configured token', async () => {
    const ok = await harness.app.request(
      `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(harness.config.whatsapp.verifyToken)}&hub.challenge=challenge-123`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('challenge-123');

    const bad = await harness.app.request(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123',
    );
    expect(bad.status).toBe(403);
  });

  it('accepts a signed WhatsApp text and writes exactly one ticket + one triage job', async () => {
    const from = uniquePhone();
    const messageId = `wamid.TEST-${randomUUID()}`;
    const body = 'تسرب مياه في الحمام الرئيسي، المية عم تغرق كل الشقة';
    const raw = whatsAppPayload({ messageId, from, body });
    harness.externalIds.push(from);

    const response = await postWhatsApp(harness, raw);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as IngestResponse;
    expect(payload.accepted).toBe(1);
    expect(payload.duplicates).toBe(0);
    expect(payload.tickets).toHaveLength(1);

    const ticketId = payload.tickets[0]?.id;
    expect(ticketId).toBeDefined();
    if (ticketId === undefined) throw new Error('no ticket id returned');
    harness.ticketIds.push(ticketId);

    // Deterministic, contract-shaped id derived from the message id.
    expect(ticketId).toBe(deterministicTicketId(`wa:${messageId}`));
    expect(ticketId).toMatch(UUID_V5);

    const ticket = await readTicket(harness.sql, harness.org.id, ticketId);
    expect(ticket).not.toBeNull();
    expect(ticket).toMatchObject({
      id: ticketId,
      organization_id: harness.org.id,
      channel: 'whatsapp',
      status: 'new',
      body,
      body_locale: 'ar',
      subject: body,
      emergency_flag: false,
    });

    const job = await harness.queue.getJob(ticketId);
    expect(job).toBeDefined();
    if (job === undefined) throw new Error('no triage job enqueued');
    expect(harness.config.queueName).toBe('aqar.ticket.triage');
    expect(job.name).toBe('ticket.ingest');
    const parsed = ticketIngestJobSchema.safeParse(job.data);
    expect(parsed.success).toBe(true);
    expect(job.data).toMatchObject({
      ticketId,
      orgId: harness.org.id,
      channel: 'whatsapp',
      text: body,
      locale: 'ar',
      tenantId: null,
      idempotencyKey: `wa:${messageId}`,
    });
    expect(await countJobsForTicket(harness.queue, ticketId)).toBe(1);
  });

  it('treats a redelivered WhatsApp message as a duplicate (1 ticket, 1 job)', async () => {
    const from = uniquePhone();
    const messageId = `wamid.TEST-${randomUUID()}`;
    const body = 'المكيف ما ببرد بالمطبخ';
    const raw = whatsAppPayload({ messageId, from, body });
    harness.externalIds.push(from);

    const first = await postWhatsApp(harness, raw);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as IngestResponse;
    const ticketId = firstBody.tickets[0]?.id;
    if (ticketId === undefined) throw new Error('no ticket id returned');
    harness.ticketIds.push(ticketId);

    const second = await postWhatsApp(harness, raw);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as IngestResponse;
    expect(secondBody.accepted).toBe(1);
    expect(secondBody.duplicates).toBe(1);
    expect(secondBody.tickets).toEqual([{ id: ticketId, duplicate: true }]);

    expect(await countJobsForTicket(harness.queue, ticketId)).toBe(1);
    const rows = await harness.sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${harness.org.id}, true)`;
      return tx<{ count: string }[]>`
        select count(*)::text as count from tickets where id = ${ticketId}
      `;
    });
    expect(rows[0]?.count).toBe('1');
  });

  it('rejects an unsigned WhatsApp POST with 401 and writes nothing', async () => {
    const from = uniquePhone();
    const messageId = `wamid.TEST-${randomUUID()}`;
    const raw = whatsAppPayload({ messageId, from, body: 'unsigned payload' });
    const ticketId = deterministicTicketId(`wa:${messageId}`);

    const response = await postWhatsApp(harness, raw, { signature: null });
    expect(response.status).toBe(401);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_signature' });
    expect(await readTicket(harness.sql, harness.org.id, ticketId)).toBeNull();
    expect(await harness.queue.getJob(ticketId)).toBeUndefined();
  });

  it('rejects a tampered WhatsApp body with 403 and writes nothing', async () => {
    const from = uniquePhone();
    const messageId = `wamid.TEST-${randomUUID()}`;
    const raw = whatsAppPayload({ messageId, from, body: 'original text' });
    const signature = whatsAppSignature(harness.config.whatsapp.appSecret, raw);
    const tampered = raw.replace('original text', 'tampered text');
    const ticketId = deterministicTicketId(`wa:${messageId}`);

    const response = await postWhatsApp(harness, tampered, { signature });
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_signature' });
    expect(await readTicket(harness.sql, harness.org.id, ticketId)).toBeNull();
    expect(await harness.queue.getJob(ticketId)).toBeUndefined();
  });

  it('rejects a WhatsApp POST signed with the wrong secret', async () => {
    const raw = whatsAppPayload({
      messageId: `wamid.TEST-${randomUUID()}`,
      from: uniquePhone(),
      body: 'wrong secret',
    });
    const signature = whatsAppSignature('not-the-configured-secret', raw);
    const response = await postWhatsApp(harness, raw, { signature });
    expect(response.status).toBe(403);
  });

  it('ignores non-text WhatsApp messages without creating an empty ticket', async () => {
    const from = uniquePhone();
    harness.externalIds.push(from);
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-test-0001',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'pn-test-0001' },
                messages: [{ from, id: `wamid.IMG-${randomUUID()}`, type: 'image', image: { id: 'x' } }],
              },
            },
          ],
        },
      ],
    });
    const response = await postWhatsApp(harness, raw);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as IngestResponse;
    expect(payload.accepted).toBe(0);
    expect(payload.tickets).toEqual([]);
  });

  it('truncates a long English body to a 60-character subject and detects en', async () => {
    const from = uniquePhone();
    const messageId = `wamid.TEST-${randomUUID()}`;
    const body = `${'The bathroom exhaust fan stopped working and the wall is damp. '.repeat(3)}`.trim();
    harness.externalIds.push(from);
    expect(body.length).toBeGreaterThan(60);

    const response = await postWhatsApp(harness, whatsAppPayload({ messageId, from, body }));
    const payload = (await response.json()) as IngestResponse;
    const ticketId = payload.tickets[0]?.id;
    if (ticketId === undefined) throw new Error('no ticket id returned');
    harness.ticketIds.push(ticketId);

    const ticket = await readTicket(harness.sql, harness.org.id, ticketId);
    expect(ticket?.body_locale).toBe('en');
    expect(ticket?.subject).toBe(`${body.slice(0, 60).trimEnd()}…`);
    expect(Array.from(ticket?.subject ?? '')).toHaveLength(61);
  });

  it('accepts a signed Telegram update and enqueues the same triage contract', async () => {
    const userId = uniqueTelegramId();
    const updateId = Math.floor(Date.now() % 1_000_000) * 10 + 1;
    const text = 'The building elevator is stuck on the fourth floor.';
    const raw = telegramPayload({ updateId, userId, text });
    harness.externalIds.push(String(userId));

    const response = await postTelegram(harness, raw, harness.config.telegram.webhookSecret);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as IngestResponse;
    expect(payload.accepted).toBe(1);

    const ticketId = payload.tickets[0]?.id;
    if (ticketId === undefined) throw new Error('no ticket id returned');
    harness.ticketIds.push(ticketId);

    const ticket = await readTicket(harness.sql, harness.org.id, ticketId);
    expect(ticket).toMatchObject({
      channel: 'telegram',
      body: text,
      body_locale: 'en',
      status: 'new',
      emergency_flag: false,
    });

    const job = await harness.queue.getJob(ticketId);
    expect(job).toBeDefined();
    if (job === undefined) throw new Error('no triage job enqueued');
    expect(ticketIngestJobSchema.safeParse(job.data).success).toBe(true);
    expect((job.data as TicketIngestJob).idempotencyKey).toBe(`tg:${updateId}`);
    expect((job.data as TicketIngestJob).channel).toBe('telegram');
  });

  it('deduplicates a redelivered Telegram update', async () => {
    const userId = uniqueTelegramId();
    const updateId = Math.floor(Date.now() % 1_000_000) * 10 + 2;
    const text = 'المصعد واقف بالطابق الرابع';
    const raw = telegramPayload({ updateId, userId, text });
    harness.externalIds.push(String(userId));

    const first = await postTelegram(harness, raw, harness.config.telegram.webhookSecret);
    const firstBody = (await first.json()) as IngestResponse;
    const ticketId = firstBody.tickets[0]?.id;
    if (ticketId === undefined) throw new Error('no ticket id returned');
    harness.ticketIds.push(ticketId);

    const second = await postTelegram(harness, raw, harness.config.telegram.webhookSecret);
    const secondBody = (await second.json()) as IngestResponse;
    expect(secondBody.duplicates).toBe(1);
    expect(secondBody.tickets).toEqual([{ id: ticketId, duplicate: true }]);

    const ticket = await readTicket(harness.sql, harness.org.id, ticketId);
    expect(ticket?.body_locale).toBe('ar');
    expect(await countJobsForTicket(harness.queue, ticketId)).toBe(1);
  });

  it('rejects a Telegram POST with a wrong secret token and writes nothing', async () => {
    const userId = uniqueTelegramId();
    const updateId = Math.floor(Date.now() % 1_000_000) * 10 + 3;
    const raw = telegramPayload({ updateId, userId, text: 'should never become a ticket' });
    const ticketId = deterministicTicketId(`tg:${updateId}`);

    const wrong = await postTelegram(harness, raw, 'wrong-secret-token');
    expect(wrong.status).toBe(403);

    const missing = await postTelegram(harness, raw, null);
    expect(missing.status).toBe(401);

    expect(await readTicket(harness.sql, harness.org.id, ticketId)).toBeNull();
    expect(await harness.queue.getJob(ticketId)).toBeUndefined();
  });

  it('persists an outbound WhatsApp message locally when creds are absent (no fake success)', async () => {
    const from = uniquePhone();
    const messageId = `wamid.TEST-${randomUUID()}`;
    harness.externalIds.push(from);
    const ingest = await postWhatsApp(
      harness,
      whatsAppPayload({ messageId, from, body: 'حنشوف السباك بكرا الصبح' }),
    );
    const ingested = (await ingest.json()) as IngestResponse;
    const ticketId = ingested.tickets[0]?.id;
    if (ticketId === undefined) throw new Error('no ticket id returned');
    harness.ticketIds.push(ticketId);

    const result = await sendWhatsApp(
      harness.config.whatsapp,
      { sql: harness.sql, organizationId: harness.org.id, ticketId },
      { to: from, text: 'وصلنا طلبك، السباك بوصلك بكرا 9 الصبح.' },
    );
    expect(result.sent).toBe(false);
    if (result.sent) throw new Error('unreachable: expected not_configured');
    expect(result.reason).toBe('not_configured');
    expect(result.channel).toBe('whatsapp');

    const rows = await readOutboundMessages(harness.sql, harness.org.id, ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.messageId,
      channel: 'whatsapp',
      direction: 'outbound',
      body: 'وصلنا طلبك، السباك بوصلك بكرا 9 الصبح.',
      body_locale: 'ar',
      external_id: null,
    });
  });

  it('persists an outbound Telegram message locally when the bot token is absent', async () => {
    const userId = uniqueTelegramId();
    const updateId = Math.floor(Date.now() % 1_000_000) * 10 + 4;
    harness.externalIds.push(String(userId));
    const ingest = await postTelegram(
      harness,
      telegramPayload({ updateId, userId, text: 'The intercom is dead.' }),
      harness.config.telegram.webhookSecret,
    );
    const ingested = (await ingest.json()) as IngestResponse;
    const ticketId = ingested.tickets[0]?.id;
    if (ticketId === undefined) throw new Error('no ticket id returned');
    harness.ticketIds.push(ticketId);

    const result = await sendTelegram(
      harness.config.telegram,
      { sql: harness.sql, organizationId: harness.org.id, ticketId },
      { to: String(userId), text: 'A technician is booked for tomorrow 09:00.' },
    );
    expect(result.sent).toBe(false);
    if (result.sent) throw new Error('unreachable: expected not_configured');
    expect(result.reason).toBe('not_configured');

    const rows = await readOutboundMessages(harness.sql, harness.org.id, ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'telegram', external_id: null, body_locale: 'en' });
  });

  it('404s unknown routes', async () => {
    const response = await harness.app.request('/nope');
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'not_found' });
  });
});

describe('channels ingress without configured secrets (fail closed)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ whatsappAppSecret: '', telegramSecret: '' });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('rejects every WhatsApp POST when no app secret is configured', async () => {
    const raw = whatsAppPayload({
      messageId: `wamid.TEST-${randomUUID()}`,
      from: uniquePhone(),
      body: 'no secret configured',
    });
    const response = await postWhatsApp(harness, raw, { signature: whatsAppSignature('', raw) });
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'signature_not_configured',
    });
  });

  it('rejects every Telegram POST when no webhook secret is configured', async () => {
    const raw = telegramPayload({ updateId: 42, userId: 700000042, text: 'no secret configured' });
    const response = await postTelegram(harness, raw, '');
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'secret_token_not_configured',
    });
  });
});

/** Type-only guard: the queue used above is the frozen-contract queue. */
export type _QueueGuard = Queue<TicketIngestJob>;
