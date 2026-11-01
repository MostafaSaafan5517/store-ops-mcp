import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/db/types.js';
import { INSTRUCTION_LIKE_NOTE } from '../src/seed/catalog.js';
import { generateDemoStore, type DemoStoreData } from '../src/seed/demo-store.js';
import { provisionDemoStore } from '../src/seed/provision.js';
import { addSampleOrder, openTestDatabase, USER_A, USER_B, type TestDatabase } from './helpers.js';
import { connectClient, textOf, type TestClient } from './mcp-client.js';

const NOW = new Date('2026-10-31T12:00:00Z');

interface OrderSummary {
  order_number: number;
  status: string;
  customer_name: string;
  customer_email: string;
  item_count: number;
  total_cents: number;
  placed_at: string;
}

interface Product {
  sku: string;
  name: string;
  category: string;
  stock_on_hand: number;
  low_stock_threshold: number;
  is_low_stock: boolean;
}

let local: TestDatabase;
let storeA: Principal;
let truth: DemoStoreData;
let mcp: TestClient;
const serverErrors: unknown[] = [];

beforeAll(async () => {
  local = await openTestDatabase();
  storeA = await provisionDemoStore(local.app, USER_A, NOW);
  const storeB = await provisionDemoStore(local.app, USER_B, NOW);
  await addSampleOrder(local, storeB, 9001);
  truth = generateDemoStore({ seed: USER_A, now: NOW });
  mcp = await connectClient(local.app, storeA, NOW, { errors: serverErrors });
});

afterAll(async () => {
  await mcp.close();
  await local.close();
  expect(serverErrors).toEqual([]);
});

const customerOf = (orderNumber: number) => {
  const order = truth.orders.find((candidate) => candidate.orderNumber === orderNumber);
  if (!order) throw new Error(`no order ${orderNumber}`);
  const customer = truth.customers[order.customerIndex];
  if (!customer) throw new Error('no customer');
  return { order, customer };
};

describe('list_orders', () => {
  it('returns newest orders first with a working cursor across all pages', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page: { orders: OrderSummary[]; next_cursor: string | null } = await mcp.data(
        'list_orders',
        cursor ? { limit: 50, cursor } : { limit: 50 },
      );
      seen.push(...page.orders.map((order) => order.order_number));
      cursor = page.next_cursor;
    } while (cursor);
    const expected = truth.orders.map((order) => order.orderNumber).sort((a, b) => b - a);
    expect(seen).toEqual(expected);
  });

  it('returns the expected fields for an order', async () => {
    const page = await mcp.data<{ currency: string; orders: OrderSummary[] }>('list_orders', {
      limit: 1,
    });
    const first = page.orders[0];
    expect(page.currency).toBe('USD');
    if (!first) throw new Error('no orders');
    const { order, customer } = customerOf(first.order_number);
    expect(first).toEqual({
      order_number: order.orderNumber,
      status: order.status,
      customer_name: customer.name,
      customer_email: customer.email,
      item_count: order.items.reduce((sum, item) => sum + item.quantity, 0),
      total_cents: order.totalCents,
      placed_at: order.placedAt.toISOString(),
    });
  });

  it('filters by status and inclusive date range', async () => {
    const filters = { status: 'fulfilled', placed_from: '2026-09-01', placed_to: '2026-09-30' };
    const first = await mcp.data<{ orders: OrderSummary[]; next_cursor: string | null }>(
      'list_orders',
      { ...filters, limit: 50 },
    );
    const second = first.next_cursor
      ? await mcp.data<{ orders: OrderSummary[] }>('list_orders', {
          ...filters,
          limit: 50,
          cursor: first.next_cursor,
        })
      : { orders: [] };
    const result = { orders: [...first.orders, ...second.orders] };
    const expected = truth.orders
      .filter(
        (order) =>
          order.status === 'fulfilled' &&
          order.placedAt >= new Date('2026-09-01T00:00:00Z') &&
          order.placedAt < new Date('2026-10-01T00:00:00Z'),
      )
      .map((order) => order.orderNumber)
      .sort((a, b) => b - a);
    expect(expected.length).toBeGreaterThan(0);
    expect(result.orders.map((order) => order.order_number)).toEqual(expected);
  });

  it('rejects bad input with clear errors', async () => {
    const badStatus = await mcp.call('list_orders', { status: 'shipped' });
    expect(badStatus.isError).toBe(true);
    const badDate = await mcp.call('list_orders', { placed_from: '31-10-2026' });
    expect(badDate.isError).toBe(true);
    const reversed = await mcp.call('list_orders', {
      placed_from: '2026-10-10',
      placed_to: '2026-10-01',
    });
    expect(reversed.isError).toBe(true);
    expect(textOf(reversed)).toMatch(/placed_from must be on or before placed_to/);
    const tooMany = await mcp.call('list_orders', { limit: 500 });
    expect(tooMany.isError).toBe(true);
    const badCursor = await mcp.call('list_orders', { cursor: 'not-a-cursor' });
    expect(badCursor.isError).toBe(true);
    expect(textOf(badCursor)).toMatch(/cursor is invalid/);
  });

  it('rejects a cursor made by another tool', async () => {
    const products = await mcp.data<{ next_cursor: string }>('search_products', { limit: 1 });
    const result = await mcp.call('list_orders', { cursor: products.next_cursor });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cursor is invalid/);
  });

  it('never shows another store', async () => {
    const result = await mcp.data<{ orders: OrderSummary[] }>('list_orders', { limit: 50 });
    expect(result.orders.some((order) => order.order_number === 9001)).toBe(false);
  });
});

