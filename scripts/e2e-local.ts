import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { pkceChallenge } from '../src/remote/github.js';
import { randomToken } from '../src/remote/session.js';

// End-to-end check of the local Worker (`pnpm dev:worker`, which uses the compose Postgres
// through Hyperdrive's localConnectionString). Usage: pnpm e2e:local [base URL]
//
// Runs what a real MCP client and a person in a browser would do: the 401 challenge, discovery,
// dynamic client registration, the authorization code flow with PKCE through "Try the demo"
// and the consent page, a read tool, a write tool approved on the approval page, and one run
// of the scheduled cleanup. Tokens and cookies are never printed.

const BASE_URL = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const MCP_URL = `${BASE_URL}/mcp`;
const REDIRECT_URI = 'http://localhost:53682/callback';

let failures = 0;

function report(step: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}\n`);
}

function expectOk(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A browser: one cookie jar, no redirects followed, same-origin form posts. */
class Browser {
  private readonly cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    const response = await fetch(new URL(url, BASE_URL), { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const index = pair.indexOf('=');
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(pair.slice(0, index).trim());
      else this.cookies.set(pair.slice(0, index).trim(), value);
    }
    return response;
  }

  post(url: string, fields: Record<string, string>): Promise<Response> {
    return this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match?.[1]) throw new Error(`no ${name} field on the page`);
  return match[1].replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function challengeAndDiscovery(): Promise<void> {
  const unauthenticated = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const challenge = unauthenticated.headers.get('www-authenticate') ?? '';
  expectOk(unauthenticated.status === 401, `expected 401, got ${unauthenticated.status}`);
  expectOk(challenge.includes('resource_metadata='), 'no resource_metadata in the challenge');
  report('401 challenge', true, `401, WWW-Authenticate: ${challenge}`);

  const resource = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`);
  const resourceBody = await json<{ resource: string; authorization_servers: string[] }>(resource);
  expectOk(resourceBody.resource === MCP_URL, `resource is ${resourceBody.resource}`);
  report(
    'protected resource metadata',
    true,
    `resource ${resourceBody.resource}, authorization_servers ${resourceBody.authorization_servers.join(' ')}`,
  );

  const server = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
  const serverBody = await json<{
    issuer: string;
    code_challenge_methods_supported: string[];
    registration_endpoint: string;
    scopes_supported: string[];
    authorization_response_iss_parameter_supported?: boolean;
  }>(server);
  expectOk(serverBody.issuer === BASE_URL, `issuer is ${serverBody.issuer}`);
  expectOk(serverBody.code_challenge_methods_supported.includes('S256'), 'no S256');
  report(
    'authorization server metadata',
    true,
    `issuer ${serverBody.issuer}, PKCE ${serverBody.code_challenge_methods_supported.join(',')}, scopes ${serverBody.scopes_supported.join(' ')}, iss parameter ${String(serverBody.authorization_response_iss_parameter_supported)}`,
  );
}

async function signIn(browser: Browser): Promise<{ accessToken: string }> {
  const registered = await fetch(`${BASE_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Store Ops e2e script',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expectOk(registered.status === 201, `registration returned ${registered.status}`);
  const { client_id: clientId } = await json<{ client_id: string }>(registered);
  report('dynamic client registration', true, `201, public client registered`);

  const verifier = randomToken(48);
  const state = randomToken(16);
  const authorize = new URL(`${BASE_URL}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'store:read store:write refunds:write',
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    resource: MCP_URL,
  }).toString();

  const signInPage = await browser.fetch(authorize.toString());
  const signInHtml = await signInPage.text();
  expectOk(signInHtml.includes('Try the demo'), `no sign-in page (${signInPage.status})`);
  const demo = await browser.post('/login/demo', {
    csrf: hiddenField(signInHtml, 'csrf'),
    return_to: hiddenField(signInHtml, 'return_to'),
  });
  expectOk(demo.status === 303, `demo sign-in returned ${demo.status}`);
  report('demo sign-in', true, '303 back to /authorize with a session cookie');

  const consent = await browser.fetch(demo.headers.get('location') ?? '');
  const consentHtml = await consent.text();
  expectOk(consent.status === 200 && consentHtml.includes('Allow'), 'no consent page');
  const approved = await browser.post('/authorize', {
    csrf: hiddenField(consentHtml, 'csrf'),
    handle: hiddenField(consentHtml, 'handle'),
    decision: 'approve',
  });
  const callback = new URL(approved.headers.get('location') ?? 'about:blank');
  const code = callback.searchParams.get('code');
  expectOk(approved.status === 302 && code !== null, `consent returned ${approved.status}`);
  expectOk(callback.searchParams.get('state') === state, 'state mismatch');
  expectOk(callback.searchParams.get('iss') === BASE_URL, 'iss missing from the redirect');
  report('consent', true, `302 to ${callback.origin}${callback.pathname} with code, state and iss`);

  const token = await fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    }).toString(),
  });
  expectOk(token.status === 200, `token exchange returned ${token.status}`);
  const tokens = await json<{ access_token: string; scope: string; expires_in: number }>(token);
  report(
    'token exchange (PKCE)',
    true,
    `scope "${tokens.scope}", expires in ${tokens.expires_in}s`,
  );
  return { accessToken: tokens.access_token };
}

