import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EQUIPMENT_KINDS, EQUIPMENT_TRADE, JOB_TEMPLATES, TRADE_TOKENS } from '@aqar/core';
import postgres from 'postgres';
import { migrateUp } from '../migrate.js';
import { APP_URL, TEST_URL, resetSchema } from './helpers.js';

/**
 * 0019 shipped the vocabulary twice: once as TypeScript constants (the source of
 * truth at runtime) and once as INSERT statements in the migration (the source
 * of truth for a fresh database). Two copies of reference data drift — that is
 * not a risk, it is the default. These assertions are what makes the drift loud
 * instead of silent, and they run against a real database with the real
 * migrations replayed, so a migration that inserts something core does not know
 * about fails CI.
 */

let sql: postgres.Sql;

beforeAll(async () => {
  await resetSchema();
  await migrateUp(TEST_URL);
  sql = postgres(TEST_URL, { max: 4, prepare: false });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('trade vocabulary: database and TypeScript agree', () => {
  it('the enum holds exactly the tokens core declares, in order', async () => {
    const rows = await sql<{ label: string; position: number }[]>`
      select e.enumlabel as label, e.enumsortorder as position
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      where t.typname = 'vendor_trade'
      order by e.enumsortorder`;
    expect(rows.map((r) => r.label)).toEqual([...TRADE_TOKENS]);
  });

  it('equipment_trade_map is exactly the core map, primary first', async () => {
    const rows = await sql<{ kind: string; trade: string; priority: number }[]>`
      select equipment_kind::text as kind, trade::text as trade, priority
      from equipment_trade_map
      order by equipment_kind, priority`;

    const fromDb = new Map<string, string[]>();
    for (const row of rows) {
      const list = fromDb.get(row.kind) ?? [];
      list[row.priority] = row.trade;
      fromDb.set(row.kind, list);
    }

    const fromCore = new Map<string, string[]>(
      EQUIPMENT_KINDS.map((kind) => [kind, [...EQUIPMENT_TRADE[kind]]]),
    );

    expect([...fromDb.keys()].sort()).toEqual([...fromCore.keys()].sort());
    for (const [kind, trades] of fromCore) {
      expect(fromDb.get(kind), `priority order differs for ${kind}`).toEqual(trades);
    }
  });

  it('trade_job_templates is exactly the core template list', async () => {
    const rows = await sql<
      {
        code: string;
        trade: string;
        title_en: string;
        title_ar: string;
        cadence_days: number | null;
        cadence_basis: string | null;
        statutory: boolean;
        statutory_authority: string | null;
        requires_certificate: boolean;
        equipment_kinds: string[];
        notes: string | null;
      }[]
    >`select code, trade::text as trade, title_en, title_ar, cadence_days,
             cadence_basis, statutory, statutory_authority,
             requires_certificate, equipment_kinds::text[] as equipment_kinds, notes
      from trade_job_templates
      order by code`;

    const fromDb = rows.map((row) => ({
      code: row.code,
      trade: row.trade,
      titleEn: row.title_en,
      titleAr: row.title_ar,
      cadenceDays: row.cadence_days,
      cadenceBasis: row.cadence_basis,
      statutory: row.statutory,
      statutoryAuthority: row.statutory_authority,
      requiresCertificate: row.requires_certificate,
      equipmentKinds: row.equipment_kinds,
      notes: row.notes,
    }));

    const fromCore = [...JOB_TEMPLATES]
      .map((template) => ({ ...template, equipmentKinds: [...template.equipmentKinds] }))
      .sort((a, b) => a.code.localeCompare(b.code));

    expect(fromDb).toEqual(fromCore);
  });

  it('refuses a trade that is not in the vocabulary', async () => {
    await expect(
      sql`update equipment_trade_map set trade = 'blacksmith' where false`,
    ).rejects.toThrow(/invalid input value for enum vendor_trade/i);
  });

  it('classifies legacy and canonical rosters correctly through the CHECK function', async () => {
    const rows = await sql<
      { legacy: boolean; canonical: boolean; empty: boolean; arabic: boolean }[]
    >`
      select vendor_trades_are_canonical('["plumbing"]'::jsonb) as legacy,
             vendor_trades_are_canonical('["plumber","elevator"]'::jsonb) as canonical,
             vendor_trades_are_canonical('[]'::jsonb) as empty,
             vendor_trades_are_canonical('["سباكة"]'::jsonb) as arabic`;
    expect(rows[0]).toEqual({ legacy: false, canonical: true, empty: true, arabic: false });
  });

  it('carries the constraint on the vendors table itself', async () => {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
      where conname = 'vendors_trades_canonical_ck' and contype = 'c'`;
    expect(rows[0]?.n).toBe(1);
  });

  it('lets the application role read the reference tables', async () => {
    const app = postgres(APP_URL, { max: 1, prepare: false });
    try {
      const map = await app`select count(*)::int as n from equipment_trade_map`;
      const templates = await app`select count(*)::int as n from trade_job_templates`;
      expect(map[0]?.n).toBeGreaterThan(0);
      expect(templates[0]?.n).toBeGreaterThan(0);
    } finally {
      await app.end({ timeout: 5 });
    }
  });
});
