-- Hardening after the Run 4 security review.
--
-- - A per-client daily limit on new demo users, so one client cannot use up the global daily
--   cap for everyone. The app passes an HMAC of the client's network (never the address itself).
-- - create_demo_user() refuses an expiry more than 24 hours ahead, so an app bug cannot make a
--   demo store that never expires.
-- - The purge locks stores with FOR NO KEY UPDATE (it only sets wiped_at), which does not block
--   the foreign key checks of a write still finishing in that store, and it waits 15 minutes
--   after the expiry before wiping (RLS hides the store from the expiry on).

alter table store_ops.users add column client_hash text;

create index users_demo_client_day_idx on store_ops.users (client_hash, created_at)
  where kind = 'demo';

drop function store_ops.create_demo_user(timestamptz, integer);

-- Returns the new user id, or a refusal: 'daily_cap' (all clients today, UTC) or 'client_cap'
-- (this client today). The advisory lock makes concurrent sign-ups count one after another.
create function store_ops.create_demo_user(
  p_expires_at timestamptz,
  p_daily_cap integer,
  p_client_hash text,
  p_client_daily_cap integer
)
returns table (user_id uuid, refusal text)
language plpgsql security definer
set search_path = store_ops, pg_temp
as $$
declare
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_id uuid;
begin
  if p_daily_cap is null or p_daily_cap < 0 or p_client_daily_cap is null
     or p_client_daily_cap < 0 then
    raise exception 'caps must be zero or more' using errcode = 'invalid_parameter_value';
  end if;
  if p_client_hash is null or length(p_client_hash) not between 16 and 128 then
    raise exception 'p_client_hash is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_expires_at is null or p_expires_at > now() + interval '24 hours 5 minutes' then
    raise exception 'a demo user expires within 24 hours'
      using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('store_ops.demo_daily_cap', 0));
  if (
    select count(*) from store_ops.users u
    where u.kind = 'demo' and u.created_at >= v_day_start
  ) >= p_daily_cap then
    return query select null::uuid, 'daily_cap'::text;
    return;
  end if;
  if (
    select count(*) from store_ops.users u
    where u.kind = 'demo' and u.client_hash = p_client_hash and u.created_at >= v_day_start
  ) >= p_client_daily_cap then
    return query select null::uuid, 'client_cap'::text;
    return;
  end if;
  insert into store_ops.users (kind, expires_at, client_hash)
  values ('demo', p_expires_at, p_client_hash)
  returning id into v_id;
  return query select v_id, null::text;
end
$$;

revoke all on function store_ops.create_demo_user(timestamptz, integer, text, integer) from public;
grant execute on function store_ops.create_demo_user(timestamptz, integer, text, integer)
  to store_ops_app;

grant create on schema store_ops to store_ops_definer;
alter function store_ops.create_demo_user(timestamptz, integer, text, integer)
  owner to store_ops_definer;
revoke create on schema store_ops from store_ops_definer;

-- Replacing the janitor's function: switch to that role for the replacement.
grant create on schema store_ops to store_ops_janitor;
set local role store_ops_janitor;

create or replace function store_ops.purge_expired_demo_stores(p_limit integer)
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
    where s.expires_at <= now() - interval '15 minutes' and s.wiped_at is null
    order by s.expires_at, s.id
    limit p_limit
    for no key update skip locked
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

reset role;
revoke create on schema store_ops from store_ops_janitor;
