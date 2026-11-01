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

export interface DemoUserLimits {
  /** New demo users per UTC day across all clients. */
  dailyCap: number;
  /** New demo users per UTC day for one client (see `clientHash`). */
  clientDailyCap: number;
  /** An HMAC of the client's network, never the address itself. */
  clientHash: string;
}

export type DemoUserResult =
  { userId: string; expiresAt: Date } | { refused: 'daily_cap' | 'client_cap' };

/**
 * A fresh demo user that stops working after `DEMO_USER_LIFETIME_MS`, unless today's caps
 * (UTC, counted by the database under a lock) are reached.
 */
export async function createDemoUser(
  db: Database,
  now: Date,
  limits: DemoUserLimits,
): Promise<DemoUserResult> {
  for (const cap of [limits.dailyCap, limits.clientDailyCap]) {
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new Error('demo caps must be whole numbers, zero or more');
    }
  }
  const expiresAt = new Date(now.getTime() + DEMO_USER_LIFETIME_MS);
  const { rows } = await db.transaction((tx) =>
    tx.query<{ user_id: string | null; refusal: string | null }>(
      'select user_id, refusal from store_ops.create_demo_user($1, $2, $3, $4)',
      [expiresAt.toISOString(), limits.dailyCap, limits.clientHash, limits.clientDailyCap],
    ),
  );
  const row = rows[0];
  if (row?.user_id) return { userId: row.user_id, expiresAt };
  if (row?.refusal === 'daily_cap' || row?.refusal === 'client_cap') {
    return { refused: row.refusal };
  }
  throw new Error('create_demo_user returned nothing');
}
