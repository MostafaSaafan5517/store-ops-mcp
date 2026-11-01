import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from './migrate.js';
import { APP_ROLE, type Database } from './types.js';

export interface LocalDatabase {
  /** Owner connection. Only for migrations and tests that check owner-level behaviour. */
  owner: PGlite;
  /** App connection: every transaction runs as the non-owner role, so RLS applies. */
  app: Database;
  close(): Promise<void>;
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
