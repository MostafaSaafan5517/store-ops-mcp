import { describe, expect, it } from 'vitest';
import { createPostgresDatabase, type PgConnection } from '../src/db/postgres.js';

// Only the transaction wrapper is tested here. Running the app against a real Postgres server
// (through the same adapter) is the Docker harness in Run 3b.
function fakeConnection(failOn?: string) {
  const log: string[] = [];
  const connection: PgConnection = {
    query(sql) {
      log.push(sql);
      if (sql === failOn) return Promise.reject(new Error(`failed: ${sql}`));
      return Promise.resolve({ rows: [{ ok: true }], rowCount: 1 });
    },
    end() {
      log.push('end');
      return Promise.resolve();
    },
  };
  return { log, connect: () => Promise.resolve(connection) };
}

describe('Postgres adapter', () => {
  it('runs each transaction on its own connection as the app role, then commits', async () => {
    const fake = fakeConnection();
    const db = createPostgresDatabase(fake.connect);
    const result = await db.transaction((tx) => tx.query('select 1'));
    expect(result).toEqual({ rows: [{ ok: true }], affectedRows: 1 });
    expect(fake.log).toEqual([
      'begin',
      'set local role store_ops_app',
      'select 1',
      'commit',
      'end',
    ]);
  });

  it('rolls back and closes the connection when the work fails', async () => {
    const fake = fakeConnection('select boom');
    const db = createPostgresDatabase(fake.connect);
    await expect(db.transaction((tx) => tx.query('select boom'))).rejects.toThrow('select boom');
    expect(fake.log).toEqual([
      'begin',
      'set local role store_ops_app',
      'select boom',
      'rollback',
      'end',
    ]);
  });

  it('reports both errors when the rollback fails too', async () => {
    const fake = fakeConnection('rollback');
    const db = createPostgresDatabase(fake.connect);
    await expect(
      db.transaction(() => Promise.reject(new Error('work failed'))),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(fake.log.at(-1)).toBe('end');
  });
});
