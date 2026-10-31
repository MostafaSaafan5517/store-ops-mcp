import { OAuthError, OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { PRODUCT_NAME } from '../config.js';
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
}

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
  const providers = new Map<string, OAuthProvider<Env>>();

  function provider(env: Env): OAuthProvider<Env> {
    const config = readRemoteConfig(env, deps);
    const existing = providers.get(config.baseUrl);
    if (existing) return existing;

    const pageContext = (request: Request, oauth: OAuthHelpers): PageContext => ({
      request,
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
      const context = pageContext(request, oauth);
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

    const created = new OAuthProvider<Env>({
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
          throw new OAuthError('invalid_grant', { description: 'The demo session ended.' });
        }
      },
      // Token endpoint and 401 errors are normal client traffic; nothing to report.
      onError: () => undefined,
    });
    providers.set(config.baseUrl, created);
    return created;
  }

  return {
    fetch: (request, env, ctx) => provider(env).fetch(request, env, ctx),
  };
}