describe('search_orders', () => {
  it('finds an order by number with or without #', async () => {
    for (const query of ['1042', '#1042']) {
      const result = await mcp.data<{ orders: OrderSummary[] }>('search_orders', { query });
      expect(result.orders.map((order) => order.order_number)).toContain(1042);
    }
  });

  it('finds orders by customer email and by part of a name, case-insensitively', async () => {
    const { customer } = customerOf(1042);
    const expected = truth.orders
      .filter((order) => truth.customers[order.customerIndex]?.email === customer.email)
      .map((order) => order.orderNumber)
      .sort((a, b) => b - a);
    const byEmail = await mcp.data<{ orders: OrderSummary[] }>('search_orders', {
      query: customer.email.toUpperCase(),
      limit: 50,
    });
    expect(byEmail.orders.map((order) => order.order_number)).toEqual(expected);

    const surname = customer.name.split(' ')[1] ?? '';
    const byName = await mcp.data<{ orders: OrderSummary[] }>('search_orders', {
      query: surname.toLowerCase(),
      limit: 50,
    });
    expect(byName.orders.length).toBeGreaterThan(0);
    expect(byName.orders.every((order) => order.customer_name.includes(surname))).toBe(true);
  });

  it('treats LIKE wildcards literally', async () => {
    const result = await mcp.data<{ orders: OrderSummary[] }>('search_orders', { query: '%' });
    expect(result.orders).toEqual([]);
  });

  it('does not find another store order', async () => {
    const result = await mcp.data<{ orders: OrderSummary[] }>('search_orders', { query: '9001' });
    expect(result.orders).toEqual([]);
  });

  it('rejects empty and overlong queries', async () => {
    expect((await mcp.call('search_orders', { query: '   ' })).isError).toBe(true);
    expect((await mcp.call('search_orders', { query: 'x'.repeat(101) })).isError).toBe(true);
    expect((await mcp.call('search_orders', {})).isError).toBe(true);
  });
});

describe('get_order', () => {
  it('returns items, totals, payment, refunds, notes and status history', async () => {
    const refunded = truth.orders.find((order) => order.status === 'partially_refunded');
    if (!refunded) throw new Error('seed has no partial refund');
    const result = await mcp.data<{
      order: {
        order_number: number;
        status: string;
        items: { sku: string; quantity: number; line_total_cents: number }[];
        totals: Record<string, number>;
        payment: { method: string; reference: string } | null;
        refunds: { amount_cents: number; status: string }[];
        notes: { author: string; body: string }[];
        status_history: { status: string; at: string }[];
      };
    }>('get_order', { order_number: refunded.orderNumber });

    const refundedCents = refunded.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
    expect(result.order.order_number).toBe(refunded.orderNumber);
    expect(result.order.status).toBe('partially_refunded');
    expect(result.order.items).toHaveLength(refunded.items.length);
    expect(result.order.totals).toEqual({
      subtotal_cents: refunded.subtotalCents,
      shipping_cents: refunded.shippingCents,
      tax_cents: refunded.taxCents,
      total_cents: refunded.totalCents,
      refunded_cents: refundedCents,
      net_cents: refunded.totalCents - refundedCents,
    });
    expect(result.order.payment).toEqual({
      method: 'card',
      reference: `pi_demo_${refunded.orderNumber}`,
      paid_at: refunded.paidAt?.toISOString(),
    });
    expect(result.order.refunds.map((refund) => refund.amount_cents)).toEqual([refundedCents]);
    expect(result.order.notes.some((note) => note.author === 'staff')).toBe(true);
    expect(result.order.status_history.map((entry) => entry.status)).toEqual([
      'pending',
      'paid',
      'fulfilled',
      'partially_refunded',
    ]);
  });

  it('returns payment null for an unpaid order', async () => {
    const pending = truth.orders.find((order) => order.status === 'pending');
    if (!pending) throw new Error('seed has no pending order');
    const result = await mcp.data<{ order: { payment: unknown; status_history: unknown[] } }>(
      'get_order',
      { order_number: pending.orderNumber },
    );
    expect(result.order.payment).toBeNull();
    expect(result.order.status_history).toHaveLength(1);
  });

  it('returns instruction-like notes as plain data', async () => {
    const order = truth.orders.find((candidate) =>
      candidate.notes.some((note) => note.body === INSTRUCTION_LIKE_NOTE),
    );
    if (!order) throw new Error('seed has no instruction-like note');
    const result = await mcp.data<{ order: { notes: { body: string }[] } }>('get_order', {
      order_number: order.orderNumber,
    });
    expect(result.order.notes.map((note) => note.body)).toContain(INSTRUCTION_LIKE_NOTE);
  });

  it('reports a missing order, including one that only exists in another store', async () => {
    for (const orderNumber of [99999, 9001]) {
      const result = await mcp.call('get_order', { order_number: orderNumber });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(`Order ${orderNumber} was not found in this store.`);
    }
  });

  it('rejects invalid order numbers', async () => {
    for (const order_number of [0, -5, 1.5, '1042']) {
      expect((await mcp.call('get_order', { order_number })).isError).toBe(true);
    }
  });
});

