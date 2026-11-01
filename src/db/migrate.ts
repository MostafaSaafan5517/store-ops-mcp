import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
/** Session advisory lock key held while migrating. */
const MIGRATION_LOCK = 5_370_746_591;

/** An owner connection that can run multi-statement SQL. PGlite and a `pg` client both fit. */
export interface MigrationClient {
  exec(sql: string): Promise<unknown>;
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/**
 * Applies every `migrations/*.sql` file not yet recorded, in file name order, each in its own
 * transaction. Run it as the role that owns the schema (never as the app's login role).
 */
export async function migrate(owner: MigrationClient): Promise<string[]> {
  // Two deploys migrating at once would otherwise race; the second one waits here.
  await owner.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
  try {
    return await applyPending(owner);
  } finally {
    await owner.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]);
  }
}

async function applyPending(owner: MigrationClient): Promise<string[]> {
  await owner.exec(
    'create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  const applied = new Set(
    (await owner.query<{ name: string }>('select name from public.schema_migrations')).rows.map(
      (row) => row.name,
    ),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(`${MIGRATIONS_DIR}${file}`, 'utf8');
    await owner.exec('begin');
    try {
      await owner.exec(sql);
      await owner.query('insert into public.schema_migrations (name) values ($1)', [file]);
      await owner.exec('commit');
    } catch (error) {
      const failure = new Error(`migration ${file} failed`, { cause: error });
      await owner.exec('rollback').catch((rollbackError: unknown) => {
        throw new AggregateError(
          [failure, rollbackError],
          `migration ${file} and its rollback failed`,
        );
      });
      throw failure;
    }
    newlyApplied.push(file);
  }
  return newlyApplied;
}

/** Adapts a `pg` client (connected as the schema owner) to `migrate`. */
export function pgMigrationClient(client: {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}): MigrationClient {
  return {
    exec: (sql) => client.query(sql),
    async query<Row>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: result.rows as Row[] };
    },
  };
}
