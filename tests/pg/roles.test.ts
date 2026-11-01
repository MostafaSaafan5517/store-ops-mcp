import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPrincipal } from '../../src/db/principal.js';
import type { Principal } from '../../src/db/types.js';
import { addSampleOrder, createEmptyStore, USER_A, USER_B } from '../helpers.js';
import {
  databaseUrl,
  LOGIN_ROLE,
  OWNER_ROLE,
  openPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../support/postgres.js';

// What the app's login role can and cannot do on real Postgres. The app adapter runs
// `SET LOCAL ROLE store_ops_app`; these tests connect as the login role directly and check that
// leaving that role (RESET ROLE) or changing the database setup gains nothing.
//
// Limit: RLS here protects against app bugs (a wrong or missing principal), not against
// arbitrary SQL. Whoever can run SQL as this role can set store_ops.user_id to any user id it
// knows. The boundary for that is that tool input never becomes SQL.

let local: PostgresTestDatabase;
let storeA: Principal;
let storeB: Principal;
let login: Client;

async function connectAs(role: { user: string; password: string }): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl(local.name, role) });
  await client.connect();
  return client;
}

/** Runs `fn` in a transaction on `client` with A's user and B's store set, then rolls back. */
async function inTransaction<T>(
  client: Client,
  principal: Principal,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query(
      "select set_config('store_ops.user_id', $1, true), set_config('store_ops.store_id', $2, true)",
      [principal.userId, principal.storeId],
    );
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

async function count(client: Client, table: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from store_ops.${table}`,
  );
  return rows[0]?.n ?? -1;
}

beforeAll(async () => {
  local = await openPostgresTestDatabase();
  storeA = await createEmptyStore(local, USER_A);
  storeB = await createEmptyStore(local, USER_B);
  await addSampleOrder(local, storeA, 1001);
  await addSampleOrder(local, storeB, 2001);
  login = await connectAs(LOGIN_ROLE);
});

afterAll(async () => {
  await login.end();
  await local.close();
});

describe('the app login role', () => {
  it('is a plain role that is only a member of store_ops_app', async () => {
    const { rows } = await local.owner.query<Record<string, boolean>>(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
       from pg_roles where rolname = $1`,
      [LOGIN_ROLE.user],
    );
    expect(rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
      },
    ]);
    const memberships = await local.owner.query<{ role: string }>(
      `select r.rolname as role from pg_auth_members m
       join pg_roles r on r.oid = m.roleid
       join pg_roles u on u.oid = m.member
       where u.rolname = $1`,
      [LOGIN_ROLE.user],
    );
    expect(memberships.rows).toEqual([{ role: 'store_ops_app' }]);
  });

  it('owns no table, function or schema', async () => {
    const { rows } = await local.owner.query<{ n: number }>(
      `select (select count(*) from pg_class c join pg_roles r on r.oid = c.relowner
               where r.rolname = $1)
            + (select count(*) from pg_proc p join pg_roles r on r.oid = p.proowner
               where r.rolname = $1)
            + (select count(*) from pg_namespace n join pg_roles r on r.oid = n.nspowner
               where r.rolname = $1) as n`,
      [LOGIN_ROLE.user],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('cannot SET ROLE or SET SESSION AUTHORIZATION to the owner or the superuser', async () => {
    for (const sql of [
      `set role ${OWNER_ROLE.user}`,
      'set role postgres',
      'set role store_ops_definer',
      `set session authorization ${OWNER_ROLE.user}`,
      'set session authorization postgres',
    ]) {
      await expect(login.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('after RESET ROLE is still only store_ops_app: no other store, no missing filters', async () => {
    const aWithStoreB: Principal = { userId: USER_A, storeId: storeB.storeId };
    await inTransaction(login, aWithStoreB, async () => {
      await login.query('set local role store_ops_app');
      await login.query('reset role');
      const { rows } = await login.query<{ user: string }>('select current_user as user');
      expect(rows[0]?.user).toBe(LOGIN_ROLE.user);
      for (const table of ['stores', 'customers', 'products', 'orders', 'order_items']) {
        expect(await count(login, table), table).toBe(0);
      }
    });
    await inTransaction(login, storeA, async () => {
      await login.query('reset role');
      expect(await count(login, 'orders')).toBe(1);
      const { rows } = await login.query<{ order_number: number }>(
        'select order_number from store_ops.orders',
      );
      expect(rows).toEqual([{ order_number: 1001 }]);
    });
  });

  it('reads nothing at all without the session settings', async () => {
    for (const table of ['stores', 'store_members', 'orders', 'approvals', 'audit_log']) {
      expect(await count(login, table), table).toBe(0);
    }
  });

  it('cannot turn row security off or change policies', async () => {
    for (const sql of [
      'alter table store_ops.orders disable row level security',
      'alter table store_ops.orders no force row level security',
      'drop policy orders_select on store_ops.orders',
      'create policy everything on store_ops.orders for select to store_ops_app using (true)',
      'alter function store_ops.is_member(uuid) owner to store_ops_login',
      'alter table store_ops.audit_log disable trigger audit_log_no_update_delete',
    ]) {
      await expect(login.query(sql), sql).rejects.toThrow(/must be owner|permission denied/);
    }
    await inTransaction(login, storeA, async () => {
      await login.query('set local row_security = off');
      await expect(login.query('select * from store_ops.orders')).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it('cannot grant itself more or create objects', async () => {
    for (const sql of [
      `grant ${OWNER_ROLE.user} to ${LOGIN_ROLE.user}`,
      `grant store_ops_definer to ${LOGIN_ROLE.user}`,
      `alter role ${LOGIN_ROLE.user} bypassrls`,
      'create table store_ops.escape (id int)',
      'create function store_ops.escape() returns int language sql as $$ select 1 $$',
      'create schema escape',
      'create temp table escape (id int)',
    ]) {
      await expect(login.query(sql), sql).rejects.toThrow(/permission denied|must have/);
    }
  });

  it('cannot use the session_replication_role switch that skips triggers', async () => {
    await expect(login.query("set session_replication_role = 'replica'")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('the schema owner (not a superuser, no BYPASSRLS)', () => {
  let owner: Client;

  beforeAll(async () => {
    owner = await connectAs(OWNER_ROLE);
  });

  afterAll(async () => {
    await owner.end();
  });

  it('is bound by FORCE ROW LEVEL SECURITY like everyone else', async () => {
    await inTransaction(owner, storeA, async () => {
      for (const table of ['stores', 'customers', 'orders', 'store_members']) {
        expect(await count(owner, table), table).toBe(0);
      }
    });
  });

  it('cannot change or remove an audit_log row (RLS hides it, the trigger blocks TRUNCATE)', async () => {
    await withPrincipal(local.app, storeA, (tx) =>
      tx.query(
        "insert into store_ops.audit_log (store_id, user_id, tool) values ($1, $2, 'test')",
        [storeA.storeId, storeA.userId],
      ),
    );
    await inTransaction(owner, storeA, async () => {
      const update = await owner.query("update store_ops.audit_log set tool = 'changed'");
      const remove = await owner.query('delete from store_ops.audit_log');
      expect([update.rowCount, remove.rowCount]).toEqual([0, 0]);
    });
    await expect(owner.query('truncate store_ops.audit_log')).rejects.toThrow(/append-only/);
    const { rows } = await local.owner.query<{ tool: string }>(
      'select tool from store_ops.audit_log',
    );
    expect(rows).toEqual([{ tool: 'test' }]);
  });
});

describe('roles and policies stay as designed', () => {
  it('store_ops_app and store_ops_definer are members of no role and cannot bypass RLS', async () => {
    const { rows } = await local.owner.query<{ role: string; bypass: boolean; member_of: string }>(
      `select r.rolname as role, r.rolbypassrls as bypass,
              (select count(*) from pg_auth_members m where m.member = r.oid) as member_of
       from pg_roles r where r.rolname in ('store_ops_app', 'store_ops_definer')
       order by r.rolname`,
    );
    expect(rows).toEqual([
      { role: 'store_ops_app', bypass: false, member_of: '0' },
      { role: 'store_ops_definer', bypass: false, member_of: '0' },
    ]);
  });

  it('every policy is for store_ops_app, except the narrow definer policies', async () => {
    const { rows } = await local.owner.query<{ policy: string; roles: string }>(
      `select policyname as policy, array_to_string(roles, ',') as roles
       from pg_policies
       where schemaname = 'store_ops' and roles <> array['store_ops_app']::name[]
       order by policyname`,
    );
    expect(rows).toEqual(
      [
        'store_members_definer_insert',
        'store_members_definer_select',
        'stores_definer_insert',
        'users_definer_insert',
        'users_definer_select',
        'users_definer_update',
      ].map((policy) => ({ policy, roles: 'store_ops_definer' })),
    );
  });

  it('the definer role holds only the table privileges its functions need', async () => {
    const { rows } = await local.owner.query<{ grant: string }>(
      `select table_name || ':' || string_agg(privilege_type, ',' order by privilege_type) as grant
       from information_schema.role_table_grants
       where grantee = 'store_ops_definer'
       group by table_name order by table_name`,
    );
    expect(rows.map((row) => row.grant)).toEqual([
      'store_members:INSERT,SELECT',
      'stores:INSERT',
      'users:INSERT,SELECT,UPDATE',
    ]);
  });
});

describe('the security definer role', () => {
  it('has no login, no BYPASSRLS and owns no table', async () => {
    const { rows } = await local.owner.query<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
      tables: string;
    }>(
      `select rolcanlogin, rolbypassrls, rolsuper,
              (select count(*) from pg_class c where c.relowner = r.oid) as tables
       from pg_roles r where rolname = 'store_ops_definer'`,
    );
    expect(rows).toEqual([
      { rolcanlogin: false, rolbypassrls: false, rolsuper: false, tables: '0' },
    ]);
  });

  it('owns exactly the security definer functions', async () => {
    const { rows } = await local.owner.query<{ name: string; owner: string }>(
      `select p.proname as name, r.rolname as owner
       from pg_proc p join pg_roles r on r.oid = p.proowner
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'store_ops' and p.prosecdef
       order by p.proname`,
    );
    expect(rows).toEqual(
      ['create_demo_user', 'create_store', 'ensure_owned_store', 'is_member', 'sign_in_github'].map(
        (name) => ({ name, owner: 'store_ops_definer' }),
      ),
    );
  });
});
