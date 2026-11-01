import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { KVNamespace, RateLimit } from '@cloudflare/workers-types';
import type { Database } from '../db/types.js';
import type { CleanupReport } from './app.js';
import { GITHUB_ENDPOINTS, type GithubApp, type GithubEndpoints } from './github.js';
import { Csrf, Signer } from './session.js';

/** Bindings, vars and secrets of the Worker (see wrangler.jsonc and .dev.vars.example). */
export interface RemoteEnv {
  OAUTH_KV: KVNamespace;
  /** Public origin of this Worker, for example https://store-ops-mcp.example.workers.dev. */
  PUBLIC_BASE_URL: string;
  /** At least 32 random characters. Signs session and CSRF cookies. */
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  /** Rate Limiting binding for "Try the demo", keyed per client address (wrangler.jsonc). */
  DEMO_LOGIN_LIMITER: RateLimit;
  /** Most new demo users (and so demo stores) per UTC day, across all clients. */
  DEMO_DAILY_CAP: string;
  /** Set by the OAuth provider for the non-API handler. */
  OAUTH_PROVIDER?: OAuthHelpers;
}

/** What the Worker entry (or a test) plugs in. */
export interface RemoteDeps<Env extends RemoteEnv = RemoteEnv> {
  database(env: Env): Database;
  /** Used for GitHub calls only. Tests pass a fake; nothing in tests reaches GitHub. */
  fetch?: typeof fetch;
  githubEndpoints?: GithubEndpoints;
  now?: () => Date;
  /** Unexpected errors. Clients only ever see a generic message. */
  onError?: (error: unknown) => void;
  /** Receives what each scheduled cleanup did. */
  onCleanup?: (report: CleanupReport) => void;
}

export interface RemoteConfig {
  /** The origin, without a trailing slash. Also the OAuth issuer. */
  baseUrl: string;
  /** The MCP endpoint and the token audience: `<baseUrl>/mcp`. */
  resource: string;
  signer: Signer;
  csrf: Csrf;
  github: GithubApp | undefined;
  demoDailyCap: number;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Reads and checks the Worker settings. Throws (a 500) when the deployment is misconfigured. */
export function readRemoteConfig(
  env: RemoteEnv,
  deps: Pick<RemoteDeps, 'fetch' | 'githubEndpoints'>,
): RemoteConfig {
  const raw = env.PUBLIC_BASE_URL?.trim() ?? '';
  if (!URL.canParse(raw)) throw new Error('PUBLIC_BASE_URL must be an absolute URL');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('PUBLIC_BASE_URL must use https (http is allowed only on localhost)');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL must be an origin with no path');
  }
  const baseUrl = url.origin;
  const signer = new Signer(env.SESSION_SECRET ?? '');
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('Set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither');
  }
  const cap = env.DEMO_DAILY_CAP?.trim() ?? '';
  if (!/^\d{1,6}$/.test(cap)) throw new Error('DEMO_DAILY_CAP must be a whole number');
  return {
    baseUrl,
    demoDailyCap: Number(cap),
    resource: `${baseUrl}/mcp`,
    signer,
    csrf: new Csrf(signer, baseUrl),
    github:
      clientId && clientSecret
        ? {
            clientId,
            clientSecret,
            endpoints: deps.githubEndpoints ?? GITHUB_ENDPOINTS,
            fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
          }
        : undefined,
  };
}

/** Everything one page request needs. */
export interface PageContext {
  request: Request;
  env: RemoteEnv;
  url: URL;
  oauth: OAuthHelpers;
  config: RemoteConfig;
  db: Database;
  now: Date;
  onError: (error: unknown) => void;
}
