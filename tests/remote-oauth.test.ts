import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS } from '../src/remote/app.js';
import {
  authorizeUrl,
  authorizeWithDemo,
  BASE_URL,
  Browser,
  CIMD_CLIENT_ID,
  CLAUDE_CALLBACK,
  connectDemoUser,
  createHarness,
  demoSignIn,
  exchangeCode,
  hiddenField,
  MCP_URL,
  newAuthorizeRequest,
  registerClient,
  stubOutboundFetch,
  tokenRequest,
  type Harness,
  type TokenResponse,
} from './support/remote-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function listTools(accessToken: string): Promise<Response> {
  return harness.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('authorization code flow with PKCE', () => {
  it('works for a DCR client: sign-in, consent, code with state and iss, tokens', async () => {
    const clientId = await registerClient(harness, [CLAUDE_CALLBACK], 'Test DCR Client');
    const request = newAuthorizeRequest(clientId, CLAUDE_CALLBACK, 'store:read store:write');
    const browser = new Browser(harness);
    const signedIn = await demoSignIn(browser, await authorizeUrl(request));
    const consent = await browser.fetch(signedIn.headers.get('location') ?? '');
    const html = await consent.text();
    expect(consent.status).toBe(200);
    expect(html).toContain('Allow Test DCR Client to use your Demo Store?');
    expect(html).toContain('This app registered itself. Its name is not verified.');
    expect(html).toContain('Access will be sent to <strong>claude.ai</strong>');
    expect(html).toContain('See orders, customers, products, stock levels and sales');
    expect(html).toContain('Prepare stock adjustments, order cancellations and order notes');
    expect(html).not.toContain('Prepare refunds');
    expect(html).not.toContain('an app on your own computer');
    expect(consent.headers.get('x-frame-options')).toBe('DENY');
    expect(consent.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const approved = await browser.post('/authorize', {
      csrf: hiddenField(html, 'csrf'),
      handle: hiddenField(html, 'handle'),
      decision: 'approve',
    });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get('location') ?? '');
    expect(`${callback.origin}${callback.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(callback.searchParams.get('state')).toBe(request.state);
    expect(callback.searchParams.get('iss')).toBe(BASE_URL);

    const tokens = await exchangeCode(harness, request, callback.searchParams.get('code') ?? '');
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    expect(tokens.scope.split(' ').sort()).toEqual(['store:read', 'store:write']);
    expect(tokens.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(tokens.refresh_token).toBeTruthy();
    expect((await listTools(tokens.access_token)).status).toBe(200);
  });

  it('works for a CIMD client and shows its verified domain', async () => {
    vi.stubGlobal(
      'fetch',
      stubOutboundFetch({
        [CIMD_CLIENT_ID]: {
          client_id: CIMD_CLIENT_ID,
          client_name: 'Test CIMD Client',
          redirect_uris: [CLAUDE_CALLBACK],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        },
      }),
    );
    const request = newAuthorizeRequest(CIMD_CLIENT_ID, CLAUDE_CALLBACK);
    const browser = new Browser(harness);
    const signedIn = await demoSignIn(browser, await authorizeUrl(request));
    const consent = await browser.fetch(signedIn.headers.get('location') ?? '');
    const html = await consent.text();
    expect(html).toContain('Allow Test CIMD Client to use your Demo Store?');
    expect(html).toContain('published by <strong>client.example.com</strong>');

    const approved = await browser.post('/authorize', {
      csrf: hiddenField(html, 'csrf'),
      handle: hiddenField(html, 'handle'),
      decision: 'approve',
    });
    const code = new URL(approved.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokens = await exchangeCode(harness, request, code);
    expect(tokens.scope).toBe('store:read');
    expect((await listTools(tokens.access_token)).status).toBe(200);
  });

  it('refuses a code exchange with the wrong PKCE verifier', async () => {
    const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
    const request = newAuthorizeRequest(clientId, CLAUDE_CALLBACK);
    const { code } = await authorizeWithDemo(harness, request);
    const response = await tokenRequest(harness, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-123',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('audience', () => {
  it('refuses an authorization request for another resource', async () => {
    const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
    const url = new URL(await authorizeUrl(newAuthorizeRequest(clientId, CLAUDE_CALLBACK)));
    url.searchParams.set('resource', 'https://other.example.com/mcp');
    const response = await new Browser(harness).fetch(url.toString());
    // The client and redirect are verified, so the error goes back to the client (with iss).
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('location') ?? '');
    expect(callback.searchParams.get('error')).toBe('invalid_target');
    expect(callback.searchParams.get('iss')).toBe(BASE_URL);
    expect(callback.searchParams.get('code')).toBeNull();
  });

  it('refuses a token request that names another resource', async () => {
    const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
    const request = newAuthorizeRequest(clientId, CLAUDE_CALLBACK);
    const { code } = await authorizeWithDemo(harness, request);
    const response = await tokenRequest(harness, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: request.verifier,
      resource: 'https://other.example.com/mcp',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_target');
  });

  it('binds issued tokens to the MCP URL and the signed-in user and store', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    // The provider sets OAUTH_PROVIDER on the env it serves.
    const token = await harness.env.OAUTH_PROVIDER?.unwrapToken<{
      userId: string;
      storeId: string;
    }>(tokens.access_token);
    expect(token?.audience).toBe(MCP_URL);
    expect(token?.scope).toEqual(['store:read']);
    expect(token?.grant.props.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(token?.grant.props.storeId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('token lifetime and refresh', () => {
  it('answers an expired access token with 401 invalid_token', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + (ACCESS_TOKEN_TTL_SECONDS + 5) * 1000 });
    const response = await listTools(tokens.access_token);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('rotates refresh tokens and refuses a used or unknown one with invalid_grant', async () => {
    const { tokens, request } = await connectDemoUser(harness, 'store:read');
    const refresh = (refreshToken: string) =>
      tokenRequest(harness, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: request.clientId,
      });
    const first = await refresh(tokens.refresh_token);
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as TokenResponse;
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await listTools(rotated.access_token)).status).toBe(200);

    // Using the new refresh token retires the old one.
    const second = await refresh(rotated.refresh_token);
    expect(second.status).toBe(200);
    const old = await refresh(tokens.refresh_token);
    expect(old.status).toBe(400);
    expect(((await old.json()) as { error: string }).error).toBe('invalid_grant');

    const unknown = await refresh('not-a-refresh-token');
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('stops refreshing a demo user after the demo ends', async () => {
    const { tokens, request } = await connectDemoUser(harness, 'store:read');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 25 * 60 * 60_000 });
    const response = await tokenRequest(harness, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: request.clientId,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('redirect URI matching', () => {
  async function authorizeStatus(clientId: string, redirectUri: string): Promise<Response> {
    return new Browser(harness).fetch(
      await authorizeUrl(newAuthorizeRequest(clientId, redirectUri)),
    );
  }

  it('accepts the claude.ai callback only as an exact match', async () => {
    const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
    expect((await authorizeStatus(clientId, CLAUDE_CALLBACK)).status).toBe(200);
    for (const variant of [
      `${CLAUDE_CALLBACK}/extra`,
      `${CLAUDE_CALLBACK}?x=1`,
      'https://claude.ai/api/mcp/auth_callbac',
      'https://evil.claude.ai/api/mcp/auth_callback',
    ]) {
      const response = await authorizeStatus(clientId, variant);
      expect(response.status, variant).toBe(400);
      expect(response.headers.get('location'), variant).toBeNull();
    }
  });

  it('accepts loopback redirects on any port for localhost and 127.0.0.1', async () => {
    const clientId = await registerClient(harness, [
      'http://localhost/callback',
      'http://127.0.0.1/callback',
    ]);
    for (const uri of [
      'http://localhost:53682/callback',
      'http://127.0.0.1:61000/callback',
      'http://localhost/callback',
    ]) {
      expect((await authorizeStatus(clientId, uri)).status, uri).toBe(200);
    }
    for (const uri of [
      'http://localhost:53682/other',
      'http://example.com:53682/callback',
      'https://localhost.example.com/callback',
    ]) {
      const response = await authorizeStatus(clientId, uri);
      expect(response.status, uri).toBe(400);
      expect(response.headers.get('location'), uri).toBeNull();
    }
  });

  it('warns on the consent page when access goes to a local app', async () => {
    const clientId = await registerClient(harness, ['http://127.0.0.1/callback'], 'Local App');
    const request = newAuthorizeRequest(clientId, 'http://127.0.0.1:43210/callback');
    const browser = new Browser(harness);
    const signedIn = await demoSignIn(browser, await authorizeUrl(request));
    const html = await (await browser.fetch(signedIn.headers.get('location') ?? '')).text();
    expect(html).toContain('Access will be sent to <strong>127.0.0.1</strong>');
    expect(html).toContain('Access goes to an app on your own computer.');
  });

  it('refuses a registered redirect this server does not allow, without redirecting', async () => {
    const clientId = await registerClient(harness, ['https://evil.example.com/callback']);
    const response = await authorizeStatus(clientId, 'https://evil.example.com/callback');
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('This app is not supported');
  });
});

describe('consent page CSRF', () => {
  async function openConsent() {
    const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
    const request = newAuthorizeRequest(clientId, CLAUDE_CALLBACK);
    const browser = new Browser(harness);
    const signedIn = await demoSignIn(browser, await authorizeUrl(request));
    const html = await (await browser.fetch(signedIn.headers.get('location') ?? '')).text();
    return {
      browser,
      request,
      csrf: hiddenField(html, 'csrf'),
      handle: hiddenField(html, 'handle'),
    };
  }

  it('refuses a POST without the CSRF token, with a wrong one, or from another origin', async () => {
    const { browser, csrf, handle } = await openConsent();
    const attempts: [Record<string, string>, string][] = [
      [{ handle, decision: 'approve' }, BASE_URL],
      [{ csrf: `${csrf}x`, handle, decision: 'approve' }, BASE_URL],
      [{ csrf, handle, decision: 'approve' }, 'https://evil.example.com'],
    ];
    for (const [fields, origin] of attempts) {
      const response = await browser.post('/authorize', fields, origin);
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
    }
    // The untouched form still works afterwards.
    const ok = await browser.post('/authorize', { csrf, handle, decision: 'approve' });
    expect(ok.status).toBe(302);
  });

  it("refuses another browser's CSRF token and consent handle", async () => {
    const victim = await openConsent();
    const attacker = new Browser(harness);
    await demoSignIn(attacker, await authorizeUrl(victim.request));
    const response = await attacker.post('/authorize', {
      csrf: victim.csrf,
      handle: victim.handle,
      decision: 'approve',
    });
    expect(response.status).toBe(403);
  });

  it('sends access_denied with state and iss when the user denies', async () => {
    const { browser, request, csrf, handle } = await openConsent();
    const response = await browser.post('/authorize', { csrf, handle, decision: 'deny' });
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('location') ?? '');
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe(request.state);
    expect(callback.searchParams.get('iss')).toBe(BASE_URL);
    expect(callback.searchParams.get('code')).toBeNull();
  });
});
