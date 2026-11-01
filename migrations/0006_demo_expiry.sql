-- Demo stores expire 24 hours after they are created, together with their demo user.
--
-- - stores.expires_at is copied from the owner's users.expires_at when the store is created,
--   so it is set for demo users only. GitHub users' stores never expire.
-- - is_member() is false for an expired store, so every policy hides it and its rows from the
--   app at once, before any cleanup runs.
-- - purge_expired_demo_stores() wipes expired demo stores, except audit_log. It runs from the
--   Worker's Cron Trigger and is owned by store_ops_janitor, a NOLOGIN role that may delete
--   only rows of expired demo stores (its own policies) and has no access to audit_log. The app
--   role still has no DELETE anywhere.
-- - create_demo_user() takes a global daily cap on new demo users (and so demo stores).

alter table store_ops.stores
  add column expires_at timestamptz,
  add column wiped_at timestamptz,
  add constraint stores_wiped_only_when_expired check (wiped_at is null or expires_at is not null);

create index stores_expiring_idx on store_ops.stores (expires_at)
  where expires_at is not null and wiped_at is null;

-- Replacing functions owned by store_ops_definer: switch to that role for the replacement.
grant create on schema store_ops to store_ops_definer;
set local role store_ops_definer;

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
  -- A demo user's store ends with the user. Ids without a users row (tests) never expire.
  insert into store_ops.stores (id, name, expires_at)
  values (v_store, p_name, (select u.expires_at from store_ops.users u where u.id = v_user));
  insert into store_ops.store_members (store_id, user_id, role) values (v_store, v_user, 'owner');
  return v_store;
end
$$;

create or replace function store_ops.is_member(p_store_id uuid) returns boolean
language sql stable security definer
set search_path = store_ops, pg_temp
as $$
  select exists (
    select 1
    from store_ops.store_members m
    join store_ops.stores s on s.id = m.store_id
    where m.store_id = p_store_id
      and m.user_id = store_ops.current_user_id()
      and (s.expires_at is null or s.expires_at > now())
  )
$$;

reset role;
revoke create on schema store_ops from store_ops_definer;

-- is_member() reads a store's expiry, and create_store() reads the user's.
grant select (id, expires_at) on store_ops.stores to store_ops_definer;
create policy stores_definer_select on store_ops.stores for select to store_ops_definer
  using (true);

-- Demo users with a global daily cap ----------------------------------------------------------

drop function store_ops.create_demo_user(timestamptz);

-- Returns null once p_daily_cap demo users were created today (UTC). The advisory lock makes
-- concurrent sign-ups count one after another, so the cap is exact.
create function store_ops.create_demo_user(p_expires_at timestamptz, p_daily_cap integer)
returns uuid
language plpgsql security definer
set search_path = store_ops, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'p_daily_cap must be zero or more' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('store_ops.demo_daily_cap', 0));
  if (
    select count(*) from store_ops.users u
    where u.kind = 'demo'
      and u.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  ) >= p_daily_cap then
    return null;
  end if;
  insert into store_ops.users (kind, expires_at) values ('demo', p_expires_at) returning id into v_id;
  return v_id;
end
$$;

revoke all on function store_ops.create_demo_user(timestamptz, integer) from public;
grant execute on function store_ops.create_demo_user(timestamptz, integer) to store_ops_app;

grant create on schema store_ops to store_ops_definer;
alter function store_ops.create_demo_user(timestamptz, integer) owner to store_ops_definer;
revoke create on schema store_ops from store_ops_definer;

-- Cleanup of expired demo stores ----------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'store_ops_janitor') then
    create role store_ops_janitor nologin nosuperuser nobypassrls noinherit;
  end if;
  if exists (
    select 1 from pg_roles
    where rolname = 'store_ops_janitor' and (rolcanlogin or rolsuper or rolbypassrls)
  ) then
    raise exception 'store_ops_janitor exists with LOGIN, SUPERUSER or BYPASSRLS';
  end if;
end
$$;

grant store_ops_janitor to current_user with inherit false, set true;
grant usage on schema store_ops to store_ops_janitor;

-- The janitor sees only expired demo stores, and marks them wiped.
grant select (id, expires_at, wiped_at), update (wiped_at) on store_ops.stores
  to store_ops_janitor;
create policy stores_janitor_select on store_ops.stores for select to store_ops_janitor
  using (expires_at is not null and expires_at <= now());
create policy stores_janitor_update on store_ops.stores for update to store_ops_janitor
  using (expires_at is not null and expires_at <= now())
  with check (expires_at is not null and expires_at <= now());

-- In every table it wipes, it can read and delete only rows of stores it can see (expired
-- demo stores). No grant at all on audit_log or users.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'store_members', 'customers', 'products', 'orders', 'order_items', 'order_notes',
    'refunds', 'approvals'
  ] loop
    execute format('grant select, delete on store_ops.%I to store_ops_janitor', v_table);
    execute format(
      'create policy %I on store_ops.%I for select to store_ops_janitor
         using (exists (select 1 from store_ops.stores s where s.id = store_id))',
      v_table || '_janitor_select', v_table);
    execute format(
      'create policy %I on store_ops.%I for delete to store_ops_janitor
         using (exists (select 1 from store_ops.stores s where s.id = store_id))',
      v_table || '_janitor_delete', v_table);
  end loop;
end
$$;

-- Wipes up to p_limit expired demo stores: every row except the store row itself (kept for
-- the audit_log foreign key, with wiped_at set) and its audit_log rows. Uses the database
-- clock, so callers cannot move the expiry. Returns each wiped store with its former members,
-- so the caller can revoke their OAuth grants.
create function store_ops.purge_expired_demo_stores(p_limit integer)
returns table (store_id uuid, user_id uuid)
language plpgsql security definer
set search_path = store_ops, pg_temp
as $$
declare
  v_stores uuid[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(array_agg(e.id), '{}') into v_stores
  from (
    select s.id from store_ops.stores s
    where s.expires_at <= now() and s.wiped_at is null
    order by s.expires_at, s.id
    limit p_limit
    for update skip locked
  ) e;

  return query
    select s.id, m.user_id
    from unnest(v_stores) as s(id)
    left join store_ops.store_members m on m.store_id = s.id;

  delete from store_ops.refunds r where r.store_id = any (v_stores);
  delete from store_ops.order_notes n where n.store_id = any (v_stores);
  delete from store_ops.order_items i where i.store_id = any (v_stores);
  delete from store_ops.orders o where o.store_id = any (v_stores);
  delete from store_ops.customers c where c.store_id = any (v_stores);
  delete from store_ops.products p where p.store_id = any (v_stores);
  delete from store_ops.approvals a where a.store_id = any (v_stores);
  delete from store_ops.store_members m where m.store_id = any (v_stores);
  update store_ops.stores s set wiped_at = now() where s.id = any (v_stores);
end
$$;

revoke all on function store_ops.purge_expired_demo_stores(integer) from public;
grant execute on function store_ops.purge_expired_demo_stores(integer) to store_ops_app;

grant create on schema store_ops to store_ops_janitor;
alter function store_ops.purge_expired_demo_stores(integer) owner to store_ops_janitor;
revoke create on schema store_ops from store_ops_janitor;
