import { Client } from 'pg';
import { migrate, pgMigrationClient } from '../../src/db/migrate.js';
import { ADMIN_URL, databaseUrl, LOGIN_ROLE, OWNER_ROLE, TEMPLATE_DB } from './postgres.js';

function redacted(url: string): string {
  const parsed = new URL(url);
  parsed.password = '***';
  return parsed.toString();
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  return client;
}

/**
 * Creates the owner and login roles, then a template database migrated by the owner (a
 * normal role, like a hosted Postgres owner). Each test file clones the template.
 */
export default async function setup(): Promise<void> {
  let admin: Client;
  try {
    admin = await connect(ADMIN_URL);
  } catch (error) {
    const unreachable = new Error(
      `pnpm test:pg needs Postgres at ${redacted(ADMIN_URL)}, but it is not reachable ` +
        `(${error instanceof Error ? error.message : String(error)}). Start it with ` +
        '"pnpm db:up" (Docker), or set STORE_OPS_PG_ADMIN_URL to a superuser URL.',
    );
    // Vitest 5 fails while source-mapping a global setup stack ("code.charCodeAt is not a
    // function") and hides the message, so the stack is set to the message itself.
    unreachable.stack = unreachable.message;
    throw unreachable;
  }
  try {
    await admin.query(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${OWNER_ROLE.user}') then
          create role ${OWNER_ROLE.user} login createdb createrole nosuperuser nobypassrls
            password '${OWNER_ROLE.password}';
        end if;
        if not exists (select 1 from pg_roles where rolname = '${LOGIN_ROLE.user}') then
          create role ${LOGIN_ROLE.user} login nosuperuser nobypassrls nocreatedb nocreaterole
            password '${LOGIN_ROLE.password}';
        end if;
      end
      $$`);
    await admin.query(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await admin.query(`create database ${TEMPLATE_DB} owner ${OWNER_ROLE.user}`);
  } finally {
    await admin.end();
  }

  const owner = await connect(databaseUrl(TEMPLATE_DB, OWNER_ROLE));
  try {
    await migrate(pgMigrationClient(owner));
    // The owner created store_ops_app in the first migration, so it may grant it.
    await owner.query(`grant store_ops_app to ${LOGIN_ROLE.user}`);
  } finally {
    await owner.end();
  }
}
