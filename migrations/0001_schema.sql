-- Store Ops MCP schema. Every table is tenant scoped and protected by row level security.
--
-- The application connects as (or switches to) the non-owner role store_ops_app. Each
-- transaction sets two settings with set_config(..., true):
--   store_ops.user_id   the signed-in user (UUID)
--   store_ops.store_id  the store taken from the auth context (UUID)
-- Policies require the row's store to be the current store AND the current user to be a
-- member of it, so a wrong or missing setting returns nothing instead of another tenant.

create schema if not exists store_ops;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'store_ops_app') then
    create role store_ops_app nologin nosuperuser nobypassrls;
  end if;
end
$$;

grant usage on schema store_ops to store_ops_app;

-- Context helpers -------------------------------------------------------------------------

create function store_ops.current_user_id() returns uuid
language sql stable
as $$ select nullif(current_setting('store_ops.user_id', true), '')::uuid $$;

create function store_ops.current_store_id() returns uuid
language sql stable
as $$ select nullif(current_setting('store_ops.store_id', true), '')::uuid $$;

-- Tables ----------------------------------------------------------------------------------

create table store_ops.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  currency char(3) not null default 'USD',
  is_demo boolean not null default true,
  created_at timestamptz not null default now()
);

create table store_ops.store_members (
  store_id uuid not null references store_ops.stores (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create index store_members_user_idx on store_ops.store_members (user_id);

-- Membership check used by policies. Security definer so it can read store_members without
-- recursing through that table's own policy.
create function store_ops.is_member(p_store_id uuid) returns boolean
language sql stable security definer
set search_path = store_ops, pg_temp
as $$
  select exists (
    select 1 from store_ops.store_members m
    where m.store_id = p_store_id and m.user_id = store_ops.current_user_id()
  )
$$;

create function store_ops.in_current_store(p_store_id uuid) returns boolean
language sql stable
as $$ select p_store_id = store_ops.current_store_id() and store_ops.is_member(p_store_id) $$;

create table store_ops.customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references store_ops.stores (id) on delete cascade,
  name text not null,
  email text not null,
  created_at timestamptz not null default now(),
  unique (id, store_id),
  unique (store_id, email)
);

create table store_ops.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references store_ops.stores (id) on delete cascade,
  sku text not null,
  name text not null,
  category text not null,
  price_cents integer not null check (price_cents >= 0),
  stock_on_hand integer not null check (stock_on_hand >= 0),
  low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, store_id),
  unique (store_id, sku)
);

create table store_ops.orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references store_ops.stores (id) on delete cascade,
  order_number integer not null check (order_number > 0),
  customer_id uuid not null,
  status text not null check (
    status in ('pending', 'paid', 'fulfilled', 'cancelled', 'partially_refunded', 'refunded')
  ),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  shipping_cents integer not null check (shipping_cents >= 0),
  tax_cents integer not null check (tax_cents >= 0),
  total_cents integer not null check (total_cents = subtotal_cents + shipping_cents + tax_cents),
  payment_method text,
  payment_reference text,
  placed_at timestamptz not null,
  paid_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (id, store_id),
  unique (store_id, order_number),
  foreign key (customer_id, store_id) references store_ops.customers (id, store_id)
);

create index orders_store_placed_idx on store_ops.orders (store_id, placed_at desc, order_number desc);

create table store_ops.order_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  sku text not null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  line_total_cents integer not null check (line_total_cents = quantity * unit_price_cents),
  foreign key (order_id, store_id) references store_ops.orders (id, store_id) on delete cascade,
  foreign key (product_id, store_id) references store_ops.products (id, store_id)
);

create index order_items_order_idx on store_ops.order_items (order_id);

create table store_ops.order_notes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  order_id uuid not null,
  author text not null check (author in ('customer', 'staff', 'system')),
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  foreign key (order_id, store_id) references store_ops.orders (id, store_id) on delete cascade
);

create index order_notes_order_idx on store_ops.order_notes (order_id);

create table store_ops.approvals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references store_ops.stores (id) on delete cascade,
  user_id uuid not null,
  tool text not null,
  args_hash text not null,
  summary jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'rejected', 'executed', 'expired')
  ),
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  executed_at timestamptz,
  unique (id, store_id)
);

create table store_ops.refunds (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  order_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  reason text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_refund_id text,
  approval_id uuid,
  created_at timestamptz not null default now(),
  foreign key (order_id, store_id) references store_ops.orders (id, store_id) on delete cascade,
  foreign key (approval_id, store_id) references store_ops.approvals (id, store_id)
);

create index refunds_order_idx on store_ops.refunds (order_id);

