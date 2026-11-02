import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * `pnpm test:pg`: the database suites again, on real Postgres through the Hyperdrive adapter,
 * plus the Postgres-only suites in tests/pg (roles, locks). Needs `pnpm db:up`.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'tests/pg/**/*.test.ts',
      'tests/rls.test.ts',
      'tests/demo-expiry.test.ts',
      'tests/users.test.ts',
      'tests/seed.test.ts',
      'tests/read-tools.test.ts',
      'tests/sales-summary.test.ts',
      'tests/tool-schemas.test.ts',
      'tests/write-tools.test.ts',
      'tests/dashboard.test.ts',
      'tests/remote-*.test.ts',
    ],
    exclude: ['node_modules/**'],
    env: { STORE_OPS_TEST_DB: 'postgres' },
    globalSetup: ['tests/support/pg-global-setup.ts'],
  },
});
