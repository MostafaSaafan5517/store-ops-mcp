import type { Database } from './db/types.js';

/** How long a "Try the demo" user (and with it their sign-in and tokens) keeps working. */
export const DEMO_USER_LIFETIME_MS = 24 * 60 * 60_000;

async function singleId(db: Database, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.transaction((tx) => tx.query<{ id: string }>(sql, params));
  const id = rows[0]?.id;
  if (!id) throw new Error('user function returned no id');
  return id;
}

/** Internal user id for a GitHub account, created on first sign-in. */
export async function signInGithubUser(
  db: Database,
  github: { id: number; login: string },
): Promise<string> {
  if (!Number.isSafeInteger(github.id) || github.id <= 0) {
    throw new Error('GitHub user id must be a positive integer');
  }
  return singleId(db, 'select store_ops.sign_in_github($1, $2) as id', [github.id, github.login]);
}

/** A fresh demo user that stops working after `DEMO_USER_LIFETIME_MS`. */
export async function createDemoUser(
  db: Database,
  now: Date,
): Promise<{ userId: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + DEMO_USER_LIFETIME_MS);
  const userId = await singleId(db, 'select store_ops.create_demo_user($1) as id', [
    expiresAt.toISOString(),
  ]);
  return { userId, expiresAt };
}
