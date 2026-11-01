import type { Database } from './db/types.js';

/** Stores wiped per call, so one cron run stays short. */
export const PURGE_BATCH_SIZE = 100;

export interface PurgedStore {
  storeId: string;
  /** The store's former members, whose OAuth grants can now be revoked. */
  userIds: string[];
}

/**
 * Wipes expired demo stores (everything except the store row and its audit_log rows) through
 * `store_ops.purge_expired_demo_stores`, which runs as the narrow `store_ops_janitor` role and
 * uses the database clock. Runs as the app role like every other call; the app role itself
 * still has no DELETE.
 */
export async function purgeExpiredDemoStores(
  db: Database,
  limit = PURGE_BATCH_SIZE,
): Promise<PurgedStore[]> {
  const { rows } = await db.transaction((tx) =>
    tx.query<{ store_id: string; user_id: string | null }>(
      'select store_id, user_id from store_ops.purge_expired_demo_stores($1)',
      [limit],
    ),
  );
  const stores = new Map<string, string[]>();
  for (const row of rows) {
    const userIds = stores.get(row.store_id) ?? [];
    if (row.user_id) userIds.push(row.user_id);
    stores.set(row.store_id, userIds);
  }
  return [...stores].map(([storeId, userIds]) => ({ storeId, userIds }));
}
