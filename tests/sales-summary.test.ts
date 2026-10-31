import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalDatabase } from '../src/db/pglite.js';
import { withPrincipal } from '../src/db/principal.js';
import type { Principal } from '../src/db/types.js';
import { SALE_STATUSES } from '../src/domain.js';
import { generateDemoStore } from '../src/seed/demo-store.js';
import { provisionDemoStore } from '../src/seed/provision.js';
import { createEmptyStore, openTestDatabase, USER_A, USER_B } from './helpers.js';
import { connectClient, textOf, type TestClient } from './mcp-client.js';

const NOW = new Date('2026-10-06T12:00:00Z');

interface Summary {
  from: string;
  to: string;
  order_count: number;
  gross_sales_cents: number;
  refunds_cents: number;
  net_sales_cents: number;
  average_order_value_cents: number;
  orders_by_status: Record<string, number>;
  top_products: { sku: string; name: string; units_sold: number; revenue_cents: number }[];
}

interface FixtureOrder {
  number: number;
  status: string;
  placedAt: string;
  lines: [sku: string, quantity: number][];
  shipping?: number;
  refunds?: [amount: number, status: 'succeeded' | 'failed'][];
}

const PRICES: Record<string, number> = { 'A-1': 1000, 'B-1': 2500 };

/** Hand-checked fixture. Totals for 2026-10-01..2026-10-06 are worked out in the tests. */
const FIXTURE: FixtureOrder[] = [
  {
    number: 1,
    status: 'paid',
    placedAt: '2026-10-01T10:00:00Z',
    lines: [['A-1', 2]],
    shipping: 500,
  },
  { number: 2, status: 'fulfilled', placedAt: '2026-10-02T10:00:00Z', lines: [['B-1', 1]] },
  {
    number: 3,
    status: 'partially_refunded',
    placedAt: '2026-10-03T10:00:00Z',
    lines: [
      ['A-1', 1],
      ['B-1', 2],
    ],
    refunds: [
      [1000, 'succeeded'],
      [500, 'failed'],
    ],
  },
  {
    number: 4,
    status: 'refunded',
    placedAt: '2026-10-04T10:00:00Z',
    lines: [['A-1', 3]],
    refunds: [[3000, 'succeeded']],
  },
  { number: 5, status: 'pending', placedAt: '2026-10-05T10:00:00Z', lines: [['B-1', 4]] },
  { number: 6, status: 'cancelled', placedAt: '2026-10-06T10:00:00Z', lines: [['A-1', 1]] },
  { number: 7, status: 'fulfilled', placedAt: '2026-09-30T23:59:59Z', lines: [['A-1', 1]] },
  { number: 8, status: 'fulfilled', placedAt: '2026-10-07T00:00:00Z', lines: [['B-1', 1]] },
];

