import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./tests/support/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Postgres suites need Docker; they run with `pnpm test:pg` (vitest.pg.config.ts).
    exclude: ['tests/pg/**', 'node_modules/**'],
    setupFiles: ['tests/support/workers-runtime.ts'],
    // Bundle the OAuth provider through Vite so the `cloudflare:workers` alias applies to it.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
