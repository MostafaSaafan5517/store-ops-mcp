import { isUuid } from './db/principal.js';

/** Fixed id for the local demo user when STORE_OPS_USER_ID is not set. */
export const DEFAULT_LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';

export const DEFAULT_DATA_DIR = '.data/pglite';

/** Where the approval page will run locally (`wrangler dev` default port, Run 3). */
export const DEFAULT_APPROVAL_BASE_URL = 'http://localhost:8787';

export interface LocalEnv {
  userId: string;
  /** PGlite data directory, or `memory://` for a throwaway in-memory store. */
  dataDir: string;
  /** Base URL for approval links (`<base>/approve/<id>`). */
  approvalBaseUrl: string;
}

/**
 * Local (stdio) credentials come from the environment, as the MCP spec asks of stdio
 * servers. There is no real secret here: the user id only selects which demo store opens.
 */
export function readLocalEnv(env: Record<string, string | undefined>): LocalEnv {
  const userId = env.STORE_OPS_USER_ID?.trim() || DEFAULT_LOCAL_USER_ID;
  if (!isUuid(userId)) {
    throw new Error('STORE_OPS_USER_ID must be a UUID');
  }
  const dataDir = env.STORE_OPS_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  const approvalBaseUrl = env.STORE_OPS_APPROVAL_BASE_URL?.trim() || DEFAULT_APPROVAL_BASE_URL;
  if (!URL.canParse(approvalBaseUrl)) {
    throw new Error('STORE_OPS_APPROVAL_BASE_URL must be an absolute URL');
  }
  return { userId, dataDir, approvalBaseUrl };
}
