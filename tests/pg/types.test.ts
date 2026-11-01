import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toInt, toIso } from '../../src/tools/shared.js';
import { openPostgresTestDatabase, type PostgresTestDatabase } from '../support/postgres.js';

// The `pg` driver maps types differently from PGlite: bigint and numeric arrive as strings.
// Every aggregate in the tools goes through toInt and every timestamp through toIso, and the
// tool suites validate their outputs against integer schemas on Postgres too.

let local: PostgresTestDatabase;

beforeAll(async () => {
  local = await openPostgresTestDatabase();
});

afterAll(async () => {
  await local.close();
});

describe('pg driver types through the app adapter', () => {
  it('returns bigint and numeric as strings, timestamptz as Date and jsonb parsed', async () => {
    const row = await local.app.transaction(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `select count(*) as counted, sum(x) as summed, 9007199254740993::bigint as big,
                12.50::numeric as amount, timestamptz '2026-11-01 10:00:00+00' as at,
                '{"a": [1, 2]}'::jsonb as doc, 7::int as small
         from generate_series(1, 3) as x`,
      );
      return rows[0];
    });
    expect(row).toEqual({
      counted: '3',
      summed: '6',
      big: '9007199254740993',
      amount: '12.50',
      at: new Date('2026-11-01T10:00:00.000Z'),
      doc: { a: [1, 2] },
      small: 7,
    });
    expect(toInt(row?.counted)).toBe(3);
    expect(toInt(row?.summed)).toBe(6);
    expect(() => toInt(row?.big)).toThrow(/Expected an integer/);
    expect(toIso(row?.at)).toBe('2026-11-01T10:00:00.000Z');
  });
});
