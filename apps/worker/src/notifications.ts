// The proactive engine: scan -> outbox -> relay -> budgeted dispatch.
//
// Three separate steps on purpose, and they must not collapse into one:
//
//   scan    writes an outbox row IN THE SAME TRANSACTION as the fact it
//           describes. The row is the promise that the fact is committed.
//   relay   turns published outbox rows into notification_intents, where the
//           unique dedupe key makes a re-scan a no-op instead of a second
//           WhatsApp message.
//   dispatch reads the interruption policy (@aqar/core/ops/interruption) and
//           either sends, defers past quiet hours, or records WHY it did not.
//           A silent skip is unmeasurable; a suppression row is data.
//
// Nothing here decides an amount or a date: those arrive as typed columns from
// SQL. The engine only decides *whether a human should be interrupted*.
import { randomUUID } from 'node:crypto';
import type { Sql } from '@aqar/db';
import { decideDispatch, type NotificationTier } from '@aqar/core';

export type ChannelName = 'whatsapp' | 'telegram' | 'email' | 'in_app' | 'log';

export interface OutboundMessage {
  readonly intentId: string;
  readonly channel: ChannelName;
  readonly title: string;
  readonly body: string;
}

/** A delivery mechanism. WhatsApp/email will implement this; tests fake it. */
export interface ChannelSender {
  readonly channel: ChannelName;
  /** Returns the provider's message id. Throwing means "not delivered". */
  send(message: OutboundMessage): Promise<string>;
}

/** Dev sender: records the delivery without contacting anybody. */
export function createLogSender(log: (line: string) => void): ChannelSender {
  return {
    channel: 'log',
    send: async (message) => {
      const id = `log-${randomUUID()}`;
      log(`[notifications] ${id} -> ${message.title} (${message.body.length} chars)`);
      return id;
    },
  };
}

export interface ScanResult {
  readonly leaseExpiring: number;
  readonly rentDueSoon: number;
  readonly rentOverdue: number;
  readonly slaBreach: number;
}

/**
 * The trigger a row actually represents.
 *
 * An SLA breach on an EMERGENCY ticket is not an operational ticket: it is an
 * unacknowledged safety report. It must leave the pipeline that gets batched
 * into a daily digest and become its own T0 interruption with its own
 * acknowledgement. A model cannot promote this — the emergency flag on the
 * ticket row did, deterministically, before any text was generated.
 */
function effectiveTrigger(row: { topic: string; payload: Record<string, unknown> }): string {
  const trigger = TRIGGER_OF_TOPIC[row.topic] ?? row.topic;
  if (trigger === 'ticket_sla_breach' && row.payload['emergency'] === true) {
    return 'emergency_unacknowledged';
  }
  return trigger;
}

/** Which tier a trigger deserves. Safety is T0; money is T1; the rest T2. */
const TRIGGER_TIER: Readonly<Record<string, NotificationTier>> = {
  ticket_sla_breach: 2,
  emergency_unacknowledged: 0,
  rent_overdue: 1,
  rent_due_soon: 2,
  lease_expiring: 2,
};

/**
 * Find facts worth interrupting a human about, and write them to the outbox.
 *
 * `ON CONFLICT DO NOTHING` on (organization_id, dedupe_key) is what makes this
 * idempotent: the scheduler runs every 15 minutes, and a lease expiring in 12
 * days stays expiring in 12 days for the next four runs.
 */
