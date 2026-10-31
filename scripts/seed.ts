import { openLocalDatabase } from '../src/db/pglite.js';
import { withPrincipal } from '../src/db/principal.js';
import { readLocalEnv } from '../src/local-env.js';
import { ensureDemoStore } from '../src/seed/provision.js';

const env = readLocalEnv(process.env);
const local = await openLocalDatabase(env.dataDir);
try {
  const { principal, created } = await ensureDemoStore(local.app, env.userId);
  const counts = await withPrincipal(local.app, principal, async (tx) => {
    const { rows } = await tx.query<{ products: number; orders: number; customers: number }>(
      `select (select count(*)::int from store_ops.products) as products,
              (select count(*)::int from store_ops.orders) as orders,
              (select count(*)::int from store_ops.customers) as customers`,
    );
    return rows[0];
  });
  process.stdout.write(
    `${created ? 'Created' : 'Found existing'} Demo Store ${principal.storeId} for user ${principal.userId} in ${env.dataDir}\n` +
      `${JSON.stringify(counts)}\n`,
  );
} finally {
  await local.close();
}
