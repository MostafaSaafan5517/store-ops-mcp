-- Each user owns at most one store (their Demo Store). Two first requests for the same user
-- used to race and create two stores; the advisory lock below serialises them, and this
-- index makes the rule hold even for code paths that skip the lock.

create unique index store_members_one_owned_store on store_ops.store_members (user_id)
  where role = 'owner';

-- Returns the user's owned store, creating it when missing. The transaction-scoped advisory
-- lock is keyed on the user, so a concurrent caller waits until the first one commits and
-- then sees its store. Security definer for the same reason as create_store.
create function store_ops.ensure_owned_store(p_name text)
returns table (store_id uuid, created boolean)
language plpgsql security definer
set search_path = store_ops, pg_temp
as $$
declare
  v_user uuid := store_ops.current_user_id();
  v_store uuid;
begin
  if v_user is null then
    raise exception 'store_ops.user_id is not set' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('store_ops.provision:' || v_user::text, 0));
  select m.store_id into v_store
  from store_ops.store_members m
  where m.user_id = v_user and m.role = 'owner';
  if v_store is not null then
    return query select v_store, false;
    return;
  end if;
  return query select store_ops.create_store(p_name), true;
end
$$;

revoke all on function store_ops.ensure_owned_store(text) from public;
grant execute on function store_ops.ensure_owned_store(text) to store_ops_app;
