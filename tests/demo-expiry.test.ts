import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveAction } from '../src/approvals.js';
import { withPrincipal } from '../src/db/principal.js';
import type { Principal } from '../src/db/types.js';
import { purgeExpiredDemoStores } from '../src/maintenance.js';
import { ensureDemoStore } from '../src/seed/provision.js';
import { createDemoUser, DEMO_USER_LIFETIME_MS, signInGithubUser } from '../src/users.js';
import { openTestDatabase, type TestDatabase } from './helpers.js';
import { connectClient, textOf } from './mcp-client.js';

const EXPIRED_MESSAGE = /This demo expired/;

/** Tables the cleanup empties for a wiped store. audit_log and stores are kept. */
const WIPED_TABLES = [
  'store_members',
  'customers',
  'products',
  'orders',
  'order_items',
  'order_notes',
  'refunds',
  'approvals',
];

let local: TestDatabase;

beforeAll(async () => {
  local = await openTestDatabase();
});

afterAll(async () => {
  await local.close();
});

async function demoStore(now = new Date()): Promise<Principal & { expiresAt: Date }> {
  const demo = await createDemoUser(local.app, now, 1000);
  if (!demo) throw new Error('demo user not created');
  const { principal } = await ensureDemoStore(local.app, demo.userId, now);
  return { ...principal, expiresAt: demo.expiresAt };
}

/** Moves a store's expiry (and its user's) into the past, as the database clock sees it. */
async function expire(principal: Principal): Promise<void> {
  await local.owner.query(
    "update store_ops.stores set expires_at = now() - interval '1 minute' where id = $1",
    [principal.storeId],
  );
  await local.owner.query(
    "update store_ops.users set expires_at = now() - interval '1 minute' where id = $1",
    [principal.userId],
  );
}

async function ownerCount(table: string, storeId: string): Promise<number> {
  const { rows } = await local.owner.query<{ n: number }>(
    `select count(*)::int as n from store_ops.${table} where store_id = $1`,
    [storeId],
  );
  return rows[0]?.n ?? -1;
}

async function addAuditRow(principal: Principal): Promise<void> {
  await withPrincipal(local.app, principal, (tx) =>
    tx.query(
      `insert into store_ops.audit_log (store_id, user_id, tool, summary)
       values ($1, $2, 'adjust_stock', 'Test audit row')`,
      [principal.storeId, principal.userId],
    ),
  );
}

async function firstSku(principal: Principal): Promise<string> {
  const { rows } = await withPrincipal(local.app, principal, (tx) =>
    tx.query<{ sku: string }>('select sku from store_ops.products order by sku limit 1'),
  );
  const sku = rows[0]?.sku;
  if (!sku) throw new Error('no products');
  return sku;
}

