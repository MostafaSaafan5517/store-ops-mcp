import {
  getOAuthApi,
  OAuthError,
  OAuthProvider,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { PRODUCT_NAME } from '../config.js';
import { purgeExpiredDemoStores } from '../maintenance.js';
import { decideApproval, showApproval } from './approval-routes.js';
import {
  demoLogin,
  githubCallback,
  githubLogin,
  showAuthorize,
  submitAuthorize,
  type TokenProps,
} from './auth-routes.js';
import { readRemoteConfig, type PageContext, type RemoteDeps, type RemoteEnv } from './config.js';
import { escapeHtml, htmlResponse } from './html.js';
import { serveMcp, type McpContext } from './mcp-endpoint.js';
import { messageBody } from './pages.js';
import { SCOPES } from './scopes.js';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export interface RemoteApp<Env extends RemoteEnv> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  /** Wipes expired demo stores and sweeps expired OAuth data. */
  cleanUp(env: Env): Promise<CleanupReport>;
  /** The Cron Trigger (wrangler.jsonc `triggers.crons`): runs `cleanUp`. */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

/** What one cleanup run did. */
export interface CleanupReport {
  storesWiped: number;
  grantsRevoked: number;
  /** Users of wiped stores whose grants were not revoked (budget reached or a KV error). */
  usersNotRevoked: number;
  /** Null when the provider's sweep failed (reported to onError). */
  oauthPurge: { grantsPurged: number; tokensPurged: number; done: boolean } | null;
}

/**
 * Per cron run, to stay well inside the Workers limits on subrequests and KV operations per
 * invocation: one OAuth sweep batch, up to 10 wiped stores and up to 25 revoked grants (each
 * revocation takes a few KV calls). Grants left over are harmless: their tokens and refreshes
 * already fail for an expired demo, and the provider's sweep removes them once expired.
 */
export const OAUTH_PURGE_BATCH = 50;
export const CRON_STORE_BATCH = 10;
export const CRON_GRANT_BUDGET = 25;
/** KV key holding where the OAuth provider's purge sweep stopped (its documented pattern). */
export const OAUTH_PURGE_CURSOR_KEY = 'store-ops:oauth-purge-cursor';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function homePage(baseUrl: string): Response {
  const mcpUrl = `${baseUrl}/mcp`;
  return htmlResponse(
    PRODUCT_NAME,
    `<h1>${escapeHtml(PRODUCT_NAME)}</h1>
<p>An MCP server for a small online store, running on generated demo data.</p>
<p>Add it to Claude, ChatGPT or another MCP client as a custom connector with this URL:</p>
<p class="box"><strong>${escapeHtml(mcpUrl)}</strong></p>
<p>You sign in with GitHub or with a throwaway demo account. Every user gets their own Demo Store. Changes (stock, cancellations, notes, refunds) only run after you approve them on this site.</p>`,
  );
}

/**
 * The remote server: OAuth authorization server (via `@cloudflare/workers-oauth-provider`),
 * the protected MCP endpoint at `/mcp`, sign-in, consent and the approval page. Runtime
 * specifics (database, outbound fetch, clock) come from `deps`, so tests run the same app.
 */
export function createRemoteApp<Env extends RemoteEnv>(deps: RemoteDeps<Env>): RemoteApp<Env> {
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => undefined);
  const providers = new Map<
    string,
    { provider: OAuthProvider<Env>; options: OAuthProviderOptions<Env> }
  >();

  function setup(env: Env): { provider: OAuthProvider<Env>; options: OAuthProviderOptions<Env> } {
    const config = readRemoteConfig(env, deps);
    const existing = providers.get(config.baseUrl);
    if (existing) return existing;

    const pageContext = (request: Request, env: Env, oauth: OAuthHelpers): PageContext => ({
      request,
      env,
      url: new URL(request.url),
      oauth,
      config,
      db: deps.database(env),
      now: now(),
      onError,
    });

    async function pages(request: Request, pageEnv: Env): Promise<Response> {
      const url = new URL(request.url);
      const oauth = pageEnv.OAUTH_PROVIDER;
      if (!oauth) throw new Error('OAUTH_PROVIDER is missing');
      const context = pageContext(request, pageEnv, oauth);
      const method = request.method;
      const approval = /^\/approve\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === '/' && method === 'GET') return homePage(config.baseUrl);
      if (url.pathname === '/authorize' && method === 'GET') return showAuthorize(context);
      if (url.pathname === '/authorize' && method === 'POST') return submitAuthorize(context);
      if (url.pathname === '/login/demo' && method === 'POST') return demoLogin(context);
      if (url.pathname === '/login/github' && method === 'POST') return githubLogin(context);
      if (url.pathname === '/login/github/callback' && method === 'GET') {
        return githubCallback(context);
      }
      if (approval?.[1] !== undefined) {
        // A malformed escape reads as an id that matches nothing: the same not-found page.
        const approvalId = safeDecode(approval[1]);
        if (method === 'GET') return showApproval(context, approvalId);
        if (method === 'POST') return decideApproval(context, approvalId);
      }
      return htmlResponse('Not found', messageBody('Not found', 'There is no page here.'), {
        status: 404,
      });
    }

    const options: OAuthProviderOptions<Env> = {
      apiRoute: '/mcp',
      apiHandler: {
        fetch: (request: Request, apiEnv: Env, ctx: McpContext) =>
          serveMcp(request, {
            env: apiEnv,
            context: ctx,
            config,
            db: deps.database(apiEnv),
            now,
            onError,
          }),
      },
      defaultHandler: {
        fetch: async (request: Request, pageEnv: Env) => {
          try {
            return await pages(request, pageEnv);
          } catch (error) {
            onError(error);
            const title = 'Something went wrong';
            return htmlResponse(title, messageBody(title, 'Please try again.'), { status: 500 });
          }
        },
      },
      authorizeEndpoint: `${config.baseUrl}/authorize`,
      tokenEndpoint: `${config.baseUrl}/token`,
      clientRegistrationEndpoint: `${config.baseUrl}/register`,
      scopesSupported: [...SCOPES],
      resourceMetadata: {
        resource: config.resource,
        authorization_servers: [config.baseUrl],
        resource_name: PRODUCT_NAME,
      },
      // Every scope, so a client's first sign-in asks for all of them. With only store:read here,
      // Claude requested a read-only token and then reported write tools as "Forbidden" instead
      // of stepping up (found on the live server, 2026-11-02). Advertised, not enforced: the
      // consent page still shows the scopes, every write still needs a human approval, and the
      // per-tool 403 step-up stays for clients that ask for less.
      requiredScopes: [...SCOPES],
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
      // Demo users end after 24 hours: their grants stop refreshing then.
      tokenExchangeCallback: ({ props }: { props: unknown }) => {
        const demoExpiresAt = (props as Partial<TokenProps> | undefined)?.demoExpiresAt;
        if (typeof demoExpiresAt === 'number' && demoExpiresAt <= now().getTime()) {
          throw new OAuthError('invalid_grant', {
            description: 'The demo expired. Connect again to start a new demo.',
          });
        }
      },
      // Token endpoint and 401 errors are normal client traffic; nothing to report.
      onError: () => undefined,
    };
    const created = { provider: new OAuthProvider<Env>(options), options };
    providers.set(config.baseUrl, created);
    return created;
  }

  /** Revokes a user's OAuth grants, at most `budget`. Returns how many, and if all are gone. */
  async function revokeGrants(
    oauth: OAuthHelpers,
    userId: string,
    budget: number,
  ): Promise<{ revoked: number; complete: boolean }> {
    const page = await oauth.listUserGrants(userId, { limit: budget + 1 });
    const grants = page.items.slice(0, budget);
    for (const grant of grants) await oauth.revokeGrant(grant.id, userId);
    return {
      revoked: grants.length,
      complete: page.items.length <= budget && page.cursor === undefined,
    };
  }

  /** One batch of the provider's own sweep, resuming from its cursor in KV. */
  async function sweepOAuth(env: Env, provider: OAuthProvider<Env>) {
    const cursor = (await env.OAUTH_KV.get(OAUTH_PURGE_CURSOR_KEY)) ?? undefined;
    const result = await provider.purgeExpiredData(env, {
      batchSize: OAUTH_PURGE_BATCH,
      ...(cursor ? { cursor } : {}),
    });
    if (result.cursor) await env.OAUTH_KV.put(OAUTH_PURGE_CURSOR_KEY, result.cursor);
    else await env.OAUTH_KV.delete(OAUTH_PURGE_CURSOR_KEY);
    return {
      grantsPurged: result.grantsPurged,
      tokensPurged: result.tokensPurged,
      done: result.done,
    };
  }

  /**
   * One batch of the provider's `purgeExpiredData` sweep (first, so it never waits on the
   * rest), then wipes expired demo stores (audit_log stays) and revokes their users' grants
   * within a fixed budget.
   */
  async function cleanUp(env: Env): Promise<CleanupReport> {
    const { provider, options } = setup(env);
    let oauthPurge: CleanupReport['oauthPurge'] = null;
    try {
      oauthPurge = await sweepOAuth(env, provider);
    } catch (error) {
      onError(error);
    }
    const purged = await purgeExpiredDemoStores(deps.database(env), CRON_STORE_BATCH);
    const oauth = getOAuthApi(options, env);
    const userIds = purged.flatMap((store) => store.userIds);
    let grantsRevoked = 0;
    let usersNotRevoked = 0;
    for (const userId of userIds) {
      const budget = CRON_GRANT_BUDGET - grantsRevoked;
      if (budget <= 0) {
        usersNotRevoked += 1;
        continue;
      }
      try {
        const result = await revokeGrants(oauth, userId, budget);
        grantsRevoked += result.revoked;
        if (!result.complete) usersNotRevoked += 1;
      } catch (error) {
        // The store is already wiped and the tokens fail; report and go on.
        onError(error);
        usersNotRevoked += 1;
      }
    }
    return { storesWiped: purged.length, grantsRevoked, usersNotRevoked, oauthPurge };
  }

  return {
    fetch: (request, env, ctx) => setup(env).provider.fetch(request, env, ctx),
    cleanUp,
    // A failure rejects, so Cloudflare records the cron run as failed.
    async scheduled(_controller, env) {
      deps.onCleanup?.(await cleanUp(env));
    },
  };
}
