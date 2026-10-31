import { listStoreIdsForUser, withPrincipal, withUser } from '../db/principal.js';
import type { Database, Principal, SqlClient } from '../db/types.js';
import { generateDemoStore, type DemoStoreData } from './demo-store.js';

async function insertRecords(
  tx: SqlClient,
  table: string,
  columns: Record<string, string>,
  records: Record<string, unknown>[],
): Promise<void> {
  if (records.length === 0) return;
  const names = Object.keys(columns);
  const definition = names.map((name) => `${name} ${columns[name]}`).join(', ');
  await tx.query(
    `insert into store_ops.${table} (${names.join(', ')})
     select ${names.join(', ')} from jsonb_to_recordset($1::jsonb) as r(${definition})`,
    [JSON.stringify(records)],
  );
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** Writes a generated demo store into the principal's (empty) store as the app role. */
export async function insertDemoStore(
  db: Database,
  principal: Principal,
  data: DemoStoreData,
): Promise<void> {
  const storeId = principal.storeId;
  const productIds = data.products.map(() => crypto.randomUUID());
  const customerIds = data.customers.map(() => crypto.randomUUID());
  const orderIds = data.orders.map(() => crypto.randomUUID());

  await withPrincipal(db, principal, async (tx) => {
    await insertRecords(
      tx,
      'products',
      {
        id: 'uuid',
        store_id: 'uuid',
        sku: 'text',
        name: 'text',
        category: 'text',
        price_cents: 'integer',
        stock_on_hand: 'integer',
        low_stock_threshold: 'integer',
      },
      data.products.map((product, index) => ({
        id: productIds[index],
        store_id: storeId,
        sku: product.sku,
        name: product.name,
        category: product.category,
        price_cents: product.priceCents,
        stock_on_hand: product.stockOnHand,
        low_stock_threshold: product.lowStockThreshold,
      })),
    );
    await insertRecords(
      tx,
      'customers',
      { id: 'uuid', store_id: 'uuid', name: 'text', email: 'text' },
      data.customers.map((customer, index) => ({
        id: customerIds[index],
        store_id: storeId,
        name: customer.name,
        email: customer.email,
      })),
    );
    await insertRecords(
      tx,
      'orders',
      {
        id: 'uuid',
        store_id: 'uuid',
        order_number: 'integer',
        customer_id: 'uuid',
        status: 'text',
        subtotal_cents: 'integer',
        shipping_cents: 'integer',
        tax_cents: 'integer',
        total_cents: 'integer',
        payment_method: 'text',
        payment_reference: 'text',
        placed_at: 'timestamptz',
        paid_at: 'timestamptz',
        fulfilled_at: 'timestamptz',
        cancelled_at: 'timestamptz',
        updated_at: 'timestamptz',
      },
      data.orders.map((order, index) => ({
        id: orderIds[index],
        store_id: storeId,
        order_number: order.orderNumber,
        customer_id: customerIds[order.customerIndex],
        status: order.status,
        subtotal_cents: order.subtotalCents,
        shipping_cents: order.shippingCents,
        tax_cents: order.taxCents,
        total_cents: order.totalCents,
        payment_method: order.paymentMethod,
        payment_reference: order.paymentReference,
        placed_at: iso(order.placedAt),
        paid_at: iso(order.paidAt),
        fulfilled_at: iso(order.fulfilledAt),
        cancelled_at: iso(order.cancelledAt),
        updated_at:
          iso(
            order.refunds[0]?.createdAt ?? order.fulfilledAt ?? order.cancelledAt ?? order.paidAt,
          ) ?? iso(order.placedAt),
      })),
    );
    await insertRecords(
      tx,
      'order_items',
      {
        store_id: 'uuid',
        order_id: 'uuid',
        product_id: 'uuid',
        sku: 'text',
        product_name: 'text',
        quantity: 'integer',
        unit_price_cents: 'integer',
        line_total_cents: 'integer',
      },
      data.orders.flatMap((order, orderIndex) =>
        order.items.map((item) => {
          const product = data.products[item.productIndex];
          return {
            store_id: storeId,
            order_id: orderIds[orderIndex],
            product_id: productIds[item.productIndex],
            sku: product?.sku,
            product_name: product?.name,
            quantity: item.quantity,
            unit_price_cents: item.unitPriceCents,
            line_total_cents: item.lineTotalCents,
          };
        }),
      ),
    );
    await insertRecords(
      tx,
      'order_notes',
      {
        store_id: 'uuid',
        order_id: 'uuid',
        author: 'text',
        body: 'text',
        created_at: 'timestamptz',
      },
      data.orders.flatMap((order, orderIndex) =>
        order.notes.map((note) => ({
          store_id: storeId,
          order_id: orderIds[orderIndex],
          author: note.author,
          body: note.body,
          created_at: iso(note.createdAt),
        })),
      ),
    );
    await insertRecords(
      tx,
      'refunds',
      {
        store_id: 'uuid',
        order_id: 'uuid',
        amount_cents: 'integer',
        reason: 'text',
        status: 'text',
        provider_refund_id: 'text',
        created_at: 'timestamptz',
      },
      data.orders.flatMap((order, orderIndex) =>
        order.refunds.map((refund) => ({
          store_id: storeId,
          order_id: orderIds[orderIndex],
          amount_cents: refund.amountCents,
          reason: refund.reason,
          status: 'succeeded',
          provider_refund_id: refund.providerRefundId,
          created_at: iso(refund.createdAt),
        })),
      ),
    );
  });
}

/** Creates a new demo store owned by `userId` and fills it with generated data. */
export async function provisionDemoStore(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<Principal> {
  const data = generateDemoStore({ seed: userId, now });
  const storeId = await withUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('select store_ops.create_store($1) as id', [
      data.name,
    ]);
    const id = rows[0]?.id;
    if (!id) throw new Error('create_store returned no id');
    return id;
  });
  const principal = { userId, storeId };
  await insertDemoStore(db, principal, data);
  return principal;
}

/** Returns the user's first store, provisioning a demo store if they have none yet. */
export async function ensureDemoStore(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<{ principal: Principal; created: boolean }> {
  const [storeId] = await listStoreIdsForUser(db, userId);
  if (storeId) return { principal: { userId, storeId }, created: false };
  return { principal: await provisionDemoStore(db, userId, now), created: true };
}
