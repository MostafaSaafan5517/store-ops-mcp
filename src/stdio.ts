import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { PRODUCT_NAME } from './config.js';
import { openLocalDatabase } from './db/pglite.js';
import { readLocalEnv } from './local-env.js';
import { selectPayments } from './payments/select.js';
import { ensureDemoStore } from './seed/provision.js';
import { createStoreOpsServer } from './server.js';

// stdout carries the protocol, so all diagnostics go to stderr.
const log = (message: string) => process.stderr.write(`[${PRODUCT_NAME}] ${message}\n`);

const env = readLocalEnv(process.env);
const payments = selectPayments(process.env);
const local = await openLocalDatabase(env.dataDir);
const { principal, created } = await ensureDemoStore(local.app, env.userId);
log(
  `${created ? 'Created' : 'Opened'} Demo Store ${principal.storeId} for user ${principal.userId} (${env.dataDir}), refunds via ${payments.processor}`,
);

const handle = serveStdio(
  () =>
    createStoreOpsServer({
      db: local.app,
      principal,
      payments,
      approvalBaseUrl: env.approvalBaseUrl,
      onError: (error) =>
        log(`Tool error: ${error instanceof Error ? error.message : String(error)}`),
    }),
  { onerror: (error) => log(`Transport error: ${error.message}`) },
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await handle.close();
  await local.close();
}

process.stdin.once('end', () => void shutdown());
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
