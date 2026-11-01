import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OAUTH_PURGE_CURSOR_KEY } from '../src/remote/app.js';
import { clientNetwork, DEMO_CLIENT_DAILY_LIMIT } from '../src/remote/auth-routes.js';
import { scopesForTool } from '../src/remote/scopes.js';
import {
  authorizeUrl,
  BASE_URL,
  Browser,
  connectDemoUser,
  createHarness,
  demoSignIn,
  hiddenField,
  MCP_URL,
  mcpClient,
  newAuthorizeRequest,
  registerClient,
  CLAUDE_CALLBACK,
  tokenRequest,
  type Harness,
  type TokenResponse,
} from './support/remote-harness.js';

const HOUR = 60 * 60_000;

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

afterEach(() => {
  vi.useRealTimers();
  harness.limiter.allow = true;
});

async function demoUserCount(target: Harness): Promise<number> {
  const { rows } = await target.local.owner.query<{ n: number }>(
    "select count(*)::int as n from store_ops.users where kind = 'demo'",
  );
  return rows[0]?.n ?? -1;
}

async function signInPage(target: Harness, browser: Browser): Promise<string> {
  const clientId = await registerClient(target, [CLAUDE_CALLBACK]);
  const page = await browser.fetch(
    await authorizeUrl(newAuthorizeRequest(clientId, CLAUDE_CALLBACK)),
  );
  return page.text();
}

async function postDemoLogin(
  browser: Browser,
  html: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return browser.fetch('/login/demo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE_URL,
      ...headers,
    },
    body: new URLSearchParams({
      csrf: hiddenField(html, 'csrf'),
      return_to: hiddenField(html, 'return_to'),
    }).toString(),
  });
}

async function tokenProps(accessToken: string): Promise<{ userId: string; storeId: string }> {
  const token = await harness.env.OAUTH_PROVIDER?.unwrapToken<{
    userId: string;
    storeId: string;
  }>(accessToken);
  if (!token) throw new Error('token not found');
  return token.grant.props;
}

