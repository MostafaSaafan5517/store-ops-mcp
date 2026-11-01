import { Client, Pool } from 'pg';
import { createPostgresDatabase, hyperdriveConnector } from '../../src/db/postgres.js';
import type { Database } from '../../src/db/types.js';

/**
 * Real Postgres for `pnpm test:pg` (Docker, see compose.yaml). Every credential here is a
 * throwaway for the local container and CI service.
 *
 * Roles (cluster-wide, created by the global setup):
 *   postgres         superuser, only for creating roles and databases and for test checks
 *   store_ops_owner  owns the schema and runs migrations; no SUPERUSER, no BYPASSRLS
 *   store_ops_login  the app's login role, only a member of store_ops_app
 */
export const ADMIN_URL =
  process.env.STORE_OPS_PG_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
export const TEMPLATE_DB = 'store_ops_template';
export const OWNER_ROLE = { user: 'store_ops_owner', password: 'store_ops_owner_local' };
export const LOGIN_ROLE = { user: 'store_ops_login', password: 'store_ops_login_local' };

/** The admin URL with another user and database. */
export function databaseUrl(database: string, role?: { user: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.user;
    url.password = role.password;
  }
  return url.toString();
}

export interface OwnerQuery {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface PostgresTestDatabase {
  /** Superuser on this test database: bypasses RLS, for test setup and checks only. */
  owner: OwnerQuery;
  /** The app, through the Hyperdrive adapter, logged in as `store_ops_login`. */
  app: Database;
  name: string;
  close(): Promise<void>;
}

async function withAdmin<T>(fn: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** A fresh database cloned from the migrated template, dropped again on `close`. */
export async function openPostgresTestDatabase(): Promise<PostgresTestDatabase> {
  const name = `store_ops_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await withAdmin(async (admin) => {
    await admin.query(`create database ${name} template ${TEMPLATE_DB} owner ${OWNER_ROLE.user}`);
    // As in the deploy step: no temporary objects for the app's login role.
    await admin.query(`revoke temporary on database ${name} from public`);
  });
  const pool = new Pool({ connectionString: databaseUrl(name), max: 2 });
  return {
    name,
    owner: {
      async query<Row>(sql: string, params?: unknown[]) {
        const result = await pool.query(sql, params);
        return { rows: result.rows as Row[] };
      },
    },
    app: createPostgresDatabase(hyperdriveConnector(databaseUrl(name, LOGIN_ROLE))),
    async close() {
      await pool.end();
      await withAdmin((admin) => admin.query(`drop database ${name} with (force)`));
    },
  };
}
