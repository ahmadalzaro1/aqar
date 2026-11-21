import type { Db } from '../client.js';
import { createDb } from '../client.js';
import { withOrganization } from '../client.js';
import { migrateDown, migrateUp } from '../migrate.js';
import { units } from '../schema/index.js';
import { runSeed } from '../seed.js';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  APP_URL,
  TEST_URL,
  createFixture,
  resetSchema,
  type Fixture,
} from './helpers.js';

let sql: postgres.Sql;
let appSql: postgres.Sql;
let appDb: Db;

beforeAll(async () => {
  await resetSchema();
  sql = postgres(TEST_URL, { max: 4, prepare: false });
  appSql = postgres(APP_URL, { max: 2, prepare: false });
  const created = createDb(APP_URL, 2);
  appDb = created.db;
});

afterAll(async () => {
  await appSql?.end({ timeout: 5 });
  await sql?.end({ timeout: 5 });
});

describe('(1) migrations', () => {
  it('up -> down -> up cycle succeeds and leaves the schema applied', async () => {
    const up = await migrateUp(TEST_URL);
    expect(Array.isArray(up.applied)).toBe(true);

    const down = await migrateDown(TEST_URL, 99);
    expect(down.reverted.length).toBeGreaterThanOrEqual(2);
    const gone = await sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = 'charges'`;
    expect(gone[0]?.n).toBe(0);

    const again = await migrateUp(TEST_URL);
    expect(again.applied.length).toBeGreaterThanOrEqual(2);
    const back = await sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = 'charges'`;
    expect(back[0]?.n).toBe(1);
  });
});

