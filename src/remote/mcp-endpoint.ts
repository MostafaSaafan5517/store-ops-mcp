import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import {
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  readRequestBody,
} from '@modelcontextprotocol/server';
import { isUuid } from '../db/principal.js';
import type { Database, Principal } from '../db/types.js';
import { selectPayments } from '../payments/select.js';
import { createStoreOpsServer } from '../server.js';
import type { TokenProps } from './auth-routes.js';
import type { RemoteConfig, RemoteEnv } from './config.js';
import { scopesForRequest } from './scopes.js';

/** What the OAuth provider hands the API handler after it validated the token. */
export interface McpContext {
  props: unknown;
  auth: OAuthResourceAuth;
}

function principalFrom(props: unknown): (Principal & { demoExpiresAt?: number }) | undefined {
  if (typeof props !== 'object' || props === null) return undefined;
  const { userId, storeId, demoExpiresAt } = props as Partial<TokenProps>;
  if (typeof userId !== 'string' || !isUuid(userId)) return undefined;
  if (typeof storeId !== 'string' || !isUuid(storeId)) return undefined;
  return {
    userId,
    storeId,
    ...(typeof demoExpiresAt === 'number' ? { demoExpiresAt } : {}),
  };
}

export function protectedResourceMetadataUrl(config: RemoteConfig): string {
  return `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`;
}

function invalidToken(config: RemoteConfig, description: string): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer error="invalid_token", error_description="${description}", resource_metadata="${protectedResourceMetadataUrl(config)}"`,
    },
  });
}

type Body = { kind: 'json'; body: unknown } | { kind: 'none' } | { kind: 'too-large' };

/** Reads the body once, with the same size cap the SDK uses, before the scope check. */
async function readJsonBody(request: Request): Promise<Body> {
  if (request.method !== 'POST') return { kind: 'none' };
  const read = await readRequestBody(request.clone(), DEFAULT_MAX_REQUEST_BODY_SIZE);
  if (read.tooLarge) return { kind: 'too-large' };
  try {
    return { kind: 'json', body: JSON.parse(read.text) as unknown };
  } catch {
    // Not JSON: let the SDK answer with its own parse error.
    return { kind: 'none' };
  }
}

/**
 * The MCP endpoint behind the OAuth provider. The store and user come only from the token's
 * props. Each call needs the scopes of the tool it names (from the body and the `Mcp-Name`
 * header), and a token without them gets one 403 challenge that lists every scope needed.
 */
export async function serveMcp(
  request: Request,
  input: {
    env: RemoteEnv;
    context: McpContext;
    config: RemoteConfig;
    db: Database;
    now: () => Date;
    onError: (error: unknown) => void;
  },
): Promise<Response> {
  const { auth } = input.context;
  const principal = principalFrom(input.context.props);
  if (!principal) {
    input.onError(new Error('token props do not hold a valid user and store'));
    return invalidToken(input.config, 'This token is not valid for any store.');
  }
  if (principal.demoExpiresAt !== undefined && principal.demoExpiresAt <= input.now().getTime()) {
    return invalidToken(input.config, 'The demo expired. Connect again to start a new demo.');
  }
  const read = await readJsonBody(request);
  if (read.kind === 'too-large') return new Response('Request body too large', { status: 413 });
  const body = read.kind === 'json' ? read.body : undefined;
  const needed = scopesForRequest(body, request.headers);
  if (!needed.every((scope) => auth.scope.includes(scope))) {
    return insufficientScope(auth, needed, `This request needs these scopes: ${needed.join(' ')}`);
  }

  const payments = selectPayments({ STRIPE_SECRET_KEY: input.env.STRIPE_SECRET_KEY });
  const handler = createMcpHandler(
    () =>
      createStoreOpsServer({
        db: input.db,
        principal: { userId: principal.userId, storeId: principal.storeId },
        payments,
        approvalBaseUrl: input.config.baseUrl,
        now: input.now,
        onError: input.onError,
      }),
    { onerror: input.onError },
  );
  return handler.fetch(request, {
    ...(read.kind === 'json' ? { parsedBody: body } : {}),
    authInfo: {
      token: auth.token,
      clientId: auth.clientId ?? '',
      scopes: auth.scope,
      resource: new URL(auth.audience),
      ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
    },
  });
}