create table store_ops.audit_log (
  id bigint generated always as identity primary key,
  store_id uuid not null references store_ops.stores (id),
  user_id uuid not null,
  tool text not null,
  approval_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_store_idx on store_ops.audit_log (store_id, created_at desc);

-- audit_log is append-only for everyone, including the owner.
create function store_ops.reject_audit_change() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

create trigger audit_log_no_update_delete
before update or delete on store_ops.audit_log
for each row execute function store_ops.reject_audit_change();

create trigger audit_log_no_truncate
before truncate on store_ops.audit_log
for each statement execute function store_ops.reject_audit_change();

-- Store creation for a signed-in user (used to provision each user's demo store).
-- Security definer because the app role has no INSERT on stores or store_members.
create function store_ops.create_store(p_name text) returns uuid
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
  insert into store_ops.stores (name) values (p_name) returning id into v_store;
  insert into store_ops.store_members (store_id, user_id, role) values (v_store, v_user, 'owner');
  return v_store;
end
$$;

-- Row level security ----------------------------------------------------------------------

alter table store_ops.stores enable row level security;
alter table store_ops.store_members enable row level security;
alter table store_ops.customers enable row level security;
alter table store_ops.products enable row level security;
alter table store_ops.orders enable row level security;
alter table store_ops.order_items enable row level security;
alter table store_ops.order_notes enable row level security;
alter table store_ops.approvals enable row level security;
alter table store_ops.refunds enable row level security;
alter table store_ops.audit_log enable row level security;

alter table store_ops.stores force row level security;
alter table store_ops.store_members force row level security;
alter table store_ops.customers force row level security;
alter table store_ops.products force row level security;
alter table store_ops.orders force row level security;
alter table store_ops.order_items force row level security;
alter table store_ops.order_notes force row level security;
alter table store_ops.approvals force row level security;
alter table store_ops.refunds force row level security;
alter table store_ops.audit_log force row level security;

create policy stores_select on store_ops.stores for select to store_ops_app
  using (store_ops.in_current_store(id));

-- A user sees their own memberships (needed to resolve which store to open).
create policy store_members_select on store_ops.store_members for select to store_ops_app
  using (user_id = store_ops.current_user_id());

create policy customers_select on store_ops.customers for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy customers_insert on store_ops.customers for insert to store_ops_app
  with check (store_ops.in_current_store(store_id));
create policy customers_update on store_ops.customers for update to store_ops_app
  using (store_ops.in_current_store(store_id)) with check (store_ops.in_current_store(store_id));

create policy products_select on store_ops.products for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy products_insert on store_ops.products for insert to store_ops_app
  with check (store_ops.in_current_store(store_id));
create policy products_update on store_ops.products for update to store_ops_app
  using (store_ops.in_current_store(store_id)) with check (store_ops.in_current_store(store_id));

create policy orders_select on store_ops.orders for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy orders_insert on store_ops.orders for insert to store_ops_app
  with check (store_ops.in_current_store(store_id));
create policy orders_update on store_ops.orders for update to store_ops_app
  using (store_ops.in_current_store(store_id)) with check (store_ops.in_current_store(store_id));

create policy order_items_select on store_ops.order_items for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy order_items_insert on store_ops.order_items for insert to store_ops_app
  with check (store_ops.in_current_store(store_id));

create policy order_notes_select on store_ops.order_notes for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy order_notes_insert on store_ops.order_notes for insert to store_ops_app
  with check (store_ops.in_current_store(store_id));

-- Approvals are bound to the user who prepared them, not only to the store.
create policy approvals_select on store_ops.approvals for select to store_ops_app
  using (store_ops.in_current_store(store_id) and user_id = store_ops.current_user_id());
create policy approvals_insert on store_ops.approvals for insert to store_ops_app
  with check (store_ops.in_current_store(store_id) and user_id = store_ops.current_user_id());
create policy approvals_update on store_ops.approvals for update to store_ops_app
  using (store_ops.in_current_store(store_id) and user_id = store_ops.current_user_id())
  with check (store_ops.in_current_store(store_id) and user_id = store_ops.current_user_id());

create policy refunds_select on store_ops.refunds for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy refunds_insert on store_ops.refunds for insert to store_ops_app
  with check (store_ops.in_current_store(store_id));
create policy refunds_update on store_ops.refunds for update to store_ops_app
  using (store_ops.in_current_store(store_id)) with check (store_ops.in_current_store(store_id));

create policy audit_log_select on store_ops.audit_log for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy audit_log_insert on store_ops.audit_log for insert to store_ops_app
  with check (store_ops.in_current_store(store_id) and user_id = store_ops.current_user_id());

-- Privileges ------------------------------------------------------------------------------
-- Least privilege: no DELETE or TRUNCATE anywhere, no UPDATE on append-only tables.

revoke all on all tables in schema store_ops from public;
revoke all on all functions in schema store_ops from public;

grant select on store_ops.stores, store_ops.store_members to store_ops_app;
grant select, insert, update on store_ops.customers, store_ops.products, store_ops.orders,
  store_ops.approvals, store_ops.refunds to store_ops_app;
grant select, insert on store_ops.order_items, store_ops.order_notes, store_ops.audit_log
  to store_ops_app;

grant execute on function store_ops.current_user_id(), store_ops.current_store_id(),
  store_ops.is_member(uuid), store_ops.in_current_store(uuid), store_ops.create_store(text)
  to store_ops_app;