describe('(2) row-level security', () => {
  it('isolates tenants and fails closed without an organization GUC', async () => {
    const a = await createFixture(sql, `rls-a-${randomUUID().slice(0, 8)}`);
    const b = await createFixture(sql, `rls-b-${randomUUID().slice(0, 8)}`);

    const seenByA = await withOrganization(appDb, a.orgId, async (tx) =>
      tx.select({ id: units.id, organizationId: units.organizationId }).from(units),
    );
    expect(seenByA.length).toBe(1);
    expect(seenByA[0]?.organizationId).toBe(a.orgId);
    expect(seenByA.some((row) => row.organizationId === b.orgId)).toBe(false);

    // No GUC set at all => zero tenant rows (fail closed, not "see everything").
    const unfiltered = await appSql`select count(*)::int as n from units where organization_id = ${b.orgId}`;
    expect(unfiltered[0]?.n).toBe(0);

    // Writing another tenant's row while scoped to A is rejected by WITH CHECK.
    await expect(
      withOrganization(appDb, a.orgId, async (tx) =>
        tx.insert(units).values({
          id: randomUUID(),
          organizationId: b.orgId,
          propertyId: b.propertyId,
          buildingId: randomUUID(),
          unitNumber: `EVIL-${randomUUID().slice(0, 6)}`,
          marketRentFils: 1000,
          status: 'vacant',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('(3) audit_events is append-only', () => {
  it('rejects UPDATE and DELETE', async () => {
    const orgId = randomUUID();
    const id = randomUUID();
    await sql`insert into organizations (id, name, name_ar, slug, timezone, currency)
              values (${orgId}, 'Audit Org', 'مؤسسة تدقيق', ${'audit-' + orgId.slice(0, 8)}, 'Asia/Amman', 'JOD')`;
    await sql`insert into audit_events (id, organization_id, actor, action, entity_type, entity_id, idempotency_key, occurred_at)
              values (${id}, ${orgId}, ${sql.json({ type: 'system', component: 'test' })}, 'test.create', 'organization', ${orgId}, ${'test:' + id}, now())`;

    await expect(sql`update audit_events set action = 'tampered' where id = ${id}`).rejects.toThrow();
    await expect(sql`delete from audit_events where id = ${id}`).rejects.toThrow();
    const still = await sql`select action from audit_events where id = ${id}`;
    expect(still[0]?.action).toBe('test.create');
  });
});

describe('(4) journal balance trigger', () => {
  it('rejects posting an unbalanced entry', async () => {
    const fx = await createFixture(sql, `jrn-${randomUUID().slice(0, 8)}`);
    const entryId = randomUUID();
    await sql`insert into journal_entries (id, organization_id, entry_date, period, memo, posted, source_type, source_id)
              values (${entryId}, ${fx.orgId}, '2026-03-01', '2026-03', 'unbalanced attempt', false, 'test', 'test:unbalanced')`;
    await sql`insert into journal_lines (organization_id, entry_id, account_code, debit_fils, credit_fils, memo, source_type, source_id, period)
              values (${fx.orgId}, ${entryId}, 'tenant_ar', 100000, 0, 'dr', 'test', 'test:unbalanced', '2026-03'),
                     (${fx.orgId}, ${entryId}, 'income', 0, 90000, 'cr', 'test', 'test:unbalanced', '2026-03')`;

    await expect(
      sql`update journal_entries set posted = true, posted_at = now() where id = ${entryId}`,
    ).rejects.toThrow(/balance|unbalanced/i);

    const posted = await sql`select posted from journal_entries where id = ${entryId}`;
    expect(posted[0]?.posted).toBe(false);
  });

  it('accepts a balanced entry posted the same way', async () => {
    const fx = await createFixture(sql, `jrn-ok-${randomUUID().slice(0, 8)}`);
    const entryId = randomUUID();
    await sql`insert into journal_entries (id, organization_id, entry_date, period, memo, posted, source_type, source_id)
              values (${entryId}, ${fx.orgId}, '2026-03-01', '2026-03', 'balanced', false, 'test', 'test:balanced')`;
    await sql`insert into journal_lines (organization_id, entry_id, account_code, debit_fils, credit_fils, memo, source_type, source_id, period)
              values (${fx.orgId}, ${entryId}, 'tenant_ar', 100000, 0, 'dr', 'test', 'test:balanced', '2026-03'),
                     (${fx.orgId}, ${entryId}, 'income', 0, 100000, 'cr', 'test', 'test:balanced', '2026-03')`;
    await sql`update journal_entries set posted = true, posted_at = now() where id = ${entryId}`;
    const posted = await sql`select posted from journal_entries where id = ${entryId}`;
    expect(posted[0]?.posted).toBe(true);
  });
});

describe('(5) period locks', () => {
  it('rejects charge AND payment writes into a locked period', async () => {
    const fx = await createFixture(sql, `lock-${randomUUID().slice(0, 8)}`);
    await sql`insert into period_locks (id, organization_id, period, reason)
              values (${randomUUID()}, ${fx.orgId}, '2026-01', 'month-end close')`;

    await expect(
      sql`insert into charges (id, organization_id, lease_id, period, kind, amount_fils, due_date)
          values (${randomUUID()}, ${fx.orgId}, ${fx.leaseId}, '2026-01', 'rent', 400000, '2026-01-01')`,
    ).rejects.toThrow(/locked/);

    await expect(
      sql`insert into payments (id, organization_id, payer_id, amount_fils, received_date, method, reference_period)
          values (${randomUUID()}, ${fx.orgId}, ${fx.tenantId}, 400000, '2026-01-03', 'cash', '2026-01')`,
    ).rejects.toThrow(/locked/);

    // An open period is still writable.
    await sql`insert into charges (id, organization_id, lease_id, period, kind, amount_fils, due_date)
              values (${randomUUID()}, ${fx.orgId}, ${fx.leaseId}, '2026-02', 'rent', 400000, '2026-02-01')`;
    const open = await sql`select count(*)::int as n from charges where organization_id = ${fx.orgId}`;
    expect(open[0]?.n).toBe(1);
  });
});

describe('(6) emergency flag is sticky', () => {
  it('rejects true -> false and keeps the flag on body edits', async () => {
    const fx = await createFixture(sql, `emg-${randomUUID().slice(0, 8)}`);
    const ticketId = randomUUID();
    await sql`insert into tickets (id, organization_id, property_id, unit_id, tenant_id, channel, status, opened_at, subject, body, body_locale, emergency_flag)
              values (${ticketId}, ${fx.orgId}, ${fx.propertyId}, ${fx.unitId}, ${fx.tenantId}, 'whatsapp', 'new', now(),
                      'ريحة غاز قوية بالمطبخ', 'ريحة غاز قوية بالمطبخ', 'ar', true)`;

    await expect(
      sql`update tickets set emergency_flag = false where id = ${ticketId}`,
    ).rejects.toThrow(/emergency/i);

    await sql`update tickets set body = 'ريحة غاز خفت شوي بس لسا موجودة' where id = ${ticketId}`;
    const kept = await sql`select emergency_flag from tickets where id = ${ticketId}`;
    expect(kept[0]?.emergency_flag).toBe(true);
  });
});

describe('(7) seed integrity', () => {
  it('seeds the full demo estate and is idempotent', async () => {
    const first = await runSeed(TEST_URL);

    expect(first.units).toBe(24);
    expect(first.tenants).toBe(18);
    expect(first.leases).toBe(18);
    expect(first.properties).toBe(2);
    expect(first.buildings).toBe(2);
    expect(first.users).toBe(4);
    expect(first.vendors).toBe(4);
    expect(first.tickets).toBe(42);
    expect(first.emergencyTickets).toBe(3);
    expect(first.bankStatements).toBe(2);
    expect(first.owners).toBe(7);
    expect(first.charges).toBeGreaterThanOrEqual(90);
    expect(first.journalEntries).toBeGreaterThanOrEqual(10);

    // Ownership shares sum to exactly 10000 bps per property.
    const shareSums = await sql`
      select property_id, sum(share_bps)::int as bps
        from ownership_shares group by property_id`;
    expect(shareSums.length).toBe(2);
    for (const row of shareSums) expect(row.bps).toBe(10000);

    // Overlapping bank lines: same fingerprint in two statements, deduped to one row.
    const overlap = await sql`
      select fingerprint, count(distinct statement_id)::int as statements
        from bank_lines group by fingerprint having count(distinct statement_id) > 1`;
    expect(overlap.length).toBeGreaterThanOrEqual(3);

    // One bounced cheque and one cash receipt.
    const methods = await sql`
      select method::text as method, count(*)::int as n,
             count(*) filter (where cheque_status = 'bounced')::int as bounced
        from payments group by 1 order by 1`;
    const cheque = methods.find((m) => m.method === 'cheque');
    expect(cheque?.bounced).toBe(1);
    const cash = methods.find((m) => m.method === 'cash');
    expect(cash?.n).toBeGreaterThanOrEqual(1);

    const second = await runSeed(TEST_URL);
    expect(second).toEqual(first);

    // Uniqueness domain is (building_id, unit_number) — the same flat number
    // legitimately exists in both buildings. Grouping by unit_number alone
    // would flag correct data as duplicates.
    const dupUnits = await sql`
      select count(*)::int as n from (
        select building_id, unit_number from units
         where organization_id = (select id from organizations where slug = 'aqar-demo')
         group by building_id, unit_number having count(*) > 1) d`;
    expect(dupUnits[0]?.n).toBe(0);
    const ticketCount = await sql`
      select count(*)::int as n from tickets
       where organization_id = (select id from organizations where slug = 'aqar-demo')`;
    expect(ticketCount[0]?.n).toBe(42);
  });
});

describe('(8) cheque bounce reversal', () => {
  it('restores the exact prior outstanding balance', async () => {
    const fx: Fixture = await createFixture(sql, `chq-${randomUUID().slice(0, 8)}`);
    const chargeId = randomUUID();
    const paymentId = randomUUID();
    const allocationId = randomUUID();

    await sql`insert into charges (id, organization_id, lease_id, period, kind, amount_fils, due_date)
              values (${chargeId}, ${fx.orgId}, ${fx.leaseId}, '2026-04', 'rent', 500000, '2026-04-01')`;
    const before = await sql`
      select amount_fils - coalesce((select sum(amount_fils) from payment_allocations where charge_id = ${chargeId}), 0) as outstanding
        from charges where id = ${chargeId}`;
    expect(Number(before[0]?.outstanding)).toBe(500000);

    await sql`insert into payments (id, organization_id, payer_id, amount_fils, received_date, method, cheque_status, reference_period)
              values (${paymentId}, ${fx.orgId}, ${fx.tenantId}, 500000, '2026-04-05', 'cheque', 'received', '2026-04')`;
    await sql`update payments set cheque_status = 'deposited' where id = ${paymentId}`;
    await sql`insert into payment_allocations (id, organization_id, payment_id, charge_id, amount_fils, allocated_at)
              values (${allocationId}, ${fx.orgId}, ${paymentId}, ${chargeId}, 500000, now())`;

    const paid = await sql`
      select amount_fils - (select sum(amount_fils) from payment_allocations where charge_id = ${chargeId}) as outstanding
        from charges where id = ${chargeId}`;
    expect(Number(paid[0]?.outstanding)).toBe(0);

    // Bounce: status moves to bounced and the allocation is reversed.
    await sql`update payments set cheque_status = 'bounced' where id = ${paymentId}`;
    await sql`delete from payment_allocations where payment_id = ${paymentId}`;

    const after = await sql`
      select c.amount_fils - coalesce((select sum(a.amount_fils) from payment_allocations a where a.charge_id = c.id), 0) as outstanding
        from charges c where c.id = ${chargeId}`;
    expect(Number(after[0]?.outstanding)).toBe(500000);
    expect(Number(before[0]?.outstanding)).toBe(Number(after[0]?.outstanding));

    const status = await sql`select cheque_status::text as s from payments where id = ${paymentId}`;
    expect(status[0]?.s).toBe('bounced');
  });
});

describe('proposal_approvals — dual control, enforced by the key and not the handler', () => {
  const insertProposal = async (orgId: string): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      insert into action_proposals (organization_id, tool_name, action, args, args_hash, summary, requested_by, expires_at)
      values (${orgId}, 'propose_payment', 'post_payment', '{}'::jsonb, 'hash-' || ${randomUUID()}, 'dual-control fixture',
              '{"kind":"agent","name":"test","model":"test"}'::jsonb, now() + interval '1 hour')
      returning id`;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('proposal insert returned no row');
    return id;
  };

  const insertUser = async (orgId: string, role: string): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      insert into users (organization_id, email, password_hash, role, name_en, name_ar)
      values (${orgId}, ${role + '-' + randomUUID() + '@example.test'}, 'x', ${role}::user_role,
              ${'Test ' + role}, ${'اختبار ' + role})
      returning id`;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('user insert returned no row');
    return id;
  };

  it('accepts one row per distinct approver and rejects a second signature from the same person', async () => {
    const fx = await createFixture(sql, 'dual-key');
    const proposalId = await insertProposal(fx.orgId);
    const accountant = await insertUser(fx.orgId, 'accountant');
    const manager = await insertUser(fx.orgId, 'property_manager');

    await sql`insert into proposal_approvals (proposal_id, approver_id, role)
              values (${proposalId}, ${accountant}, 'accountant')`;

    // The invariant: a retry, a double click or a status reset cannot manufacture
    // the second key. Postgres refuses it, so no handler has to remember to.
    await expect(
      sql`insert into proposal_approvals (proposal_id, approver_id, role)
          values (${proposalId}, ${accountant}, 'accountant')`,
    ).rejects.toThrow(/duplicate key value violates unique constraint/i);

    const afterDuplicate = await sql<{ n: number }[]>`
      select count(*)::int as n from proposal_approvals where proposal_id = ${proposalId}`;
    expect(afterDuplicate[0]?.n).toBe(1);

    await sql`insert into proposal_approvals (proposal_id, approver_id, role)
              values (${proposalId}, ${manager}, 'property_manager')`;

    const counted = await sql<{ n: number }[]>`
      select count(*)::int as n from proposal_approvals where proposal_id = ${proposalId}`;
    expect(counted[0]?.n).toBe(2);
  });

  it('deletes its signatures with the proposal and refuses a signature for a proposal that does not exist', async () => {
    const fx = await createFixture(sql, 'dual-key-fk');
    const proposalId = await insertProposal(fx.orgId);
    const approver = await insertUser(fx.orgId, 'owner_admin');
    await sql`insert into proposal_approvals (proposal_id, approver_id, role)
              values (${proposalId}, ${approver}, 'owner_admin')`;

    await sql`delete from action_proposals where id = ${proposalId}`;
    const orphans = await sql<{ n: number }[]>`
      select count(*)::int as n from proposal_approvals where proposal_id = ${proposalId}`;
    expect(orphans[0]?.n).toBe(0);

    await expect(
      sql`insert into proposal_approvals (proposal_id, approver_id, role)
          values (${randomUUID()}, ${approver}, 'owner_admin')`,
    ).rejects.toThrow(/violates foreign key constraint/i);
  });
});