async function insertFixture(local: LocalDatabase, principal: Principal): Promise<void> {
  await withPrincipal(local.app, principal, async (tx) => {
    const customer = await tx.query<{ id: string }>(
      "insert into store_ops.customers (store_id, name, email) values ($1, 'Avery Sampleton', 'avery@example.com') returning id",
      [principal.storeId],
    );
    const productIds: Record<string, string> = {};
    for (const [sku, price] of Object.entries(PRICES)) {
      const product = await tx.query<{ id: string }>(
        `insert into store_ops.products (store_id, sku, name, category, price_cents, stock_on_hand)
         values ($1, $2, $3, 'Kitchen', $4, 10) returning id`,
        [principal.storeId, sku, `Product ${sku}`, price],
      );
      productIds[sku] = product.rows[0]?.id ?? '';
    }
    for (const order of FIXTURE) {
      const subtotal = order.lines.reduce((sum, [sku, qty]) => sum + (PRICES[sku] ?? 0) * qty, 0);
      const shipping = order.shipping ?? 0;
      const inserted = await tx.query<{ id: string }>(
        `insert into store_ops.orders (store_id, order_number, customer_id, status, subtotal_cents,
           shipping_cents, tax_cents, total_cents, placed_at)
         values ($1, $2, $3, $4, $5, $6, 0, $7, $8) returning id`,
        [
          principal.storeId,
          order.number,
          customer.rows[0]?.id,
          order.status,
          subtotal,
          shipping,
          subtotal + shipping,
          order.placedAt,
        ],
      );
      const orderId = inserted.rows[0]?.id;
      for (const [sku, quantity] of order.lines) {
        const price = PRICES[sku] ?? 0;
        await tx.query(
          `insert into store_ops.order_items (store_id, order_id, product_id, sku, product_name,
             quantity, unit_price_cents, line_total_cents)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            principal.storeId,
            orderId,
            productIds[sku],
            sku,
            `Product ${sku}`,
            quantity,
            price,
            price * quantity,
          ],
        );
      }
      for (const [amount, status] of order.refunds ?? []) {
        await tx.query(
          `insert into store_ops.refunds (store_id, order_id, amount_cents, reason, status)
           values ($1, $2, $3, 'Test refund', $4)`,
          [principal.storeId, orderId, amount, status],
        );
      }
    }
  });
}

let local: LocalDatabase;
let fixtureClient: TestClient;
let seededClient: TestClient;

beforeAll(async () => {
  local = await openTestDatabase();
  const fixtureStore = await createEmptyStore(local, USER_A);
  await insertFixture(local, fixtureStore);
  fixtureClient = await connectClient(local.app, fixtureStore, NOW);
  const seededStore = await provisionDemoStore(local.app, USER_B, NOW);
  seededClient = await connectClient(local.app, seededStore, NOW);
});

afterAll(async () => {
  await fixtureClient.close();
  await seededClient.close();
  await local.close();
});

const summary = (args: Record<string, unknown>, client = fixtureClient) =>
  client.data<Summary>('get_sales_summary', args);

describe('get_sales_summary math', () => {
  it('computes totals, refunds, net, average and status counts for a range', async () => {
    const result = await summary({ from: '2026-10-01', to: '2026-10-06' });
    // Sale orders 1 to 4: 2500 + 2500 + 6000 + 3000. Refunds: 1000 + 3000 (the failed one is ignored).
    expect(result).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-06',
      order_count: 4,
      gross_sales_cents: 14000,
      refunds_cents: 4000,
      net_sales_cents: 10000,
      average_order_value_cents: 3500,
      orders_by_status: {
        pending: 1,
        paid: 1,
        fulfilled: 1,
        cancelled: 1,
        partially_refunded: 1,
        refunded: 1,
      },
    });
  });

  it('ranks top products by revenue from sale orders only', async () => {
    const result = await summary({ from: '2026-10-01', to: '2026-10-06' });
    expect(result.top_products).toEqual([
      { sku: 'B-1', name: 'Product B-1', units_sold: 3, revenue_cents: 7500 },
      { sku: 'A-1', name: 'Product A-1', units_sold: 6, revenue_cents: 6000 },
    ]);
  });

  it('rounds the average order value to whole cents', async () => {
    const result = await summary({ from: '2026-10-01', to: '2026-10-03' });
    expect(result.gross_sales_cents).toBe(11000);
    expect(result.order_count).toBe(3);
    expect(result.average_order_value_cents).toBe(3667);
  });

  it('treats both ends of the range as whole UTC days', async () => {
    const lastSecond = await summary({ from: '2026-09-30', to: '2026-09-30' });
    expect(lastSecond.order_count).toBe(1);
    const firstSecond = await summary({ from: '2026-10-07', to: '2026-10-07' });
    expect(firstSecond.gross_sales_cents).toBe(2500);
  });

  it('defaults to the last 30 days including today', async () => {
    const result = await summary({});
    expect(result.from).toBe('2026-09-07');
    expect(result.to).toBe('2026-10-06');
    expect(result.order_count).toBe(5);
    expect(result.gross_sales_cents).toBe(15000);
  });

  it('returns zeros for an empty range', async () => {
    const result = await summary({ from: '2026-01-01', to: '2026-01-31' });
    expect(result).toMatchObject({
      order_count: 0,
      gross_sales_cents: 0,
      refunds_cents: 0,
      net_sales_cents: 0,
      average_order_value_cents: 0,
      top_products: [],
    });
  });

  it('rejects reversed, too long and malformed ranges', async () => {
    const reversed = await fixtureClient.call('get_sales_summary', {
      from: '2026-10-06',
      to: '2026-10-01',
    });
    expect(reversed.isError).toBe(true);
    expect(textOf(reversed)).toBe('from must be on or before to.');
    const tooLong = await fixtureClient.call('get_sales_summary', {
      from: '2025-01-01',
      to: '2026-10-06',
    });
    expect(textOf(tooLong)).toBe('The date range can be at most 366 days.');
    const malformed = await fixtureClient.call('get_sales_summary', { from: '2026/10/01' });
    expect(malformed.isError).toBe(true);
  });

  it('matches an independent calculation over the seeded demo store', async () => {
    const truth = generateDemoStore({ seed: USER_B, now: NOW });
    const sales = truth.orders.filter((order) => SALE_STATUSES.includes(order.status));
    const gross = sales.reduce((sum, order) => sum + order.totalCents, 0);
    const refunds = sales
      .flatMap((order) => order.refunds)
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    const result = await summary({ from: '2026-07-01', to: '2026-10-06' }, seededClient);
    expect(result.order_count).toBe(sales.length);
    expect(result.gross_sales_cents).toBe(gross);
    expect(result.refunds_cents).toBe(refunds);
    expect(result.net_sales_cents).toBe(gross - refunds);
    expect(result.average_order_value_cents).toBe(Math.round(gross / sales.length));
    const statusTotal = Object.values(result.orders_by_status).reduce((a, b) => a + b, 0);
    expect(statusTotal).toBe(truth.orders.length);
  });
});
