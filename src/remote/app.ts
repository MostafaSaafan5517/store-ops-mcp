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
import { BASELINE_SCOPE, SCOPES } from './scopes.js';

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
  oauthPurge: { grantsPurged: number; tokensPurged: number; done: boolean };
}

/** Demo stores wiped per cron run. Each one also costs a few KV calls to revoke grants. */
export const CRON_STORE_BATCH = 20;
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
      requiredScopes: [BASELINE_SCOPE],
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

  /** Revokes every OAuth grant of a user. Their tokens already fail; this frees KV. */
  async function revokeAllGrants(oauth: OAuthHelpers, userId: string): Promise<number> {
    let revoked = 0;
    let cursor: string | undefined;
    do {
      const page = await oauth.listUserGrants(userId, cursor ? { cursor } : {});
      for (const grant of page.items) {
        await oauth.revokeGrant(grant.id, userId);
        revoked += 1;
      }
      cursor = page.cursor;
    } while (cursor);
    return revoked;
  }

  /**
   * Wipes expired demo stores (audit_log stays), revokes their users' grants, then runs one
   * batch of the OAuth provider's own `purgeExpiredData` sweep, resuming from its cursor.
   */
  async function cleanUp(env: Env): Promise<CleanupReport> {
    const { provider, options } = setup(env);
    const purged = await purgeExpiredDemoStores(deps.database(env), CRON_STORE_BATCH);
    const oauth = getOAuthApi(options, env);
    let grantsRevoked = 0;
    for (const store of purged) {
      for (const userId of store.userIds) {
        try {
          grantsRevoked += await revokeAllGrants(oauth, userId);
        } catch (error) {
          // The store is already wiped and the tokens fail; report and go on.
          onError(error);
        }
      }
    }
    const cursor = (await env.OAUTH_KV.get(OAUTH_PURGE_CURSOR_KEY)) ?? undefined;
    const result = await provider.purgeExpiredData(env, cursor ? { cursor } : {});
    if (result.cursor) await env.OAUTH_KV.put(OAUTH_PURGE_CURSOR_KEY, result.cursor);
    else await env.OAUTH_KV.delete(OAUTH_PURGE_CURSOR_KEY);
    return {
      storesWiped: purged.length,
      grantsRevoked,
      oauthPurge: {
        grantsPurged: result.grantsPurged,
        tokensPurged: result.tokensPurged,
        done: result.done,
      },
    };
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
