import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalDatabase } from '../src/db/pglite.js';
import { listStoreIdsForUser, withPrincipal } from '../src/db/principal.js';
import type { Principal } from '../src/db/types.js';
import { addSampleOrder, createEmptyStore, openTestDatabase, USER_A, USER_B } from './helpers.js';

const STORE_TABLES = [
  'stores',
  'store_members',
  'customers',
  'products',
  'orders',
  'order_items',
  'order_notes',
  'refunds',
  'approvals',
  'audit_log',
];

let local: LocalDatabase;
let storeA: Principal;
let storeB: Principal;
let orderB: { customerId: string; productId: string; orderId: string };

beforeAll(async () => {
  local = await openTestDatabase();
  storeA = await createEmptyStore(local, USER_A);
  storeB = await createEmptyStore(local, USER_B);
  await addSampleOrder(local, storeA, 1001);
  orderB = await addSampleOrder(local, storeB, 2001);
});

afterAll(async () => {
  await local.close();
});

async function countAs(principal: Principal, table: string): Promise<number> {
  return withPrincipal(local.app, principal, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      `select count(*)::int as n from store_ops.${table}`,
    );
    return rows[0]?.n ?? -1;
  });
}

describe('row level security: isolation between stores', () => {
  it('each store sees only its own rows', async () => {
    for (const table of ['stores', 'customers', 'products', 'orders', 'order_items']) {
      expect(await countAs(storeA, table), table).toBe(1);
    }
    const ordersA = await withPrincipal(local.app, storeA, (tx) =>
      tx.query<{ order_number: number }>('select order_number from store_ops.orders'),
    );
    expect(ordersA.rows.map((row) => row.order_number)).toEqual([1001]);
  });

  it('store A cannot read a store B row even by its id', async () => {
    const result = await withPrincipal(local.app, storeA, (tx) =>
      tx.query('select * from store_ops.orders where id = $1', [orderB.orderId]),
    );
    expect(result.rows).toEqual([]);
  });

  it('store A cannot insert rows into store B', async () => {
    await expect(
      withPrincipal(local.app, storeA, (tx) =>
        tx.query(
          `insert into store_ops.products (store_id, sku, name, category, price_cents, stock_on_hand)
           values ($1, 'X-1', 'Intruder', 'Kitchen', 100, 1)`,
          [storeB.storeId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('store A cannot update store B rows', async () => {
    const result = await withPrincipal(local.app, storeA, (tx) =>
      tx.query('update store_ops.products set stock_on_hand = 999 where id = $1', [
        orderB.productId,
      ]),
    );
    expect(result.affectedRows ?? 0).toBe(0);
    const stock = await withPrincipal(local.app, storeB, (tx) =>
      tx.query<{ stock_on_hand: number }>(
        'select stock_on_hand from store_ops.products where id = $1',
        [orderB.productId],
      ),
    );
    expect(stock.rows[0]?.stock_on_hand).toBe(10);
  });

  it('store A cannot move its own row into store B', async () => {
    await expect(
      withPrincipal(local.app, storeA, (tx) =>
        tx.query('update store_ops.products set store_id = $1', [storeB.storeId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('store A cannot attach a note to a store B order', async () => {
    await expect(
      withPrincipal(local.app, storeA, (tx) =>
        tx.query(
          `insert into store_ops.order_notes (store_id, order_id, author, body)
           values ($1, $2, 'staff', 'cross store note')`,
          [storeA.storeId, orderB.orderId],
        ),
      ),
    ).rejects.toThrow();
    expect(await countAs(storeB, 'order_notes')).toBe(0);
  });

  it('pointing the store setting at another store without membership returns nothing', async () => {
    const spoofed: Principal = { userId: USER_A, storeId: storeB.storeId };
    for (const table of STORE_TABLES.filter((table) => table !== 'store_members')) {
      expect(await countAs(spoofed, table), table).toBe(0);
    }
  });

  it('a user only sees their own memberships', async () => {
    expect(await listStoreIdsForUser(local.app, USER_A)).toEqual([storeA.storeId]);
    expect(await listStoreIdsForUser(local.app, USER_B)).toEqual([storeB.storeId]);
  });

  it('with no principal set, the app role sees nothing', async () => {
    for (const table of STORE_TABLES) {
      const { rows } = await local.app.transaction((tx) =>
        tx.query<{ n: number }>(`select count(*)::int as n from store_ops.${table}`),
      );
      expect(rows[0]?.n, table).toBe(0);
    }
  });
});

describe('row level security: the app role cannot bypass it', () => {
  it('runs as a non-superuser role without BYPASSRLS', async () => {
    const { rows } = await local.app.transaction((tx) =>
      tx.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `select current_user, r.rolsuper, r.rolbypassrls
         from pg_roles r where r.rolname = current_user`,
      ),
    );
    expect(rows[0]).toEqual({
      current_user: 'store_ops_app',
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it('every table has RLS enabled and forced, and is not owned by the app role', async () => {
    const { rows } = await local.owner.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner: string;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'store_ops' and c.relkind = 'r' order by c.relname`,
    );
    expect(rows.map((row) => row.relname).sort()).toEqual([...STORE_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      expect(row.owner, row.relname).not.toBe('store_ops_app');
    }
  });

  it('cannot disable RLS or drop a policy', async () => {
    await expect(
      local.app.transaction((tx) =>
        tx.query('alter table store_ops.orders disable row level security'),
      ),
    ).rejects.toThrow(/must be owner/);
    await expect(
      local.app.transaction((tx) => tx.query('drop policy orders_select on store_ops.orders')),
    ).rejects.toThrow(/must be owner/);
  });

  it('turning row_security off makes queries fail instead of leaking rows', async () => {
    await expect(
      withPrincipal(local.app, storeA, async (tx) => {
        await tx.query('set local row_security = off');
        return tx.query('select * from store_ops.orders');
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot delete rows', async () => {
    await expect(
      withPrincipal(local.app, storeA, (tx) => tx.query('delete from store_ops.orders')),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot create memberships directly', async () => {
    await expect(
      withPrincipal(local.app, storeA, (tx) =>
        tx.query(
          "insert into store_ops.store_members (store_id, user_id, role) values ($1, $2, 'staff')",
          [storeB.storeId, USER_A],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('audit_log is append-only', () => {
  it('accepts inserts for the current store and user', async () => {
    await withPrincipal(local.app, storeA, (tx) =>
      tx.query(
        "insert into store_ops.audit_log (store_id, user_id, tool) values ($1, $2, 'test')",
        [storeA.storeId, storeA.userId],
      ),
    );
    expect(await countAs(storeA, 'audit_log')).toBe(1);
  });

  it('rejects UPDATE and DELETE from the app role', async () => {
    await expect(
      withPrincipal(local.app, storeA, (tx) =>
        tx.query("update store_ops.audit_log set tool = 'changed'"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withPrincipal(local.app, storeA, (tx) => tx.query('delete from store_ops.audit_log')),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects UPDATE, DELETE and TRUNCATE even from the owner (trigger)', async () => {
    await expect(
      local.owner.query("update store_ops.audit_log set tool = 'changed'"),
    ).rejects.toThrow(/append-only/);
    await expect(local.owner.query('delete from store_ops.audit_log')).rejects.toThrow(
      /append-only/,
    );
    await expect(local.owner.query('truncate store_ops.audit_log')).rejects.toThrow(/append-only/);
    const { rows } = await local.owner.query<{ n: number; tool: string }>(
      'select count(*)::int as n, min(tool) as tool from store_ops.audit_log',
    );
    expect(rows[0]).toEqual({ n: 1, tool: 'test' });
  });

  it('rejects an entry written for another store', async () => {
    await expect(
      withPrincipal(local.app, storeA, (tx) =>
        tx.query(
          "insert into store_ops.audit_log (store_id, user_id, tool) values ($1, $2, 'test')",
          [storeB.storeId, storeA.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
