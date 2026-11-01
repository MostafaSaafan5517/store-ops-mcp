import type { Hyperdrive } from '@cloudflare/workers-types';
import { createPostgresDatabase, hyperdriveConnector } from './db/postgres.js';
import { createRemoteApp } from './remote/app.js';
import type { RemoteEnv } from './remote/config.js';

/** The Worker's bindings: everything in RemoteEnv plus the Hyperdrive connection to Neon. */
export interface WorkerEnv extends RemoteEnv {
  HYPERDRIVE: Hyperdrive;
}

export default createRemoteApp<WorkerEnv>({
  database: (env) => createPostgresDatabase(hyperdriveConnector(env.HYPERDRIVE.connectionString)),
  onError: (error) => {
    // Workers Logs collect console output; this file is the only place the Worker logs.
    // eslint-disable-next-line no-console
    console.error('[store-ops-mcp]', error instanceof Error ? error.message : String(error));
  },
  onCleanup: (report) => {
    // eslint-disable-next-line no-console
    console.log('[store-ops-mcp] cleanup', JSON.stringify(report));
  },
});
