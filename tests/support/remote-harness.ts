import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { pkceChallenge } from '../../src/remote/github.js';
import { createRemoteApp, type RemoteApp } from '../../src/remote/app.js';
import type { RemoteEnv } from '../../src/remote/config.js';
import { randomToken } from '../../src/remote/session.js';
import { openTestDatabase, type TestDatabase } from '../helpers.js';
import { MemoryKV } from './memory-kv.js';

export const BASE_URL = 'https://store-ops.example.com';
export const MCP_URL = `${BASE_URL}/mcp`;
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const CIMD_CLIENT_ID = 'https://client.example.com/oauth/client.json';

/** A fake GitHub: the OAuth App endpoints and the user API, answered locally. */
export const FAKE_GITHUB = {
  authorize: 'https://github.test/login/oauth/authorize',
  token: 'https://github.test/login/oauth/access_token',
  user: 'https://api.github.test/user',
};

export interface GithubCall {
  url: string;
  body: string;
  authorization: string | null;
}

/** Stands in for the Rate Limiting binding: records keys, allows while `allow` is true. */
export class FakeRateLimiter {
  allow = true;
  readonly keys: string[] = [];

  limit(options: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(options.key);
    return Promise.resolve({ success: this.allow });
  }
}

export interface Harness {
  local: TestDatabase;
  limiter: FakeRateLimiter;
  kv: MemoryKV;
  env: RemoteEnv;
  app: RemoteApp<RemoteEnv>;
  errors: unknown[];
  githubCalls: GithubCall[];
  /** Calls the Worker app as the runtime would. */
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

/** Serves CIMD documents for test clients and fails every other outbound fetch loudly. */
export function stubOutboundFetch(documents: Record<string, unknown>): typeof fetch {
  return (input: string | URL | Request) => {
    const url = urlOf(input);
    const document = documents[url];
    if (document === undefined) {
      return Promise.reject(new Error(`unexpected outbound fetch in a test: ${url}`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(document), { headers: { 'Content-Type': 'application/json' } }),
    );
  };
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function bodyText(body: RequestInit['body']): string {
  if (typeof body === 'string') return body;
  return body instanceof URLSearchParams ? body.toString() : '';
}

export async function createHarness(
  options: {
    github?: boolean;
    githubUser?: { id: number; login: string };
    demoDailyCap?: number;
  } = {},
): Promise<Harness> {
  const local = await openTestDatabase();
  const limiter = new FakeRateLimiter();
  const kv = new MemoryKV();
  const errors: unknown[] = [];
  const githubCalls: GithubCall[] = [];
  const githubUser = options.githubUser ?? { id: 9001, login: 'demo-octocat' };
  const githubFetch: typeof fetch = (input, init) => {
    const url = urlOf(input);
    const headers = new Headers(init?.headers);
    const body = bodyText(init?.body);
    githubCalls.push({ url, body, authorization: headers.get('authorization') });
    if (url === FAKE_GITHUB.token) {
      if (new URLSearchParams(body).get('code') !== 'github-code-ok') {
        return Promise.resolve(Response.json({ error: 'bad_verification_code' }));
      }
      return Promise.resolve(
        Response.json({ access_token: 'gho_fake_token', token_type: 'bearer' }),
      );
    }
    if (url === FAKE_GITHUB.user && headers.get('authorization') === 'Bearer gho_fake_token') {
      return Promise.resolve(Response.json(githubUser));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
  const env: RemoteEnv = {
    OAUTH_KV: kv as unknown as RemoteEnv['OAUTH_KV'],
    PUBLIC_BASE_URL: BASE_URL,
    SESSION_SECRET: 'test-only-session-secret-0123456789abcdef',
    DEMO_LOGIN_LIMITER: limiter,
    DEMO_DAILY_CAP: String(options.demoDailyCap ?? 1000),
    ...(options.github === false
      ? {}
      : { GITHUB_CLIENT_ID: 'test-github-client', GITHUB_CLIENT_SECRET: 'test-github-secret' }),
  };
  const app = createRemoteApp<RemoteEnv>({
    database: () => local.app,
    fetch: githubFetch,
    githubEndpoints: FAKE_GITHUB,
    onError: (error) => errors.push(error),
  });
  return {
    local,
    limiter,
    kv,
    env,
    app,
    errors,
    githubCalls,
    fetch: (input, init) =>
      app.fetch(input instanceof Request ? input : new Request(input, init), env, ctx),
    close: () => local.close(),
  };
}

let nextAddress = 1;

/** A distinct documentation address (198.18.0.0/15) for each test browser. */
function testAddress(): string {
  const n = nextAddress++;
  return `198.18.${Math.floor(n / 256) % 256}.${n % 256}`;
}

/**
 * A browser: keeps cookies per name, never follows redirects, and sends its own
 * CF-Connecting-IP like Cloudflare does, so per-client limits see one client per browser.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly address = testAddress();

  constructor(private readonly harness: Harness) {}

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('cf-connecting-ip')) headers.set('CF-Connecting-IP', this.address);
    if (this.cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    const response = await this.harness.fetch(new URL(url, BASE_URL).toString(), {
      ...init,
      headers,
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const removed = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (removed || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  /** Posts a form like a browser on our own site (Origin header included). */
  post(url: string, fields: Record<string, string>, origin = BASE_URL): Promise<Response> {
    return this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

export function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match?.[1]) throw new Error(`no ${name} field in page`);
  return match[1].replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

export async function registerClient(
  harness: Harness,
  redirectUris: string[],
  name = 'Test DCR Client',
): Promise<string> {
  const response = await harness.fetch(`${BASE_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (response.status !== 201) {
    throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  verifier: string;
  state: string;
}

export async function authorizeUrl(request: AuthorizeRequest): Promise<string> {
  const url = new URL(`${BASE_URL}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', request.scope);
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge', await pkceChallenge(request.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', MCP_URL);
  return url.toString();
}

export function newAuthorizeRequest(
  clientId: string,
  redirectUri: string,
  scope = 'store:read',
): AuthorizeRequest {
  return { clientId, redirectUri, scope, verifier: randomToken(48), state: randomToken(16) };
}

/** Signs in with "Try the demo" from the sign-in page that `url` shows. */
export async function demoSignIn(browser: Browser, url: string): Promise<Response> {
  const page = await browser.fetch(url);
  const html = await page.text();
  if (!html.includes('Try the demo')) throw new Error(`no sign-in page at ${url}`);
  const signedIn = await browser.post('/login/demo', {
    csrf: hiddenField(html, 'csrf'),
    return_to: hiddenField(html, 'return_to'),
  });
  if (signedIn.status !== 303) throw new Error(`demo sign-in failed: ${signedIn.status}`);
  return signedIn;
}

/** Runs the browser part of the authorization code flow and returns the code. */
export async function authorizeWithDemo(
  harness: Harness,
  request: AuthorizeRequest,
  browser = new Browser(harness),
): Promise<{ code: string; callback: URL; browser: Browser }> {
  const url = await authorizeUrl(request);
  const signedIn = await demoSignIn(browser, url);
  const consent = await browser.fetch(signedIn.headers.get('location') ?? '');
  const html = await consent.text();
  if (consent.status !== 200) throw new Error(`consent page failed: ${consent.status} ${html}`);
  const approved = await browser.post('/authorize', {
    csrf: hiddenField(html, 'csrf'),
    handle: hiddenField(html, 'handle'),
    decision: 'approve',
  });
  const location = approved.headers.get('location');
  if (approved.status !== 302 || !location) {
    throw new Error(`consent failed: ${approved.status} ${await approved.text()}`);
  }
  const callback = new URL(location);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error(`no code in ${location}`);
  return { code, callback, browser };
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export function tokenRequest(harness: Harness, fields: Record<string, string>): Promise<Response> {
  return harness.fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

export async function exchangeCode(
  harness: Harness,
  request: AuthorizeRequest,
  code: string,
): Promise<TokenResponse> {
  const response = await tokenRequest(harness, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    code_verifier: request.verifier,
    resource: MCP_URL,
  });
  if (response.status !== 200) {
    throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

/** Full flow with a fresh DCR client and a demo user. */
export async function connectDemoUser(
  harness: Harness,
  scope = 'store:read store:write refunds:write',
): Promise<{ tokens: TokenResponse; request: AuthorizeRequest; browser: Browser }> {
  const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
  const request = newAuthorizeRequest(clientId, CLAUDE_CALLBACK, scope);
  const { code, browser } = await authorizeWithDemo(harness, request);
  return { tokens: await exchangeCode(harness, request, code), request, browser };
}

/** An SDK client on Streamable HTTP, pinned to 2026-07-28, whose requests go into the app. */
export async function mcpClient(harness: Harness, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => harness.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client(
    { name: 'store-ops-remote-tests', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  return client;
}
