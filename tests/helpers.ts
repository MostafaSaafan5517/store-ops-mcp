import { openLocalDatabase } from '../src/db/pglite.js';
import { withPrincipal, withUser } from '../src/db/principal.js';
import type { Database, Principal } from '../src/db/types.js';
import { createDemoUser } from '../src/users.js';
import { openPostgresTestDatabase, type OwnerQuery } from './support/postgres.js';

export const USER_A = '00000000-0000-4000-8000-00000000000a';
export const USER_B = '00000000-0000-4000-8000-00000000000b';
export const USER_C = '00000000-0000-4000-8000-00000000000c';

/** True under `pnpm test:pg` (vitest.pg.config.ts), where suites run on real Postgres. */
export const ON_POSTGRES = process.env.STORE_OPS_TEST_DB === 'postgres';

export interface TestDatabase {
  /** Connection that bypasses RLS (PGlite's superuser, or the Postgres superuser). Checks only. */
  owner: OwnerQuery;
  /** The app connection: every transaction runs as `store_ops_app`, so RLS applies. */
  app: Database;
  close(): Promise<void>;
}

/** In-memory PGlite for `pnpm test`; a fresh database on real Postgres for `pnpm test:pg`. */
export function openTestDatabase(): Promise<TestDatabase> {
  return ON_POSTGRES ? openPostgresTestDatabase() : openLocalDatabase();
}

/** Creates an empty store owned by `userId` through the app role, like real provisioning. */
export async function createEmptyStore(local: TestDatabase, userId: string): Promise<Principal> {
  const storeId = await withUser(local.app, userId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select store_ops.create_store('Demo Store') as id",
    );
    const row = rows[0];
    if (!row) throw new Error('create_store returned nothing');
    return row.id;
  });
  return { userId, storeId };
}

/**
 * Adds one customer, one product (10 in stock) and one order of 1 unit for 1200 cents to the
 * principal's store. Paid orders carry a demo payment reference.
 */
export async function addSampleOrder(
  local: TestDatabase,
  principal: Principal,
  orderNumber = 1001,
  status: 'pending' | 'paid' | 'fulfilled' = 'paid',
): Promise<{ customerId: string; productId: string; orderId: string }> {
  const paid = status !== 'pending';
  return withPrincipal(local.app, principal, async (tx) => {
    const customer = await tx.query<{ id: string }>(
      'insert into store_ops.customers (store_id, name, email) values ($1, $2, $3) returning id',
      [principal.storeId, 'Sample Customer', `sample${orderNumber}@example.com`],
    );
    const product = await tx.query<{ id: string }>(
      `insert into store_ops.products (store_id, sku, name, category, price_cents, stock_on_hand)
       values ($1, $2, 'Sample Mug', 'Kitchen', 1200, 10) returning id`,
      [principal.storeId, `SKU-${orderNumber}`],
    );
    const customerId = customer.rows[0]?.id ?? '';
    const productId = product.rows[0]?.id ?? '';
    const order = await tx.query<{ id: string }>(
      `insert into store_ops.orders (store_id, order_number, customer_id, status, subtotal_cents,
         shipping_cents, tax_cents, total_cents, payment_method, payment_reference, placed_at,
         paid_at)
       values ($1, $2, $3, $4, 1200, 0, 0, 1200, $5, $6, now(), case when $7 then now() end)
       returning id`,
      [
        principal.storeId,
        orderNumber,
        customerId,
        status,
        paid ? 'card' : null,
        paid ? `pi_demo_${orderNumber}` : null,
        paid,
      ],
    );
    const orderId = order.rows[0]?.id ?? '';
    await tx.query(
      `insert into store_ops.order_items (store_id, order_id, product_id, sku, product_name,
         quantity, unit_price_cents, line_total_cents)
       values ($1, $2, $3, $4, 'Sample Mug', 1, 1200, 1200)`,
      [principal.storeId, orderId, productId, `SKU-${orderNumber}`],
    );
    return { customerId, productId, orderId };
  });
}

/** A new demo user with its own client hash and caps high enough never to apply. */
export async function newDemoUser(
  db: Database,
  now = new Date(),
): Promise<{ userId: string; expiresAt: Date }> {
  const demo = await createDemoUser(db, now, {
    dailyCap: 100_000,
    clientDailyCap: 100_000,
    clientHash: `test-client-${crypto.randomUUID()}`,
  });
  if ('refused' in demo) throw new Error(`demo user refused: ${demo.refused}`);
  return demo;
}
