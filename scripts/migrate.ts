import { Client } from 'pg';
import { migrate, pgMigrationClient } from '../src/db/migrate.js';

// Usage: STORE_OPS_MIGRATE_URL=postgres://<owner>@<host>/<db> pnpm db:migrate
// Connect as the role that owns the schema (on Neon, the project owner role), never as the
// app's login role. Prints the migrations it applied.
const url = process.env.STORE_OPS_MIGRATE_URL;
if (!url) {
  process.stderr.write('Set STORE_OPS_MIGRATE_URL to a Postgres URL for the schema owner role.\n');
  process.exit(1);
}

const owner = new Client({ connectionString: url });
await owner.connect();
try {
  const applied = await migrate(pgMigrationClient(owner));
  process.stdout.write(
    applied.length === 0 ? 'Nothing to apply.\n' : `Applied ${applied.join(', ')}\n`,
  );
} finally {
  await owner.end();
}
