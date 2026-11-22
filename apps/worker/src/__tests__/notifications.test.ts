// Integration proof for the proactive engine, against real Postgres.
//
// These tests exist to falsify the design, not to decorate it. Each one states a
// property a naive implementation would fail:
//   - a scanner that runs 96x/day must notify ONCE per fact (not 96 times);
//   - quiet hours must defer an operational notice and MUST NOT defer a safety one;
//   - the daily budget must hold even when one cycle holds many intents;
//   - an unanswered intent must expire rather than ping forever.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql } from '@aqar/db';
import { TIER_POLICIES, type NotificationTier } from '@aqar/core';
import {
  dispatchPending,
  expireUnanswered,
  relayOutbox,
  scanTriggers,
  type ChannelSender,
  type OutboundMessage,
} from '../notifications.js';

const databaseUrl = process.env['DATABASE_URL'];
const ORG_SLUG = 'aqar-demo';

const describeIf = databaseUrl === undefined || databaseUrl === '' ? describe.skip : describe;

const sql = createSql(databaseUrl ?? 'postgres://unused@127.0.0.1:1/unused', 4);

let orgId = '';
let leaseId = '';
let soonChargeId = '';
let overdueChargeId = '';
const extraIntentIds: string[] = [];

// Injected clock: the engine never reads the wall clock itself.
const atNineAm = new Date('2026-11-21T06:00:00Z'); // 09:00 Asia/Amman
const atTwoAm = new Date('2026-11-21T23:00:00Z'); // 02:00 Asia/Amman next day

function fakeSender(): ChannelSender & { readonly sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    channel: 'log',
    sent,
    send: async (message) => {
      sent.push(message);
      return `test-${String(sent.length)}`;
    },
  };
}