describe('search_products', () => {
  it('browses every product by SKU with a cursor', async () => {
    const skus: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { products: Product[]; next_cursor: string | null; categories: string[] } =
        await mcp.data('search_products', cursor ? { limit: 15, cursor } : { limit: 15 });
      skus.push(...page.products.map((product) => product.sku));
      expect(page.categories).toEqual([
        'Bags',
        'Candles',
        'Garden',
        'Home',
        'Kitchen',
        'Stationery',
      ]);
      cursor = page.next_cursor;
    } while (cursor);
    expect(skus).toEqual(truth.products.map((product) => product.sku).sort());
  });

  it('filters by text and category', async () => {
    const mugs = await mcp.data<{ products: Product[] }>('search_products', { query: 'mug' });
    expect(mugs.products.map((product) => product.name).sort()).toEqual([
      'Ceramic Mug',
      'Enamel Camp Mug',
    ]);
    const garden = await mcp.data<{ products: Product[] }>('search_products', {
      category: 'garden',
      limit: 50,
    });
    expect(garden.products).toHaveLength(6);
    expect(garden.products.every((product) => product.category === 'Garden')).toBe(true);
    const none = await mcp.data<{ products: Product[] }>('search_products', {
      query: 'mug',
      category: 'Garden',
    });
    expect(none.products).toEqual([]);
  });

  it('rejects bad input', async () => {
    expect((await mcp.call('search_products', { query: '' })).isError).toBe(true);
    expect((await mcp.call('search_products', { limit: 0 })).isError).toBe(true);
  });
});

describe('get_stock_levels', () => {
  it('lists lowest stock first and summarises low and sold out products', async () => {
    const result = await mcp.data<{
      products: Product[];
      summary: Record<string, number>;
      next_cursor: string | null;
    }>('get_stock_levels', { limit: 50 });
    const stock = result.products.map((product) => product.stock_on_hand);
    expect(stock).toEqual([...stock].sort((a, b) => a - b));
    expect(result.products).toHaveLength(40);
    expect(result.next_cursor).toBeNull();
    expect(result.summary).toEqual({
      product_count: 40,
      low_stock_count: truth.products.filter((p) => p.stockOnHand <= p.lowStockThreshold).length,
      out_of_stock_count: truth.products.filter((p) => p.stockOnHand === 0).length,
    });
  });

  it('filters to low stock only and paginates', async () => {
    const first = await mcp.data<{ products: Product[]; next_cursor: string | null }>(
      'get_stock_levels',
      { low_stock_only: true, limit: 4 },
    );
    expect(first.products).toHaveLength(4);
    expect(first.next_cursor).not.toBeNull();
    const second = await mcp.data<{ products: Product[]; next_cursor: string | null }>(
      'get_stock_levels',
      { low_stock_only: true, limit: 4, cursor: first.next_cursor },
    );
    const all = [...first.products, ...second.products];
    expect(all).toHaveLength(6);
    expect(new Set(all.map((product) => product.sku)).size).toBe(6);
    expect(all.every((product) => product.is_low_stock)).toBe(true);
    expect(second.next_cursor).toBeNull();
  });

  it('rejects bad input', async () => {
    expect((await mcp.call('get_stock_levels', { low_stock_only: 'yes' })).isError).toBe(true);
  });
});