describe('demo store expiry', () => {
  it('gives a demo store its user expiry and a GitHub user store none', async () => {
    const demo = await demoStore();
    const { rows } = await local.owner.query<{ expires_at: Date | string }>(
      'select expires_at from store_ops.stores where id = $1',
      [demo.storeId],
    );
    expect(new Date(rows[0]?.expires_at ?? 0).toISOString()).toBe(demo.expiresAt.toISOString());

    const githubUser = await signInGithubUser(local.app, { id: 77001, login: 'expiry-octo' });
    const { principal } = await ensureDemoStore(local.app, githubUser);
    const github = await local.owner.query<{ expires_at: unknown }>(
      'select expires_at from store_ops.stores where id = $1',
      [principal.storeId],
    );
    expect(github.rows).toEqual([{ expires_at: null }]);
  });

  it('hides an expired demo store and all its rows from the app at once', async () => {
    const demo = await demoStore();
    await expire(demo);
    for (const table of ['stores', 'customers', 'products', 'orders', 'audit_log']) {
      const { rows } = await withPrincipal(local.app, demo, (tx) =>
        tx.query<{ n: number }>(`select count(*)::int as n from store_ops.${table}`),
      );
      expect(rows[0]?.n, table).toBe(0);
    }
    await expect(addAuditRow(demo)).rejects.toThrow(/row-level security/);
  });

  it('refuses read and write tool calls once the server clock passes the expiry', async () => {
    const demo = await demoStore();
    let now = new Date();
    const client = await connectClient(local.app, demo, () => now);
    const sku = await firstSku(demo);
    const stockOf = async () => {
      const { rows } = await withPrincipal(local.app, demo, (tx) =>
        tx.query<{ stock_on_hand: number }>(
          'select stock_on_hand from store_ops.products where sku = $1',
          [sku],
        ),
      );
      return rows[0]?.stock_on_hand;
    };
    const stockBefore = await stockOf();
    const args = { sku, quantity_change: 1, reason: 'Recount' };

    const prepared = await client.data<{ approval_id: string }>('adjust_stock', args);
    await approveAction(local.app, demo, prepared.approval_id, 'approve', now);

    now = new Date(demo.expiresAt.getTime() + 1000);
    for (const [name, toolArgs] of [
      ['get_stock_levels', {}],
      ['list_orders', {}],
      ['adjust_stock', args],
      ['adjust_stock', { ...args, approval_id: prepared.approval_id }],
    ] as const) {
      const result = await client.call(name, toolArgs);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(EXPIRED_MESSAGE);
      // Not a remote server: no OAuth challenge in the result.
      expect(result._meta?.['mcp/www_authenticate'], name).toBeUndefined();
    }
    expect(await stockOf()).toBe(stockBefore);
    expect(await ownerCount('audit_log', demo.storeId)).toBe(0);
    await client.close();
  });

  it('refuses tool calls on a store the database already hides', async () => {
    const demo = await demoStore();
    await expire(demo);
    const client = await connectClient(local.app, demo, new Date());
    const result = await client.call('get_stock_levels', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(EXPIRED_MESSAGE);
    await client.close();
  });
});

describe('cleanup of expired demo stores', () => {
  it('wipes expired demo stores except audit_log and leaves every other store alone', async () => {
    const expired = await demoStore();
    await addAuditRow(expired);
    const fresh = await demoStore();
    await addAuditRow(fresh);
    const githubUser = await signInGithubUser(local.app, { id: 77002, login: 'keeps-octo' });
    const { principal: github } = await ensureDemoStore(local.app, githubUser);
    await expire(expired);

    const purged = await purgeExpiredDemoStores(local.app);
    const mine = purged.find((store) => store.storeId === expired.storeId);
    expect(mine?.userIds).toEqual([expired.userId]);
    expect(purged.map((store) => store.storeId)).not.toContain(fresh.storeId);
    expect(purged.map((store) => store.storeId)).not.toContain(github.storeId);

    for (const table of WIPED_TABLES) {
      expect(await ownerCount(table, expired.storeId), table).toBe(0);
    }
    expect(await ownerCount('audit_log', expired.storeId)).toBe(1);
    const store = await local.owner.query<{ wiped_at: unknown }>(
      'select wiped_at from store_ops.stores where id = $1',
      [expired.storeId],
    );
    expect(store.rows[0]?.wiped_at).not.toBeNull();

    for (const kept of [fresh, github]) {
      for (const table of ['store_members', 'customers', 'products', 'orders', 'order_items']) {
        expect(await ownerCount(table, kept.storeId), table).toBeGreaterThan(0);
      }
    }
    expect(await ownerCount('audit_log', fresh.storeId)).toBe(1);

    const again = await purgeExpiredDemoStores(local.app);
    expect(again.map((row) => row.storeId)).not.toContain(expired.storeId);
  });

  it('keeps the app role without DELETE and audit_log append-only', async () => {
    const demo = await demoStore();
    await addAuditRow(demo);
    for (const table of ['orders', 'products', 'store_members', 'audit_log']) {
      await expect(
        withPrincipal(local.app, demo, (tx) => tx.query(`delete from store_ops.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      local.owner.query('delete from store_ops.audit_log where store_id = $1', [demo.storeId]),
    ).rejects.toThrow(/append-only/);
  });

  it('checks the batch size', async () => {
    for (const limit of [0, 501]) {
      await expect(purgeExpiredDemoStores(local.app, limit)).rejects.toThrow(/p_limit/);
    }
  });
});

describe('daily cap on new demo users', () => {
  it('stops creating demo users once the cap for today is reached', async () => {
    const { rows } = await local.owner.query<{ n: number }>(
      `select count(*)::int as n from store_ops.users
       where kind = 'demo' and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
    );
    const today = rows[0]?.n ?? 0;
    const now = new Date();
    expect(await createDemoUser(local.app, now, today + 1)).toBeDefined();
    expect(await createDemoUser(local.app, now, today + 1)).toBeUndefined();
    expect(await createDemoUser(local.app, now, 0)).toBeUndefined();
    const demo = await createDemoUser(local.app, now, today + 2);
    expect(demo?.expiresAt.getTime()).toBe(now.getTime() + DEMO_USER_LIFETIME_MS);
  });

  it('refuses a negative cap', async () => {
    await expect(createDemoUser(local.app, new Date(), -1)).rejects.toThrow(/dailyCap/);
  });
});