export async function scanTriggers(sql: Sql, orgId: string): Promise<ScanResult> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${orgId}, true)`;

    const leaseRows = await tx<
      { id: string; end_date: string; rent_fils: number; days_to_end: number }[]
    >`
      insert into outbox (id, organization_id, topic, dedupe_key, payload)
      select gen_random_uuid(), ${orgId}::uuid, 'lease.expiring', 'lease_expiring:lease:' || l.id || ':' || l.end_date,
             jsonb_build_object(
               'leaseId', l.id, 'propertyId', l.property_id,
               'endDate', l.end_date, 'daysToEnd', (l.end_date - current_date),
               'rentFils', l.rent_fils)
        from leases l
       where l.organization_id = ${orgId}::uuid
         and l.status = 'active'
         and l.end_date between current_date and current_date + 14
      on conflict (organization_id, dedupe_key) do nothing
      returning payload->>'endDate' as end_date,
                (payload->>'rentFils')::int as rent_fils,
                (payload->>'daysToEnd')::int as days_to_end,
                payload->>'leaseId' as id`;

    // A rent charge is "soon" three days out and "overdue" the day after it was
    // due, both computed as outstanding = amount - allocated, never as a status
    // flag somebody forgot to set.
    const dueRows = await tx<{ id: string }[]>`
      insert into outbox (id, organization_id, topic, dedupe_key, payload)
      select gen_random_uuid(), ${orgId}::uuid, 'rent.due_soon',
             'rent_due_soon:charge:' || c.id || ':' || c.period,
             jsonb_build_object('chargeId', c.id, 'leaseId', c.lease_id, 'period', c.period,
                                'dueDate', c.due_date, 'amountFils', c.amount_fils,
                                'outstandingFils', c.amount_fils - coalesce(a.allocated, 0))
        from charges c
        join leases l on l.id = c.lease_id
        left join (
          select charge_id, sum(amount_fils)::int as allocated
            from payment_allocations group by charge_id
        ) a on a.charge_id = c.id
       where c.organization_id = ${orgId}::uuid
         and c.kind = 'rent'
         and l.status = 'active'
         and c.due_date between current_date and current_date + 3
         and c.amount_fils - coalesce(a.allocated, 0) > 0
      on conflict (organization_id, dedupe_key) do nothing
      returning payload->>'chargeId' as id`;

    const overdueRows = await tx<{ id: string }[]>`
      insert into outbox (id, organization_id, topic, dedupe_key, payload)
      select gen_random_uuid(), ${orgId}::uuid, 'rent.overdue',
             -- cadence bucket: the same charge re-enters the outbox once a week
             -- while it stays outstanding.
             'rent_overdue:charge:' || q.id || ':' || q.period || ':w' || (current_date - q.due_date) / 7,
             jsonb_build_object('chargeId', q.id, 'leaseId', q.lease_id, 'period', q.period,
                                'dueDate', q.due_date, 'outstandingFils', q.outstanding,
                                'daysLate', (current_date - q.due_date))
        from (
          select c.id, c.lease_id, c.period, c.due_date,
                 c.amount_fils - coalesce(a.allocated, 0) as outstanding
            from charges c
            join leases l on l.id = c.lease_id
            left join (
              select charge_id, sum(amount_fils)::int as allocated
                from payment_allocations group by charge_id
            ) a on a.charge_id = c.id
           where c.organization_id = ${orgId}::uuid
             and c.kind = 'rent'
             and l.status = 'active'
             and c.due_date < current_date
        ) q
       where q.outstanding > 0
      on conflict (organization_id, dedupe_key) do nothing
      returning payload->>'chargeId' as id`;

    // A ticket open past the service standard and still nobody's job. The SLA
    // clock table is the authority; this uses opened_at so an unset clock
    // cannot hide an old ticket.
    const slaRows = await tx<{ id: string }[]>`
      insert into outbox (id, organization_id, topic, dedupe_key, payload)
      select gen_random_uuid(), ${orgId}::uuid, 'ticket.sla_breach',
             -- cadence bucket: an unowned ticket comes back once a day.
             'ticket_sla_breach:ticket:' || t.id || ':d' || floor(extract(epoch from (now() - t.opened_at)) / 86400)::int,
             jsonb_build_object('ticketId', t.id, 'propertyId', t.property_id,
                                'openedAt', t.opened_at, 'emergency', t.emergency_flag,
                                'hoursOpen', floor(extract(epoch from (now() - t.opened_at)) / 3600)::int)
        from tickets t
       where t.organization_id = ${orgId}::uuid
         and t.status not in ('completed', 'closed', 'cancelled')
         and t.opened_at < now() - interval '24 hours'
      on conflict (organization_id, dedupe_key) do nothing
      returning payload->>'ticketId' as id`;

    return {
      leaseExpiring: leaseRows.length,
      rentDueSoon: dueRows.length,
      rentOverdue: overdueRows.length,
      slaBreach: slaRows.length,
    };
  });
}

export interface RelayResult {
  readonly published: number;
  readonly intentsCreated: number;
}

const TRIGGER_OF_TOPIC: Readonly<Record<string, string>> = {
  'lease.expiring': 'lease_expiring',
  'rent.due_soon': 'rent_due_soon',
  'rent.overdue': 'rent_overdue',
  'ticket.sla_breach': 'ticket_sla_breach',
};

function titleFor(topic: string, payload: Record<string, unknown>): string {
  switch (topic) {
    case 'lease.expiring':
      return `Lease ends in ${String(payload['daysToEnd'])} days`;
    case 'rent.due_soon':
      return `Rent due ${String(payload['dueDate'])}`;
    case 'rent.overdue':
      return `Rent ${String(payload['daysLate'])} days late`;
    case 'ticket.sla_breach':
      return `Ticket open ${String(payload['hoursOpen'])}h`;
    case 'emergency_unacknowledged':
      return `EMERGENCY: ticket unacknowledged ${String(payload['hoursOpen'])}h`;
    default:
      return topic;
  }
}

function bodyFor(topic: string, payload: Record<string, unknown>): string {
  switch (topic) {
    case 'lease.expiring':
      return `Lease ${String(payload['leaseId'])} ends ${String(payload['endDate'])} at ${String(payload['rentFils'])} fils/month. Renew or release the unit.`;
    case 'rent.due_soon':
      return `Charge ${String(payload['chargeId'])} for ${String(payload['period'])} is due ${String(payload['dueDate'])}; ${String(payload['outstandingFils'])} fils outstanding.`;
    case 'rent.overdue':
      return `Charge ${String(payload['chargeId'])} for ${String(payload['period'])} was due ${String(payload['dueDate'])}; ${String(payload['outstandingFils'])} fils still outstanding.`;
    case 'ticket.sla_breach':
      return `Ticket ${String(payload['ticketId'])} has been open ${String(payload['hoursOpen'])} hours with no resolution.`;
    case 'emergency_unacknowledged':
      return `Emergency ticket ${String(payload['ticketId'])} has been open ${String(payload['hoursOpen'])} hours and no human has taken it. Treat as urgent: acknowledge now.`;
    default:
      return JSON.stringify(payload);
  }
}

/**
 * Triggers that coalesce into ONE daily message.
 *
 * This is the difference between a budget and a filter. Twenty-one overdue
 * charges at a cap of one T1 message per human per day is not "quiet", it is
 * three weeks of silence for the tenant at the back of the queue. Coalescing
 * turns the same budget into one message that says "21 rents overdue, oldest
 * 142 days" — the human still gets exactly one interruption, and the facts are
 * all in it.
 *
 * Safety is deliberately NOT a digest trigger: each emergency gets its own
 * intent, its own acknowledgement and its own terminal state.
 */
const DIGEST_TRIGGERS = new Set(['rent_overdue', 'ticket_sla_breach']);

function digestTitle(trigger: string, count: number): string {
  return trigger === 'rent_overdue'
    ? `${String(count)} rents overdue`
    : `${String(count)} tickets past SLA`;
}

function digestBody(trigger: string, rows: { payload: Record<string, unknown> }[]): string {
  if (trigger === 'rent_overdue') {
    const oldest = rows.reduce<number>(
      (max, row) => Math.max(max, Number(row.payload['daysLate'] ?? 0)),
      0,
    );
    const total = rows.reduce<number>(
      (sum, row) => sum + Number(row.payload['outstandingFils'] ?? 0),
      0,
    );
    return `${String(rows.length)} charges are past due, ${String(total)} fils outstanding in total; the oldest is ${String(oldest)} days late.`;
  }
  const worst = rows.reduce<number>(
    (max, row) => Math.max(max, Number(row.payload['hoursOpen'] ?? 0)),
    0,
  );
  return `${String(rows.length)} tickets have passed their service standard; the oldest has been open ${String(worst)} hours.`;
}

/** One unpublished outbox row as the relay sees it. */
interface OutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly dedupe_key: string;
  readonly payload: Record<string, unknown>;
}

/** Local calendar day in Asia/Amman, as YYYY-MM-DD. One digest per day. */
function ammanDay(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Amman',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return parts;
}

/**
 * Publish outbox rows into intents.
 *
 * The outbox row is marked published in the SAME transaction that creates the
 * intent, so a crash can replay a publish (deduped by the unique key) but can
 * never lose one.
 */
export async function relayOutbox(
  sql: Sql,
  orgId: string,
  options: { readonly now?: Date } = {},
): Promise<RelayResult> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${orgId}, true)`;

    const rows = await tx<OutboxRow[]>`
      select id, topic, dedupe_key, payload
        from outbox
       where organization_id = ${orgId}::uuid
         and published_at is null
       order by created_at
       limit 200
         for update skip locked`;

    const day = ammanDay(options.now ?? new Date());

    let created = 0;

    // Group the digest triggers by (trigger, day); everything else stays 1:1.
    const digestGroups = new Map<string, OutboxRow[]>();
    for (const row of rows) {
      const trigger = effectiveTrigger(row);
      if (!DIGEST_TRIGGERS.has(trigger)) continue;
      const group = digestGroups.get(trigger) ?? [];
      group.push(row);
      digestGroups.set(trigger, group);
    }

    for (const [trigger, group] of digestGroups) {
      const anchor = group[0];
      if (anchor === undefined) continue;
      const tier = TRIGGER_TIER[trigger] ?? 2;
      const entityType = trigger.startsWith('rent') ? 'charge' : 'ticket';
      const dedupeKey = `${trigger}:digest:${day}`;
      const identity = (item: Record<string, unknown>): string =>
        String(item['chargeId'] ?? item['ticketId'] ?? item['leaseId'] ?? '');

      // A digest that has not been delivered yet keeps counting. A digest that
      // has already gone out does not change under the human's eyes — the next
      // facts land in a later cadence bucket, not in a message they already read.
      const existing = await tx<
        { id: string; status: string; attempts: number; items: Record<string, unknown>[] }[]
      >`
        select id, status, attempts, coalesce(payload->'items', '[]'::jsonb) as items
          from notification_intents
         where organization_id = ${orgId}::uuid and dedupe_key = ${dedupeKey}
         limit 1`;

      const current = existing[0];
      if (current === undefined) {
        const payload = { day, count: group.length, items: group.map((row) => row.payload) };
        const inserted = await tx<{ id: string }[]>`
          insert into notification_intents
            (id, organization_id, trigger_key, dedupe_key, tier, channel, entity_type, entity_id,
             title, body, payload, expires_at)
          values
            (gen_random_uuid(), ${orgId}::uuid, ${trigger}, ${dedupeKey}, ${tier}, 'log',
             ${entityType}, ${anchor.id}::uuid,
             ${digestTitle(trigger, group.length)}, ${digestBody(trigger, group)},
             ${tx.json(payload)}, now() + interval '2 days')
          on conflict (organization_id, dedupe_key) do nothing
          returning id`;
        created += inserted.length;
        continue;
      }

      if (current.status !== 'open' || current.attempts > 0) continue;

      const merged = new Map<string, Record<string, unknown>>();
      for (const item of current.items) merged.set(identity(item), item);
      const before = merged.size;
      for (const row of group) merged.set(identity(row.payload), row.payload);
      if (merged.size === before) continue;

      const items = [...merged.values()];
      await tx`
        update notification_intents
           set payload = ${tx.json({ day, count: items.length, items })},
               title = ${digestTitle(trigger, items.length)},
               body = ${digestBody(
                 trigger,
                 items.map((item) => ({ payload: item })),
               )}
         where organization_id = ${orgId}::uuid and id = ${current.id}::uuid`;
    }

    for (const row of rows) {
      const trigger = effectiveTrigger(row);
      if (DIGEST_TRIGGERS.has(trigger)) continue;
      const tier = TRIGGER_TIER[trigger] ?? 2;
      const entityType = trigger.startsWith('lease')
        ? 'lease'
        : trigger.startsWith('rent')
          ? 'charge'
          : 'ticket';
      const entityId =
        (row.payload['leaseId'] as string | undefined) ??
        (row.payload['chargeId'] as string | undefined) ??
        (row.payload['ticketId'] as string | undefined) ??
        row.id;

      const inserted = await tx<{ id: string }[]>`
        insert into notification_intents
          (id, organization_id, trigger_key, dedupe_key, tier, channel, entity_type, entity_id,
           title, body, payload, expires_at)
        values
          (gen_random_uuid(), ${orgId}::uuid, ${trigger}, ${row.dedupe_key}, ${tier}, 'log',
           ${entityType}, ${entityId}::uuid, ${titleFor(row.topic, row.payload)},
           ${bodyFor(row.topic, row.payload)}, ${tx.json(row.payload)},
           now() + interval '7 days')
        on conflict (organization_id, dedupe_key) do nothing
        returning id`;
      created += inserted.length;
    }

    if (rows.length > 0) {
      await tx`
        update outbox set published_at = now(), attempts = attempts + 1
         where organization_id = ${orgId}::uuid
           and id = any(${rows.map((row) => row.id)}::uuid[])`;
    }

    return { published: rows.length, intentsCreated: created };
  });
}

