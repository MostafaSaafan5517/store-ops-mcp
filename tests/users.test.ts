import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isUuid } from '../src/db/principal.js';
import { createDemoUser, DEMO_USER_LIFETIME_MS, signInGithubUser } from '../src/users.js';
import { openTestDatabase, type TestDatabase } from './helpers.js';

let local: TestDatabase;

beforeAll(async () => {
  local = await openTestDatabase();
});

afterAll(async () => {
  await local.close();
});

describe('users', () => {
  it('maps a GitHub account to one stable internal UUID', async () => {
    const first = await signInGithubUser(local.app, { id: 4242, login: 'octo-demo' });
    const again = await signInGithubUser(local.app, { id: 4242, login: 'renamed-demo' });
    const other = await signInGithubUser(local.app, { id: 4343, login: 'someone-else' });
    expect(isUuid(first)).toBe(true);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    const { rows } = await local.owner.query<{ github_login: string; kind: string }>(
      'select github_login, kind from store_ops.users where id = $1',
      [first],
    );
    expect(rows).toEqual([{ github_login: 'renamed-demo', kind: 'github' }]);
  });

  it('creates a new demo user with an expiry each time', async () => {
    const now = new Date('2026-10-31T12:00:00.000Z');
    const a = await createDemoUser(local.app, now, 100);
    const b = await createDemoUser(local.app, now, 100);
    if (!a || !b) throw new Error('demo users were not created');
    expect(a.userId).not.toBe(b.userId);
    expect(a.expiresAt.getTime()).toBe(now.getTime() + DEMO_USER_LIFETIME_MS);
    const { rows } = await local.owner.query<{ kind: string; expires_at: Date }>(
      'select kind, expires_at from store_ops.users where id = $1',
      [a.userId],
    );
    expect(rows[0]?.kind).toBe('demo');
    expect(new Date(rows[0]?.expires_at ?? 0).toISOString()).toBe(a.expiresAt.toISOString());
  });

  it('rejects a GitHub id that is not a positive integer', async () => {
    await expect(signInGithubUser(local.app, { id: -1, login: 'x' })).rejects.toThrow();
    await expect(signInGithubUser(local.app, { id: 1.5, login: 'x' })).rejects.toThrow();
  });

  it('gives the app role no direct access to the users table', async () => {
    for (const sql of [
      'select * from store_ops.users',
      "insert into store_ops.users (kind, expires_at) values ('demo', now())",
      "update store_ops.users set github_login = 'x'",
      'delete from store_ops.users',
    ]) {
      await expect(
        local.app.transaction((tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });
});
