import { Client } from 'pg';
import { APP_ROLE, type Database, type SqlClient } from './types.js';

/** The part of a `pg` client the adapter uses. */
export interface PgConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

/**
 * A Postgres database behind the `Database` interface, for the Worker (through Hyperdrive).
 *
 * Each transaction opens its own connection, as Hyperdrive recommends (it pools the real
 * connections), and switches to the non-owner role with `SET LOCAL ROLE`, so RLS applies even
 * if the login role was granted more by mistake. The login role should still be one that is
 * only a member of `store_ops_app`.
 *
 * Not yet tested against a real Postgres server (Run 3b, Docker).
 */
export function createPostgresDatabase(connect: () => Promise<PgConnection>): Database {
  return {
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const connection = await connect();
      const tx: SqlClient = {
        async query<Row>(sql: string, params?: unknown[]) {
          const result = await connection.query(sql, params);
          return { rows: result.rows as Row[], affectedRows: result.rowCount ?? 0 };
        },
      };
      try {
        await connection.query('begin');
        await connection.query(`set local role ${APP_ROLE}`);
        const result = await fn(tx);
        await connection.query('commit');
        return result;
      } catch (error) {
        await connection.query('rollback').catch((rollbackError: unknown) => {
          throw new AggregateError([error, rollbackError], 'transaction and rollback failed');
        });
        throw error;
      } finally {
        await connection.end();
      }
    },
  };
}

/** Connects with `pg` through a Hyperdrive binding's connection string. */
export function hyperdriveConnector(connectionString: string): () => Promise<PgConnection> {
  return async () => {
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  };
}
