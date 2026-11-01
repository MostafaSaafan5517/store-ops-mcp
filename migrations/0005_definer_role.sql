-- Security definer functions used to run as the role that ran the migrations. On PGlite that
-- is a superuser, which bypasses RLS, so they worked there. On real Postgres the owner is a
-- normal role without BYPASSRLS, and FORCE ROW LEVEL SECURITY with policies only for
-- store_ops_app left the owner with no visible rows: is_member() was always false and
-- create_store(), sign_in_github() and create_demo_user() failed their inserts.
--
-- These functions now belong to store_ops_definer: a NOLOGIN role that owns no table, has no
-- BYPASSRLS and gets only the privileges and policies the functions need. RLS keeps applying
-- to it, so the functions do not depend on the owner bypassing RLS (a Neon project owner can,
-- a plain Postgres owner cannot).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'store_ops_definer') then
    create role store_ops_definer nologin nosuperuser nobypassrls noinherit;
  end if;
  -- A role of this name created earlier by someone else is not adopted silently.
  if exists (
    select 1 from pg_roles
    where rolname = 'store_ops_definer' and (rolcanlogin or rolsuper or rolbypassrls)
  ) then
    raise exception 'store_ops_definer exists with LOGIN, SUPERUSER or BYPASSRLS';
  end if;
end
$$;

-- create_store() now picks the id itself instead of reading it back with RETURNING, so the
-- definer role needs no SELECT on stores.
create or replace function store_ops.create_store(p_name text) returns uuid
language plpgsql security definer
set search_path = store_ops, pg_temp
as $$
declare
  v_user uuid := store_ops.current_user_id();
  v_store uuid := gen_random_uuid();
begin
  if v_user is null then
    raise exception 'store_ops.user_id is not set' using errcode = 'insufficient_privilege';
  end if;
  insert into store_ops.stores (id, name) values (v_store, p_name);
  insert into store_ops.store_members (store_id, user_id, role) values (v_store, v_user, 'owner');
  return v_store;
end
$$;

-- Handing a function to another owner requires being able to SET ROLE to it. Not inherited,
-- so the migration role gains no privileges from this membership.
grant store_ops_definer to current_user with inherit false, set true;

grant usage on schema store_ops to store_ops_definer;

-- ALTER FUNCTION ... OWNER TO needs CREATE on the schema for the new owner. It is revoked
-- again below, once the functions have moved.
grant create on schema store_ops to store_ops_definer;

alter function store_ops.is_member(uuid) owner to store_ops_definer;
alter function store_ops.create_store(text) owner to store_ops_definer;
alter function store_ops.ensure_owned_store(text) owner to store_ops_definer;
alter function store_ops.sign_in_github(bigint, text) owner to store_ops_definer;
alter function store_ops.create_demo_user(timestamptz) owner to store_ops_definer;

revoke create on schema store_ops from store_ops_definer;

grant execute on function store_ops.current_user_id() to store_ops_definer;

grant select, insert on store_ops.store_members to store_ops_definer;
grant insert on store_ops.stores to store_ops_definer;
grant select, insert, update on store_ops.users to store_ops_definer;

-- is_member() and ensure_owned_store() read only the signed-in user's memberships.
create policy store_members_definer_select on store_ops.store_members for select
  to store_ops_definer
  using (user_id = store_ops.current_user_id());

-- create_store() adds the signed-in user as the owner of the store it just created.
create policy store_members_definer_insert on store_ops.store_members for insert
  to store_ops_definer
  with check (user_id = store_ops.current_user_id() and role = 'owner');

-- create_store() inserts a store. It never reads stores.
create policy stores_definer_insert on store_ops.stores for insert to store_ops_definer
  with check (true);

-- sign_in_github() upserts by GitHub id (ON CONFLICT DO UPDATE needs SELECT);
-- create_demo_user() inserts. Both return only the id.
create policy users_definer_select on store_ops.users for select to store_ops_definer
  using (true);
create policy users_definer_insert on store_ops.users for insert to store_ops_definer
  with check (true);
create policy users_definer_update on store_ops.users for update to store_ops_definer
  using (true) with check (true);
