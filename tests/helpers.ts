import { openLocalDatabase, type LocalDatabase } from '../src/db/pglite.js';
import { withPrincipal, withUser } from '../src/db/principal.js';
import type { Principal } from '../src/db/types.js';

export const USER_A = '00000000-0000-4000-8000-00000000000a';
export const USER_B = '00000000-0000-4000-8000-00000000000b';

export function openTestDatabase(): Promise<LocalDatabase> {
  return openLocalDatabase();
}

/** Creates an empty store owned by `userId` through the app role, like real provisioning. */
export async function createEmptyStore(local: LocalDatabase, userId: string): Promise<Principal> {
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

/** Adds one customer, one product and one order (with an item) to the principal's store. */
export async function addSampleOrder(
  local: LocalDatabase,
  principal: Principal,
  orderNumber = 1001,
): Promise<{ customerId: string; productId: string; orderId: string }> {
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
         shipping_cents, tax_cents, total_cents, placed_at)
       values ($1, $2, $3, 'paid', 1200, 0, 0, 1200, now()) returning id`,
      [principal.storeId, orderNumber, customerId],
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
