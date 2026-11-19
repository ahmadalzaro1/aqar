import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { DEFAULT_DATABASE_URL } from './client.js';

/**
 * Migration runner with real DOWN support.
 *
 * drizzle-kit generates the `up` SQL (`drizzle/NNNN_name.sql`); the matching
 * `drizzle/NNNN_name_down.sql` is maintained by hand in this package. This
 * runner keeps its own ledger (`app_schema_migrations`) so it can apply and
 * reverse migrations in order, and detects drift by checksum.
 *
 * Usage:
 *   tsx src/migrate.ts up                 # apply all pending
 *   tsx src/migrate.ts down               # revert everything, newest first
 *   tsx src/migrate.ts down --steps 1     # revert the last migration only
 *   tsx src/migrate.ts status             # show applied / pending
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const LEDGER_TABLE = 'app_schema_migrations';

export type Migration = {
  filename: string;
  name: string;
  upPath: string;
  downPath: string;
  checksum: string;
};

export type MigrateResult = {
  applied: string[];
  reverted: string[];
  alreadyApplied: string[];
};

export function migrationsDir(): string {
  return process.env['MIGRATIONS_DIR'] ?? MIGRATIONS_DIR;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** All up-migrations, ordered by numeric prefix. */
export function listMigrations(dir: string = migrationsDir()): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort((a, b) => a.localeCompare(b));

  return files.map((filename) => {
    const upPath = join(dir, filename);
    const downPath = join(dir, filename.replace(/\.sql$/, '_down.sql'));
    return {
      filename,
      name: filename.replace(/^\d+_/, '').replace(/\.sql$/, ''),
      upPath,
      downPath,
      checksum: sha256(readFileSync(upPath, 'utf8')),
    };
  });
}

function urlFor(url?: string): string {
  return url ?? process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
}

async function ensureLedger(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function appliedMigrations(
  url?: string,
): Promise<{ filename: string; checksum: string; appliedAt: Date }[]> {
  const sql = postgres(urlFor(url), { max: 1, onnotice: () => undefined });
  try {
    await ensureLedger(sql);
    const rows = await sql<
      { filename: string; checksum: string; applied_at: Date }[]
    >`SELECT filename, checksum, applied_at FROM app_schema_migrations ORDER BY filename`;
    return rows.map((r) => ({
      filename: r.filename,
      checksum: r.checksum,
      appliedAt: r.applied_at,
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Applies every pending migration in filename order. */
export async function migrateUp(url?: string): Promise<MigrateResult> {
  const sql = postgres(urlFor(url), { max: 1, onnotice: () => undefined });
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    await ensureLedger(sql);
    const done = new Set(
      (await sql<{ filename: string }[]>`SELECT filename FROM app_schema_migrations`).map(
        (r) => r.filename,
      ),
    );

    for (const migration of listMigrations()) {
      if (done.has(migration.filename)) {
        alreadyApplied.push(migration.filename);
        continue;
      }
      const body = readFileSync(migration.upPath, 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO app_schema_migrations (filename, checksum) VALUES (${migration.filename}, ${migration.checksum})`;
      });
      applied.push(migration.filename);
    }
    return { applied, reverted: [], alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Reverts applied migrations newest-first. `steps` limits how many are reverted
 * (default: all). Throws when a down file is missing — a migration without a
 * rollback path is a bug, not something to silently skip.
 */
export async function migrateDown(url?: string, steps?: number): Promise<MigrateResult> {
  const sql = postgres(urlFor(url), { max: 1, onnotice: () => undefined });
  const reverted: string[] = [];
  try {
    await ensureLedger(sql);
    const done = await sql<
      { filename: string; checksum: string }[]
    >`SELECT filename, checksum FROM app_schema_migrations ORDER BY filename DESC`;

    const all = new Map(listMigrations().map((m) => [m.filename, m]));
    const planned = steps === undefined ? done : done.slice(0, steps);

    for (const row of planned) {
      const migration = all.get(row.filename);
      if (!migration) {
        throw new Error(
          `migration file for applied entry ${row.filename} is missing; refusing to guess`,
        );
      }
      if (migration.checksum !== row.checksum) {
        throw new Error(
          `checksum drift for ${row.filename}: file changed after it was applied`,
        );
      }
      const down = readFileSync(migration.downPath, 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(down);
        await tx`DELETE FROM app_schema_migrations WHERE filename = ${row.filename}`;
      });
      reverted.push(row.filename);
    }
    return { applied: [], reverted, alreadyApplied: [] };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const [, , command = 'up', ...rest] = process.argv;
  const stepsFlag = rest.indexOf('--steps');
  const steps =
    stepsFlag >= 0 ? Number.parseInt(rest[stepsFlag + 1] ?? '', 10) : undefined;

  if (command === 'up') {
    const result = await migrateUp();
    const skipped = result.alreadyApplied.length
      ? ` (${result.alreadyApplied.length} already applied)`
      : '';
    console.info(`up: applied ${result.applied.length} migration(s)${skipped}`);
  } else if (command === 'down') {
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) {
      throw new Error('--steps must be a positive integer');
    }
    const result = await migrateDown(undefined, steps);
    console.info(`down: reverted ${result.reverted.length} migration(s)`);
  } else if (command === 'status') {
    const applied = await appliedMigrations();
    const known = listMigrations();
    const appliedNames = new Set(applied.map((a) => a.filename));
    console.info(`migrations dir: ${migrationsDir()}`);
    for (const m of known) {
      console.info(`${appliedNames.has(m.filename) ? '[x]' : '[ ]'} ${m.filename}`);
    }
  } else {
    throw new Error(`unknown command '${command}' (expected up|down|status)`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('migrate.ts');

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
