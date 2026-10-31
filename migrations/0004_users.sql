-- Users of the remote server. Every user has an internal UUID that the rest of the schema uses
-- (store_members.user_id, approvals.user_id, audit_log.user_id). A user signs in with GitHub
-- or is a throwaway demo user created by "Try the demo".
--
-- The app role has no privileges on this table. It signs users in only through the two
-- security definer functions below, which return the internal id.

create table store_ops.users (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('github', 'demo')),
  github_id bigint unique,
  github_login text,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz not null default now(),
  -- Demo users stop working after this time. Their stores are not deleted yet (see README).
  expires_at timestamptz,
  check ((kind = 'github') = (github_id is not null)),
  check ((kind = 'demo') = (expires_at is not null))
);

alter table store_ops.users enable row level security;
alter table store_ops.users force row level security;

revoke all on store_ops.users from public;

-- Returns the internal id for a GitHub account, creating the user on first sign-in.
create function store_ops.sign_in_github(p_github_id bigint, p_login text) returns uuid
language sql security definer
set search_path = store_ops, pg_temp
as $$
  insert into store_ops.users (kind, github_id, github_login)
  values ('github', p_github_id, p_login)
  on conflict (github_id) do update
    set github_login = excluded.github_login, last_sign_in_at = now()
  returning id
$$;

-- Creates a new demo user that stops working at p_expires_at.
create function store_ops.create_demo_user(p_expires_at timestamptz) returns uuid
language sql security definer
set search_path = store_ops, pg_temp
as $$
  insert into store_ops.users (kind, expires_at)
  values ('demo', p_expires_at)
  returning id
$$;

revoke all on function store_ops.sign_in_github(bigint, text) from public;
revoke all on function store_ops.create_demo_user(timestamptz) from public;
grant execute on function store_ops.sign_in_github(bigint, text) to store_ops_app;
grant execute on function store_ops.create_demo_user(timestamptz) to store_ops_app;