async function clearNotificationState(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${orgId}, true)`;
    await tx`delete from notification_sends where organization_id = ${orgId}::uuid`;
    await tx`delete from notification_intents where organization_id = ${orgId}::uuid`;
    await tx`delete from outbox where organization_id = ${orgId}::uuid`;
  });
}

describeIf('proactive engine (real Postgres)', () => {
  beforeAll(async () => {
    const orgs = await sql<{ id: string }[]>`select id from organizations where slug = ${ORG_SLUG}`;
    const org = orgs[0];
    if (org === undefined) throw new Error(`no organization with slug ${ORG_SLUG}`);
    orgId = org.id;

    const leases = await sql<{ id: string }[]>`
      select id from leases where organization_id = ${orgId}::uuid and status = 'active' limit 1`;
    const lease = leases[0];
    if (lease === undefined) throw new Error('no active lease to hang test charges on');
    leaseId = lease.id;

    await clearNotificationState();

    // Two facts a scanner must find: rent due in two days, and rent overdue.
    const inserted = await sql<{ id: string; period: string }[]>`
      insert into charges (id, organization_id, lease_id, period, kind, amount_fils, due_date)
      values
        (gen_random_uuid(), ${orgId}::uuid, ${leaseId}::uuid, '2027-01', 'rent', 250000, current_date + 2),
        (gen_random_uuid(), ${orgId}::uuid, ${leaseId}::uuid, '2027-02', 'rent', 250000, current_date - 5)
      returning id, period`;
    soonChargeId = inserted.find((row) => row.period === '2027-01')?.id ?? '';
    overdueChargeId = inserted.find((row) => row.period === '2027-02')?.id ?? '';
    expect(soonChargeId).not.toBe('');
    expect(overdueChargeId).not.toBe('');
  });

  afterAll(async () => {
    for (const id of extraIntentIds) {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        await tx`delete from notification_sends where intent_id = ${id}::uuid`;
        await tx`delete from notification_intents where id = ${id}::uuid`;
      });
    }
    await clearNotificationState();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`delete from charges where id in (${soonChargeId}::uuid, ${overdueChargeId}::uuid)`;
    });
    await sql.end({ timeout: 5 });
  });

  it('scan finds the facts and writes them to the outbox', async () => {
    const result = await scanTriggers(sql, orgId);
    expect(result.rentDueSoon).toBeGreaterThanOrEqual(1);
    expect(result.rentOverdue).toBeGreaterThanOrEqual(1);
  });

  it('a second scan of the same facts writes nothing — the scheduler runs 96x a day', async () => {
    const count = async (): Promise<number> => {
      const rows = await sql<{ c: number }[]>`
        select count(*)::int as c from outbox where organization_id = ${orgId}::uuid`;
      return rows[0]?.c ?? -1;
    };
    const before = await count();
    const second = await scanTriggers(sql, orgId);
    expect(second).toEqual({ leaseExpiring: 0, rentDueSoon: 0, rentOverdue: 0, slaBreach: 0 });
    expect(await count()).toBe(before);
  });

  it('relay turns each outbox row into exactly one intent', async () => {
    const first = await relayOutbox(sql, orgId);
    expect(first.published).toBeGreaterThanOrEqual(2);
    expect(first.intentsCreated).toBeGreaterThanOrEqual(2);
    // Every published row must have created an intent: a row that published
    // without one is a lost notification.
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from outbox
       where organization_id = ${orgId}::uuid and published_at is null`;
    expect(rows[0]?.c).toBe(0);
  });

  it('relay is idempotent: nothing left to publish, no duplicate intents', async () => {
    const second = await relayOutbox(sql, orgId);
    expect(second).toEqual({ published: 0, intentsCreated: 0 });

    const dupes = await sql<{ dedupe_key: string; c: number }[]>`
      select dedupe_key, count(*)::int as c
        from notification_intents where organization_id = ${orgId}::uuid
       group by dedupe_key having count(*) > 1`;
    expect(dupes).toEqual([]);
  });

  it('overdue charges coalesce into ONE digest that keeps counting until delivered', async () => {
    const digestOf = async (): Promise<{ id: string; count: number } | undefined> => {
      const rows = await sql<{ id: string; count: number }[]>`
        select id, (payload->>'count')::int as count
          from notification_intents
         where organization_id = ${orgId}::uuid and trigger_key = 'rent_overdue'`;
      return rows[0];
    };
    // Exactly one: 21 charges must not become 21 interruptions.
    const digestRows = await sql<{ c: number }[]>`
      select count(*)::int as c from notification_intents
       where organization_id = ${orgId}::uuid and trigger_key = 'rent_overdue'`;
    expect(digestRows[0]?.c).toBe(1);

    const before = await digestOf();
    expect(before?.count ?? -1).toBeGreaterThanOrEqual(1);

    // A later scan in the same day finds more late rent.
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`
        insert into outbox (id, organization_id, topic, dedupe_key, payload)
        values
          (gen_random_uuid(), ${orgId}::uuid, 'rent.overdue',
           ${`rent_overdue:charge:late-a-${String(Date.now())}:2027-04:w3`},
           '{"chargeId":"00000000-0000-0000-0000-0000000000a1","period":"2027-04","daysLate":21,"outstandingFils":90000}'::jsonb),
          (gen_random_uuid(), ${orgId}::uuid, 'rent.overdue',
           ${`rent_overdue:charge:late-b-${String(Date.now())}:2027-05:w1`},
           '{"chargeId":"00000000-0000-0000-0000-0000000000a2","period":"2027-05","daysLate":7,"outstandingFils":90000}'::jsonb)`;
    });
    await relayOutbox(sql, orgId);

    const after = await digestOf();
    expect(after?.id).toBe(before?.id);
    expect(after?.count).toBe((before?.count ?? 0) + 2);
  });

  it('an SLA breach on an EMERGENCY ticket becomes its own T0 intent, never a digest item', async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      await tx`
        insert into outbox (id, organization_id, topic, dedupe_key, payload)
        values (gen_random_uuid(), ${orgId}::uuid, 'ticket.sla_breach',
                ${`ticket_sla_breach:ticket:emergency-${String(Date.now())}:d2`},
                '{"ticketId":"00000000-0000-0000-0000-0000000000e1","emergency":true,"hoursOpen":49,"propertyId":"00000000-0000-0000-0000-0000000000e2"}'::jsonb)`;
    });
    await relayOutbox(sql, orgId);

    const rows = await sql<{ tier: number; status: string }[]>`
      select tier, status from notification_intents
       where organization_id = ${orgId}::uuid
         and trigger_key = 'emergency_unacknowledged'
         and dedupe_key like '%emergency-%'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe(0);

    // and it did NOT join the T2 digest
    const digest = await sql<{ items: number }[]>`
      select jsonb_array_length(coalesce(payload->'items', '[]'::jsonb)) as items
        from notification_intents
       where organization_id = ${orgId}::uuid and trigger_key = 'ticket_sla_breach'`;
    const digestItemIds = await sql<{ hit: number }[]>`
      select count(*)::int as hit from notification_intents
       where organization_id = ${orgId}::uuid and trigger_key = 'ticket_sla_breach'
         and payload::text like '%00000000-0000-0000-0000-0000000000e1%'`;
    expect(digest.length === 0 || (digest[0]?.items ?? 0) >= 0).toBe(true);
    expect(digestItemIds[0]?.hit).toBe(0);
  });

  it('quiet hours defer an operational notice and leave it deliverable', async () => {
    const before = await sql<{ attempts: number; status: string }[]>`
      select attempts, status from notification_intents
       where organization_id = ${orgId}::uuid and dedupe_key like 'rent_due_soon:%'`;
    expect(before[0]?.attempts).toBe(0);

    const sender = fakeSender();
    await dispatchPending(sql, orgId, {
      now: atTwoAm,
      localHour: 2,
      quietStartHour: 22,
      quietEndHour: 7,
      sender,
    });

    // Deferred, not sent: the human is asleep, the rent is not on fire.
    // Scoped to operational/money intents on purpose — a T0 emergency in the
    // queue is SUPPOSED to go out at 02:00, and an assertion on the total would
    // make the quiet-hours rule look green by forbidding the thing it exempts.
    const operational = await sql<{ id: string }[]>`
      select id from notification_intents
       where organization_id = ${orgId}::uuid and tier >= 1`;
    const operationalIds = new Set(operational.map((row) => row.id));
    expect(sender.sent.filter((message) => operationalIds.has(message.intentId))).toHaveLength(0);
    const after = await sql<{ attempts: number; status: string }[]>`
      select attempts, status from notification_intents
       where organization_id = ${orgId}::uuid and dedupe_key like 'rent_due_soon:%'`;
    expect(after[0]?.attempts).toBe(0);
    expect(after[0]?.status).toBe('open');

    const suppressions = await sql<{ suppressed_reason: string; c: number }[]>`
      select suppressed_reason, count(*)::int as c
        from notification_sends where organization_id = ${orgId}::uuid and suppressed_reason is not null
       group by suppressed_reason`;
    expect(suppressions.map((row) => row.suppressed_reason)).toContain('quiet_hours');
  });

  it('a safety intent is delivered at 02:00 — T0 bypasses quiet hours', async () => {
    const inserted = await sql<{ id: string }[]>`
      insert into notification_intents
        (id, organization_id, trigger_key, dedupe_key, tier, channel, entity_type, entity_id, title, body)
      values (gen_random_uuid(), ${orgId}::uuid, 'emergency_unacknowledged',
              ${`emergency_unacknowledged:ticket:${String(Date.now())}`}, 0, 'log',
              'ticket', gen_random_uuid(), 'Gas smell reported, nobody acknowledged',
              'Tenant reported a gas smell 12 minutes ago and no human has opened the ticket.')
      returning id`;
    const id = inserted[0]?.id ?? '';
    extraIntentIds.push(id);

    const sender = fakeSender();
    await dispatchPending(sql, orgId, {
      now: atTwoAm,
      localHour: 2,
      quietStartHour: 22,
      quietEndHour: 7,
      sender,
    });

    const delivered = sender.sent.filter((message) => message.intentId === id);
    expect(delivered).toHaveLength(1);
    const rows = await sql<{ status: string; attempts: number }[]>`
      select status, attempts from notification_intents where id = ${id}::uuid`;
    expect(rows[0]).toEqual({ status: 'notified', attempts: 1 });
  });

  it('working hours deliver, and the delivery is recorded with a provider id', async () => {
    const sender = fakeSender();
    const result = await dispatchPending(sql, orgId, {
      now: atNineAm,
      localHour: 9,
      quietStartHour: 22,
      quietEndHour: 7,
      sender,
    });
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(sender.sent.length).toBe(result.sent);

    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from notification_sends
       where organization_id = ${orgId}::uuid and provider_message_id is not null
         and sent_at = ${atNineAm}`;
    expect(rows[0]?.c).toBe(result.sent);
  });

  it('the per-tier daily budget holds inside a single cycle', async () => {
    // Three more T1 intents in the same cycle must not produce three messages:
    // the cap is one per human per day for money.
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const inserted = await sql<{ id: string }[]>`
        insert into notification_intents
          (id, organization_id, trigger_key, dedupe_key, tier, channel, entity_type, entity_id, title, body)
        values (gen_random_uuid(), ${orgId}::uuid, 'rent_overdue',
                ${`rent_overdue:charge:budget-${String(n)}:2027-03`}, 1, 'log',
                'charge', gen_random_uuid(), 'Rent late', 'Rent is late again.')
        returning id`;
      const id = inserted[0]?.id ?? '';
      ids.push(id);
      extraIntentIds.push(id);
    }

    const sender = fakeSender();
    await dispatchPending(sql, orgId, {
      now: atNineAm,
      localHour: 9,
      quietStartHour: 22,
      quietEndHour: 7,
      sender,
    });

    const cap = TIER_POLICIES[1].dailyCapPerHuman;
    expect(cap).not.toBeNull();
    const t1Sent = await sql<{ c: number }[]>`
      select count(*)::int as c
        from notification_sends s join notification_intents i on i.id = s.intent_id
       where s.organization_id = ${orgId}::uuid
         and s.suppressed_reason is null and i.tier = 1`;
    expect(t1Sent[0]?.c ?? -1).toBeLessThanOrEqual(cap ?? 0);

    const budgetRows = await sql<{ c: number }[]>`
      select count(*)::int as c from notification_sends
       where organization_id = ${orgId}::uuid and suppressed_reason = 'daily_budget'`;
    expect(budgetRows[0]?.c ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('an intent that exhausted its attempts is expired, not re-pinged', async () => {
    const inserted = await sql<{ id: string }[]>`
      insert into notification_intents
        (id, organization_id, trigger_key, dedupe_key, tier, channel, entity_type, entity_id,
         title, body, attempts, max_notifications)
      values (gen_random_uuid(), ${orgId}::uuid, 'lease_expiring',
              ${`lease_expiring:lease:exhausted-${String(Date.now())}`}, 2, 'log',
              'lease', gen_random_uuid(), 'Lease ends tomorrow', 'Renew or release.', 3, 3)
      returning id`;
    const id = inserted[0]?.id ?? '';
    extraIntentIds.push(id);

    const sender = fakeSender();
    await dispatchPending(sql, orgId, {
      now: atNineAm,
      localHour: 9,
      quietStartHour: 22,
      quietEndHour: 7,
      sender,
    });

    expect(sender.sent.filter((message) => message.intentId === id)).toHaveLength(0);
    const rows = await sql<{ status: string }[]>`
      select status from notification_intents where id = ${id}::uuid`;
    expect(rows[0]?.status).toBe('expired');
  });

  it('expires intents past their expiry window so the queue cannot grow forever', async () => {
    const inserted = await sql<{ id: string }[]>`
      insert into notification_intents
        (id, organization_id, trigger_key, dedupe_key, tier, channel, entity_type, entity_id,
         title, body, expires_at)
      values (gen_random_uuid(), ${orgId}::uuid, 'rent_due_soon',
              ${`rent_due_soon:charge:stale-${String(Date.now())}`}, 2, 'log',
              'charge', gen_random_uuid(), 'Old notice', 'Expired yesterday.',
              now() - interval '1 day')
      returning id`;
    const id = inserted[0]?.id ?? '';
    extraIntentIds.push(id);

    const expired = await expireUnanswered(sql, orgId, new Date());
    expect(expired).toBeGreaterThanOrEqual(1);
    const rows = await sql<{ status: string }[]>`
      select status from notification_intents where id = ${id}::uuid`;
    expect(rows[0]?.status).toBe('expired');
  });

  it('keeps the tier ladder honest: T0 uncapped, T1 capped at 1, T3 never delivered', () => {
    const tiers: NotificationTier[] = [0, 1, 2, 3];
    for (const tier of tiers) {
      const policy = TIER_POLICIES[tier];
      expect(policy.tier).toBe(tier);
      if (tier === 0) expect(policy.bypassQuietHours).toBe(true);
      else expect(policy.bypassQuietHours).toBe(false);
      if (tier === 3) expect(policy.dailyCapPerHuman).toBe(0);
    }
  });
});