describe('rate limits on "Try the demo"', () => {
  it('limits each client address and answers 429 without creating a user', async () => {
    const browser = new Browser(harness);
    const html = await signInPage(harness, browser);
    harness.limiter.allow = false;
    const before = await demoUserCount(harness);
    const response = await postDemoLogin(browser, html, { 'CF-Connecting-IP': '203.0.113.7' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.text()).toContain('Please wait a minute');
    expect(harness.limiter.keys.at(-1)).toBe('demo-login:203.0.113.7');
    expect(await demoUserCount(harness)).toBe(before);
  });

  it('stops new demos once the daily cap is reached', async () => {
    const capped = await createHarness({ demoDailyCap: 0 });
    try {
      const browser = new Browser(capped);
      const html = await signInPage(capped, browser);
      const response = await postDemoLogin(browser, html);
      expect(response.status).toBe(429);
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
      const text = await response.text();
      expect(text).toContain('limit of new demos is reached');
      expect(text).toContain('sign in with GitHub');
      expect(await demoUserCount(capped)).toBe(0);
    } finally {
      await capped.close();
    }
  });
});

describe('per-client daily limit on "Try the demo"', () => {
  it('groups IPv6 clients by their /64 and keeps IPv4 addresses whole', () => {
    const network = (address?: string) =>
      clientNetwork(
        new Request(BASE_URL, address ? { headers: { 'CF-Connecting-IP': address } } : {}),
      );
    expect(network('203.0.113.7')).toBe('203.0.113.7');
    expect(network('2001:db8:abcd:12:1::5')).toBe('2001:db8:abcd:12::/64');
    expect(network('2001:0db8:abcd:0012:ffff:1:2:3')).toBe('2001:db8:abcd:12::/64');
    expect(network('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(network('::1')).toBe('0:0:0:0::/64');
    expect(network()).toBeUndefined();
  });

  it('answers 429 once one network started the daily number of demos', async () => {
    const address = '2001:db8:77:1::1';
    for (let i = 0; i < DEMO_CLIENT_DAILY_LIMIT; i += 1) {
      const browser = new Browser(harness);
      const html = await signInPage(harness, browser);
      // Other addresses in the same /64 count as the same client.
      const ok = await postDemoLogin(browser, html, {
        'CF-Connecting-IP': `2001:db8:77:1::${i + 2}`,
      });
      expect(ok.status).toBe(303);
    }
    const browser = new Browser(harness);
    const html = await signInPage(harness, browser);
    const before = await demoUserCount(harness);
    const refused = await postDemoLogin(browser, html, { 'CF-Connecting-IP': address });
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain(
      `This network started ${DEMO_CLIENT_DAILY_LIMIT} demos today`,
    );
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await demoUserCount(harness)).toBe(before);
  });

  it('reports a sign-up without a client address', async () => {
    const errors = harness.errors.length;
    const response = await harness.fetch(`${BASE_URL}/login/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL },
      body: 'csrf=x&return_to=/authorize',
    });
    expect(response.status).toBe(403);
    expect(String(harness.errors.at(-1))).toContain('CF-Connecting-IP');
    harness.errors.splice(errors);
  });
});

describe('demo expiry on the remote server', () => {
  it('tells a returning browser at sign-in that the demo expired', async () => {
    const browser = new Browser(harness);
    const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
    const url = await authorizeUrl(newAuthorizeRequest(clientId, CLAUDE_CALLBACK));
    await demoSignIn(browser, url);
    const signedIn = await browser.fetch(url);
    expect(await signedIn.text()).toContain('Allow');

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 24 * HOUR + 60_000 });
    const page = await browser.fetch(url);
    const html = await page.text();
    expect(html).toContain('Your demo expired');
    expect(html).toContain('Try the demo');

    const fresh = await new Browser(harness).fetch(url);
    expect(await fresh.text()).not.toContain('Your demo expired');
  });

  it('refuses a still valid access token once the demo expired', async () => {
    const { tokens, request } = await connectDemoUser(harness, 'store:read');
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start + 23.5 * HOUR });
    const refreshed = await tokenRequest(harness, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: request.clientId,
    });
    expect(refreshed.status).toBe(200);
    const late = (await refreshed.json()) as TokenResponse;

    vi.setSystemTime(start + 24 * HOUR + 60_000);
    const response = await harness.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${late.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('The demo expired');
  });

  it('answers a tool call on a hidden store with an OAuth challenge in _meta', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    const { storeId } = await tokenProps(tokens.access_token);
    await harness.local.owner.query(
      "update store_ops.stores set expires_at = now() - interval '1 minute' where id = $1",
      [storeId],
    );
    const client = await mcpClient(harness, tokens.access_token);
    const result = await client.callTool({ name: 'get_stock_levels', arguments: {} });
    expect(result.isError).toBe(true);
    const challenges = result._meta?.['mcp/www_authenticate'];
    expect(Array.isArray(challenges)).toBe(true);
    const [challenge] = challenges as string[];
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('error_description="');
    expect(challenge).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    await client.close();
  });
});

describe('ChatGPT tool metadata', () => {
  it('declares OAuth securitySchemes with the scopes of each tool, on the wire', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    // Raw request: the SDK client drops fields it does not know, such as securitySchemes.
    const response = await harness.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'raw-test', version: '0.0.0' },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: { name: string; securitySchemes?: unknown; annotations?: unknown }[] };
    };
    expect(body.result.tools.length).toBe(10);
    for (const tool of body.result.tools) {
      expect(tool.securitySchemes, tool.name).toEqual([
        { type: 'oauth2', scopes: [...scopesForTool(tool.name)] },
      ]);
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });
});

describe('scheduled cleanup', () => {
  it('wipes expired demo stores, revokes their grants and sweeps OAuth data', async () => {
    const { tokens, request } = await connectDemoUser(harness, 'store:read');
    const { userId, storeId } = await tokenProps(tokens.access_token);
    const oauth = harness.env.OAUTH_PROVIDER;
    if (!oauth) throw new Error('OAUTH_PROVIDER is missing');
    expect((await oauth.listUserGrants(userId)).items).toHaveLength(1);
    // Past the cleanup's 15 minute grace.
    await harness.local.owner.query(
      "update store_ops.stores set expires_at = now() - interval '1 hour' where id = $1",
      [storeId],
    );

    const report = await harness.app.cleanUp(harness.env);
    expect(report.storesWiped).toBeGreaterThanOrEqual(1);
    expect(report.grantsRevoked).toBeGreaterThanOrEqual(1);
    expect(report.oauthPurge?.done).toBe(true);
    expect(report.usersNotRevoked).toBe(0);
    expect((await oauth.listUserGrants(userId)).items).toEqual([]);
    expect(await harness.kv.get(OAUTH_PURGE_CURSOR_KEY)).toBeNull();
    const members = await harness.local.owner.query(
      'select 1 from store_ops.store_members where store_id = $1',
      [storeId],
    );
    expect(members.rows).toEqual([]);

    const refresh = await tokenRequest(harness, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: request.clientId,
    });
    expect(refresh.status).toBe(400);
  });

  it('still wipes expired stores when the OAuth sweep fails', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    const { storeId } = await tokenProps(tokens.access_token);
    await harness.local.owner.query(
      "update store_ops.stores set expires_at = now() - interval '1 hour' where id = $1",
      [storeId],
    );
    const get = harness.kv.get.bind(harness.kv);
    const failure = new Error('KV unavailable');
    const spy = vi
      .spyOn(harness.kv, 'get')
      .mockImplementation((key, ...rest) =>
        key === OAUTH_PURGE_CURSOR_KEY ? Promise.reject(failure) : get(key, ...rest),
      );
    try {
      const errors = harness.errors.length;
      const report = await harness.app.cleanUp(harness.env);
      expect(report.oauthPurge).toBeNull();
      expect(report.storesWiped).toBeGreaterThanOrEqual(1);
      expect(harness.errors.slice(errors)).toEqual([failure]);
      harness.errors.splice(errors);
    } finally {
      spy.mockRestore();
    }
    const members = await harness.local.owner.query(
      'select 1 from store_ops.store_members where store_id = $1',
      [storeId],
    );
    expect(members.rows).toEqual([]);
  });

  it('runs from the scheduled handler', async () => {
    const controller = {
      scheduledTime: Date.now(),
      cron: '17 * * * *',
      noRetry: () => undefined,
    } as ScheduledController;
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
    await expect(harness.app.scheduled(controller, harness.env, ctx)).resolves.toBeUndefined();
    expect(harness.errors).toEqual([]);
  });
});