export interface DispatchResult {
  readonly sent: number;
  readonly deferred: number;
  readonly suppressed: number;
}

/**
 * Deliver what the policy allows and record what it does not.
 *
 * Counts are read from `notification_sends` (the delivery ledger), not from
 * intent attempts: attempts measure how often we tried, the ledger measures how
 * often a human was actually disturbed.
 */
export async function dispatchPending(
  sql: Sql,
  orgId: string,
  options: {
    readonly now: Date;
    readonly localHour: number;
    readonly quietStartHour: number;
    readonly quietEndHour: number;
    readonly sender: ChannelSender;
  },
): Promise<DispatchResult> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${orgId}, true)`;

    const counts = await tx<{ human_today: number; org_today: number }[]>`
      select
        coalesce(sum(case when s.sent_at at time zone 'Asia/Amman'
                            >= date_trunc('day', ${options.now}::timestamptz at time zone 'Asia/Amman')
                          then 1 else 0 end), 0)::int as human_today,
        count(*)::int as org_today
        from notification_sends s
       where s.organization_id = ${orgId}::uuid
         and s.suppressed_reason is null
         and s.sent_at at time zone 'Asia/Amman'
             >= date_trunc('day', ${options.now}::timestamptz at time zone 'Asia/Amman')`;
    let orgToday = counts[0]?.org_today ?? 0;
    let humanToday = counts[0]?.human_today ?? 0;

    const pending = await tx<
      {
        id: string;
        tier: number;
        status: string;
        attempts: number;
        max_notifications: number;
        title: string;
        body: string;
      }[]
    >`
      select id, tier, status, attempts, max_notifications, title, body
        from notification_intents
       where organization_id = ${orgId}::uuid
         and status in ('open', 'notified')
       order by tier asc, created_at asc
       limit 50`;

    let sent = 0;
    let deferred = 0;
    let suppressed = 0;

    for (const intent of pending) {
      const tierForToday = await tx<{ c: number }[]>`
        select count(*)::int as c
          from notification_sends s
          join notification_intents i on i.id = s.intent_id
         where s.organization_id = ${orgId}::uuid
           and s.suppressed_reason is null
           and i.tier = ${intent.tier}
           and s.sent_at at time zone 'Asia/Amman'
               >= date_trunc('day', ${options.now}::timestamptz at time zone 'Asia/Amman')`;

      const decision = decideDispatch({
        status: intent.status as 'open' | 'notified',
        tier: intent.tier as NotificationTier,
        attempts: intent.attempts,
        maxNotifications: intent.max_notifications,
        localHour: options.localHour,
        quietStartHour: options.quietStartHour,
        quietEndHour: options.quietEndHour,
        humanSentToday: humanToday,
        humanSentTodayForTier: tierForToday[0]?.c ?? 0,
        orgSentToday: orgToday,
        channelEnabled: true,
      });

      if (decision.action === 'send') {
        const providerMessageId = await options.sender.send({
          intentId: intent.id,
          channel: options.sender.channel,
          title: intent.title,
          body: intent.body,
        });
        // sent_at is the DECISION instant, not now(): the budget queries compare
        // against the same clock the policy was evaluated with, so a replay, a
        // backfill or a simulated cycle sees its own sends.
        await tx`
          insert into notification_sends (id, organization_id, intent_id, channel, provider_message_id, sent_at)
          values (gen_random_uuid(), ${orgId}::uuid, ${intent.id}::uuid, ${options.sender.channel}, ${providerMessageId}, ${options.now})`;
        await tx`
          update notification_intents
             set attempts = attempts + 1, last_notified_at = ${options.now}, status = 'notified'
           where organization_id = ${orgId}::uuid and id = ${intent.id}::uuid`;
        sent += 1;
        // Advance the counters as we send: the caps are read once per cycle, so
        // without this a burst of intents inside one cycle could blow past both.
        humanToday += 1;
        orgToday += 1;
        continue;
      }

      const reason = decision.action === 'defer' ? 'quiet_hours' : decision.reason;

      // One suppression row per intent per reason per day: this is evidence the
      // policy ran, not a log of every 15-minute tick.
      await tx`
        insert into notification_sends (id, organization_id, intent_id, channel, suppressed_reason, sent_at)
        select gen_random_uuid(), ${orgId}::uuid, ${intent.id}::uuid, ${options.sender.channel}, ${reason}, ${options.now}
         where not exists (
           select 1 from notification_sends s
            where s.intent_id = ${intent.id}::uuid
              and s.suppressed_reason = ${reason}
              and s.sent_at at time zone 'Asia/Amman'
                  >= date_trunc('day', ${options.now}::timestamptz at time zone 'Asia/Amman'))`;

      if (decision.action === 'defer') deferred += 1;
      else suppressed += 1;

      if (reason === 'max_notifications') {
        await tx`
          update notification_intents set status = 'expired', closed_at = now()
           where organization_id = ${orgId}::uuid and id = ${intent.id}::uuid`;
      }
    }

    return { sent, deferred, suppressed };
  });
}

/**
 * Close out what nobody answered. Expiry is a terminal state, not a retry:
 * re-notifying an unanswered intent forever is how an agent gets muted.
 */
export async function expireUnanswered(sql: Sql, orgId: string, now: Date): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${orgId}, true)`;
    const rows = await tx<{ id: string }[]>`
      update notification_intents
         set status = 'expired', closed_at = now()
       where organization_id = ${orgId}::uuid
         and status in ('open', 'notified')
         and (expires_at is not null and expires_at < ${now})
      returning id`;
    return rows.length;
  });
}