interface WriteOutput {
  status: string;
  approval_id: string;
  summary: string;
  approval: { approval_url: string } | null;
}

async function tools(browser: Browser, accessToken: string): Promise<void> {
  const client = new Client(
    { name: 'store-ops-e2e', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  try {
    const listed = await client.listTools();
    report('tools/list', listed.tools.length === 10, `${listed.tools.length} tools`);

    const stock = await client.callTool({ name: 'get_stock_levels', arguments: {} });
    const products = (
      stock.structuredContent as { products?: { sku: string; stock_on_hand: number }[] }
    ).products;
    const product = products?.[0];
    expectOk(!stock.isError && product !== undefined, 'get_stock_levels failed');
    report(
      'read tool get_stock_levels',
      true,
      `${products?.length ?? 0} products, ${product?.sku} has ${product?.stock_on_hand}`,
    );
    if (!product) return;

    const args = { sku: product.sku, quantity_change: 3, reason: 'e2e restock' };
    const first = await client.callTool({ name: 'adjust_stock', arguments: args });
    const prepared = first.structuredContent as WriteOutput;
    expectOk(prepared.status === 'approval_required', `status ${prepared.status}`);
    report('write tool adjust_stock (first call)', true, `approval_required: ${prepared.summary}`);

    const early = await client.callTool({
      name: 'adjust_stock',
      arguments: { ...args, approval_id: prepared.approval_id },
    });
    report('write tool before approval', early.isError === true, 'refused, nothing changed');

    const pageUrl = prepared.approval?.approval_url ?? '';
    const page = await browser.fetch(pageUrl);
    const pageHtml = await page.text();
    expectOk(page.status === 200 && pageHtml.includes('Approve this action?'), 'no approval page');
    const decided = await browser.post(new URL(pageUrl).pathname, {
      csrf: hiddenField(pageHtml, 'csrf'),
      decision: 'approve',
    });
    const decidedHtml = await decided.text();
    expectOk(decided.status === 200 && decidedHtml.includes('<h1>Approved</h1>'), 'not approved');
    report('approval page', true, `approved at ${pageUrl}`);

    const executed = await client.callTool({
      name: 'adjust_stock',
      arguments: { ...args, approval_id: prepared.approval_id },
    });
    const done = executed.structuredContent as WriteOutput;
    expectOk(!executed.isError && done.status === 'executed', 'not executed');
    report('write tool adjust_stock (approved call)', true, `executed: ${done.summary}`);

    const after = await client.callTool({ name: 'get_stock_levels', arguments: {} });
    const updated = (
      after.structuredContent as { products: { sku: string; stock_on_hand: number }[] }
    ).products.find((item) => item.sku === product.sku);
    report(
      'stock after approval',
      updated?.stock_on_hand === product.stock_on_hand + 3,
      `${product.sku}: ${product.stock_on_hand} -> ${updated?.stock_on_hand}`,
    );
  } finally {
    await client.close();
  }
}

async function scheduled(): Promise<void> {
  // wrangler dev does not run Cron Triggers on its own; this endpoint runs the handler once.
  const response = await fetch(
    `${BASE_URL}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('17 * * * *')}&format=json`,
  );
  const body = await response.text();
  report('scheduled cleanup', response.status === 200 && body.includes('"ok"'), body.trim());
}

async function main(): Promise<void> {
  const steps: [string, () => Promise<void>][] = [];
  const browser = new Browser();
  let accessToken = '';
  steps.push(['challenge and discovery', challengeAndDiscovery]);
  steps.push([
    'sign-in',
    async () => {
      accessToken = (await signIn(browser)).accessToken;
    },
  ]);
  steps.push(['tools', () => tools(browser, accessToken)]);
  steps.push(['cron', scheduled]);
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      report(name, false, error instanceof Error ? error.message : String(error));
      break;
    }
  }
  process.stdout.write(failures === 0 ? 'All steps passed.\n' : `${failures} step(s) failed.\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
