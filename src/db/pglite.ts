import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { APP_ROLE, type Database } from './types.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface LocalDatabase {
  /** Owner connection. Only for migrations and tests that check owner-level behaviour. */
  owner: PGlite;
  /** App connection: every transaction runs as the non-owner role, so RLS applies. */
  app: Database;
  close(): Promise<void>;
}

/** Applies every `migrations/*.sql` file not yet recorded, in file name order. */
export async function migrate(owner: PGlite): Promise<string[]> {
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
    await owner.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into public.schema_migrations (name) values ($1)', [file]);
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}

/**
 * Opens a PGlite database (in memory when `dataDir` is omitted), applies migrations and
 * returns an app connection that switches to the non-owner role inside each transaction.
 *
 * PGlite has a single superuser session, so the role switch is `SET LOCAL ROLE`. On a real
 * Postgres server the app logs in as a role that is only a member of `store_ops_app`.
 */
export async function openLocalDatabase(dataDir?: string): Promise<LocalDatabase> {
  const onDisk = dataDir !== undefined && !dataDir.includes('://');
  if (onDisk) await mkdir(dataDir, { recursive: true });
  const owner = await PGlite.create(dataDir === undefined ? {} : { dataDir });
  await migrate(owner);
  const app: Database = {
    transaction: (fn) =>
      owner.transaction(async (tx) => {
        await tx.exec(`set local role ${APP_ROLE}`);
        return fn(tx);
      }),
  };
  return { owner, app, close: () => owner.close() };
}
