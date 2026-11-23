/** Throwaway probe: run the three Tier-3 tools against the live ledger. */
import { createSql, databaseUrl } from '@aqar/db';
import { registry, type ToolContext } from '@aqar/tools';

async function main(): Promise<void> {
  const sql = createSql(databaseUrl());
  try {
    const orgRows = await sql<
      { id: string; slug: string; name: string; timezone: string; currency: string }[]
    >`
      select id, slug, name, timezone, currency from organizations order by created_at limit 1
    `;
    const org = orgRows[0];
    if (org === undefined) throw new Error('no organization');
    const ctx: ToolContext = {
      sql,
      org,
      now: () => new Date(),
      policy: {
        actor: 'probe',
        mode: 'read_only',
        quietHoursStart: 22,
        quietHoursEnd: 7,
        tenantMessageDailyCap: 0,
        orgDailySpendCapFils: 0,
      },
    };

    for (const [name, args] of [
      ['renewal_pipeline', { days: 120 }],
      ['notices_due', { horizonDays: 60 }],
      ['obligation_for', { clause: 'repairs_appliance' }],
    ] as const) {
      try {
        const out = await registry.run(name, args, ctx);
        console.info(`\n=== ${name} OK\n` + JSON.stringify(out, null, 1).slice(0, 1100));
      } catch (err) {
        const e = err as { code?: string; message?: string; hint?: string };
        console.info(
          `\n=== ${name} REFUSED [${e.code ?? 'error'}] ${e.message}\n hint: ${e.hint ?? '-'}`,
        );
      }
    }
  } finally {
    await sql.end();
  }
}

void main();
