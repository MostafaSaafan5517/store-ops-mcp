import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listStoreIdsForUser, withPrincipal, withUser } from '../src/db/principal.js';
import { ORDER_STATUSES } from '../src/domain.js';
import { FAKE_SURNAMES, FIRST_NAMES } from '../src/seed/catalog.js';
import { generateDemoStore } from '../src/seed/demo-store.js';
import { ensureDemoStore } from '../src/seed/provision.js';
import { openTestDatabase, USER_A, USER_B, USER_C, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-31T12:00:00Z');
const DAY_MS = 86_400_000;

describe('generateDemoStore', () => {
  const data = generateDemoStore({ seed: USER_A, now: NOW });

  it('is deterministic for the same seed and time', () => {
    expect(generateDemoStore({ seed: USER_A, now: NOW })).toEqual(data);
    expect(generateDemoStore({ seed: USER_B, now: NOW })).not.toEqual(data);
  });

  it('is labelled Demo Store and has about 40 products and 200 orders', () => {
    expect(data.name).toBe('Demo Store');
    expect(data.products).toHaveLength(40);
    expect(new Set(data.products.map((product) => product.sku)).size).toBe(40);
    expect(new Set(data.products.map((product) => product.category)).size).toBe(6);
    expect(data.orders).toHaveLength(200);
  });

  it('places orders over the last 90 days with every status represented', () => {
    for (const order of data.orders) {
      expect(order.placedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(order.placedAt.getTime()).toBeGreaterThan(NOW.getTime() - 90 * DAY_MS);
    }
    const statuses = new Set(data.orders.map((order) => order.status));
    expect([...statuses].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('has some low stock and sold out products', () => {
    const low = data.products.filter((product) => product.stockOnHand <= product.lowStockThreshold);
    expect(low.length).toBe(6);
    expect(data.products.filter((product) => product.stockOnHand === 0)).toHaveLength(2);
  });

  it('uses clearly fake customers on example.com', () => {
    for (const customer of data.customers) {
      expect(customer.email).toMatch(/^[a-z]+\.[a-z]+\d+@example\.com$/);
      const [first, last] = customer.name.split(' ');
      expect(FIRST_NAMES).toContain(first);
      expect(FAKE_SURNAMES).toContain(last);
    }
  });

  it('keeps order money consistent in integer cents', () => {
    for (const order of data.orders) {
      const subtotal = order.items.reduce((sum, item) => sum + item.lineTotalCents, 0);
      expect(order.subtotalCents).toBe(subtotal);
      expect(order.totalCents).toBe(order.subtotalCents + order.shippingCents + order.taxCents);
      expect(Number.isInteger(order.totalCents)).toBe(true);
      const refunded = order.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
      if (order.status === 'refunded') expect(refunded).toBe(order.totalCents);
      if (order.status === 'partially_refunded') {
        expect(refunded).toBeGreaterThan(0);
        expect(refunded).toBeLessThan(order.totalCents);
      }
      if (!['refunded', 'partially_refunded'].includes(order.status)) expect(refunded).toBe(0);
    }
  });
});

describe('ensureDemoStore', () => {
  let local: TestDatabase;

  beforeAll(async () => {
    local = await openTestDatabase();
  });

  afterAll(async () => {
    await local.close();
  });

  it('provisions one store per user and reuses it on the next call', async () => {
    const first = await ensureDemoStore(local.app, USER_A, NOW);
    expect(first.created).toBe(true);
    const again = await ensureDemoStore(local.app, USER_A, NOW);
    expect(again).toEqual({ principal: first.principal, created: false });

    const other = await ensureDemoStore(local.app, USER_B, NOW);
    expect(other.principal.storeId).not.toBe(first.principal.storeId);
    expect(await listStoreIdsForUser(local.app, USER_A)).toEqual([first.principal.storeId]);

    const counts = await withPrincipal(local.app, first.principal, async (tx) => {
      const { rows } = await tx.query<Record<string, number>>(
        `select (select count(*)::int from store_ops.products) as products,
                (select count(*)::int from store_ops.orders) as orders,
                (select count(*)::int from store_ops.customers) as customers,
                (select name from store_ops.stores) as name`,
      );
      return rows[0];
    });
    expect(counts).toEqual({ products: 40, orders: 200, customers: 60, name: 'Demo Store' });
  });

  it('creates exactly one store when two first requests arrive at the same time', async () => {
    const results = await Promise.all([
      ensureDemoStore(local.app, USER_C, NOW),
      ensureDemoStore(local.app, USER_C, NOW),
    ]);
    const storeIds = await listStoreIdsForUser(local.app, USER_C);
    expect(storeIds).toHaveLength(1);
    expect(results.map((result) => result.principal.storeId)).toEqual([storeIds[0], storeIds[0]]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('the database allows only one owned store per user', async () => {
    await expect(
      withUser(local.app, USER_C, (tx) => tx.query("select store_ops.create_store('Demo Store')")),
    ).rejects.toThrow(/store_members_one_owned_store/);
  });
});

describe('every user gets the full status mix', () => {
  it('holds for a range of user seeds', () => {
    for (let index = 1; index <= 20; index += 1) {
      const seed = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const statuses = new Set(generateDemoStore({ seed, now: NOW }).orders.map((o) => o.status));
      expect([...statuses].sort(), seed).toEqual([...ORDER_STATUSES].sort());
    }
  });
});
