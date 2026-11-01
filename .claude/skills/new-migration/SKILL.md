---
name: new-migration
description: Create the next numbered SQL migration in migrations/ with the Store Ops RLS pattern, grants to store_ops_app only, and a matching RLS test case.
argument-hint: <short_snake_case_name> <what the migration adds>
disable-model-invocation: true
---

# New migration

Create a new migration for: $ARGUMENTS

## Rules

- Never edit a migration that git already tracks (`git ls-files migrations/`). The guard hook
  blocks it. Every change is a new file.
- Plain SQL, applied in file name order by `src/db/migrate.ts`. No down migrations.
- Everything lives in the `store_ops` schema, never `public`.
- Money columns are integer cents named `*_cents`.
- Customer emails in any seed or test data use `example.com`.
- No em dashes anywhere.

## Steps

1. Run `git ls-files migrations/` and take the highest number. The new file is
   `migrations/<next 4-digit number>_<short_snake_case_name>.sql`.
2. Start the file with a two or three line comment saying what it adds and why.
3. For each new tenant table, copy this pattern from `migrations/0001_schema.sql` exactly:

```sql
create table store_ops.<table> (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references store_ops.stores (id) on delete cascade,
  -- columns; money as <name>_cents integer not null check (<name>_cents >= 0)
  created_at timestamptz not null default now(),
  unique (id, store_id)
);

-- A child of another tenant table references it together with store_id, so a row can never
-- point at another store's parent:
--   foreign key (<parent>_id, store_id) references store_ops.<parents> (id, store_id)

alter table store_ops.<table> enable row level security;
alter table store_ops.<table> force row level security;

create policy <table>_select on store_ops.<table> for select to store_ops_app
  using (store_ops.in_current_store(store_id));
create policy <table>_insert on store_ops.<table> for insert to store_ops_app
  with check (store_ops.in_current_store(store_id));
-- Only if rows may change:
create policy <table>_update on store_ops.<table> for update to store_ops_app
  using (store_ops.in_current_store(store_id)) with check (store_ops.in_current_store(store_id));

revoke all on store_ops.<table> from public;
grant select, insert on store_ops.<table> to store_ops_app;
-- Add update only if the table is not append-only. Never grant delete or truncate.
```

4. If rows belong to one user (like `approvals`), add
   `and user_id = store_ops.current_user_id()` to every policy, as `approvals_*` does.
5. New functions: `revoke all on function ... from public`, then grant execute to
   `store_ops_app` only if the app calls it. Security definer functions must
   `set search_path = store_ops, pg_temp` and check `store_ops.current_user_id()`. Make
   `store_ops_definer` their owner and give that role only the grants and policies they need
   (see `0005_definer_role.sql` and the replace pattern in CLAUDE.md). PGlite runs as a
   superuser and will not show a missing policy; `pnpm test:pg` will.
6. Append-only tables get a trigger like `audit_log_no_update_delete` and
   `audit_log_no_truncate` in `0001_schema.sql`.

## Tests

1. Add the table to `STORE_TABLES` in `tests/rls.test.ts`, so the "RLS enabled and forced"
   test covers it.
2. Add a case in the "isolation between stores" block: store A cannot read a store B row by id,
   cannot insert a row with store B's `store_id`, and (if it has an update policy) cannot move
   its own row into store B. Use the helpers in `tests/helpers.ts` (`openTestDatabase`,
   `createEmptyStore`, `USER_A`, `USER_B`).
3. For append-only tables, add a case that UPDATE and DELETE are rejected.
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:pg` (after `pnpm db:up`).
   All must pass.
5. Suggest running the `store-ops-security-reviewer` subagent before committing.
