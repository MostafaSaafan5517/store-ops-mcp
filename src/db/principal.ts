import type { Database, Principal, SqlClient } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

/** Runs `fn` in one transaction scoped to the principal's user and store. */
export function withPrincipal<T>(
  db: Database,
  principal: Principal,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  assertUuid(principal.userId, 'userId');
  assertUuid(principal.storeId, 'storeId');
  return db.transaction(async (tx) => {
    await tx.query(
      "select set_config('store_ops.user_id', $1, true), set_config('store_ops.store_id', $2, true)",
      [principal.userId, principal.storeId],
    );
    return fn(tx);
  });
}

/** Runs `fn` with only the user set (no store yet), for store lookup and provisioning. */
export function withUser<T>(
  db: Database,
  userId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  assertUuid(userId, 'userId');
  return db.transaction(async (tx) => {
    await tx.query("select set_config('store_ops.user_id', $1, true)", [userId]);
    return fn(tx);
  });
}

/** Store ids the user is a member of, oldest first. */
export function listStoreIdsForUser(db: Database, userId: string): Promise<string[]> {
  return withUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ store_id: string }>(
      'select store_id from store_ops.store_members where user_id = $1 order by created_at, store_id',
      [userId],
    );
    return rows.map((row) => row.store_id);
  });
}
