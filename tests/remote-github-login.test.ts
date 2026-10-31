import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pkceChallenge } from '../src/remote/github.js';
import {
  authorizeUrl,
  BASE_URL,
  Browser,
  CLAUDE_CALLBACK,
  createHarness,
  FAKE_GITHUB,
  hiddenField,
  newAuthorizeRequest,
  registerClient,
  type Harness,
} from './support/remote-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({ githubUser: { id: 777001, login: 'demo-github-user' } });
});

afterAll(async () => {
  await harness.close();
});

async function signInPage(): Promise<{ browser: Browser; html: string; authorize: string }> {
  const clientId = await registerClient(harness, [CLAUDE_CALLBACK]);
  const authorize = await authorizeUrl(newAuthorizeRequest(clientId, CLAUDE_CALLBACK));
  const browser = new Browser(harness);
  const html = await (await browser.fetch(authorize)).text();
  return { browser, html, authorize };
}

async function startGithub(): Promise<{ browser: Browser; github: URL; authorize: string }> {
  const { browser, html, authorize } = await signInPage();
  const response = await browser.post('/login/github', {
    csrf: hiddenField(html, 'csrf'),
    return_to: hiddenField(html, 'return_to'),
  });
  expect(response.status).toBe(303);
  return { browser, github: new URL(response.headers.get('location') ?? ''), authorize };
}

async function githubUserCount(): Promise<number> {
  const { rows } = await harness.local.owner.query<{ n: number }>(
    "select count(*)::int as n from store_ops.users where kind = 'github'",
  );
  return rows[0]?.n ?? -1;
}

describe('GitHub sign-in', () => {
  it('sends the browser to GitHub with state and a PKCE S256 challenge', async () => {
    const { github } = await startGithub();
    expect(`${github.origin}${github.pathname}`).toBe(FAKE_GITHUB.authorize);
    expect(github.searchParams.get('client_id')).toBe('test-github-client');
    expect(github.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/login/github/callback`);
    expect(github.searchParams.get('state')?.length).toBeGreaterThanOrEqual(43);
    expect(github.searchParams.get('code_challenge_method')).toBe('S256');
    expect(github.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(github.toString()).not.toContain('test-github-secret');
  });

  it('signs in, maps the GitHub account to one internal user and returns to consent', async () => {
    const before = await githubUserCount();
    const { browser, github, authorize } = await startGithub();
    harness.githubCalls.length = 0;
    const callback = await browser.fetch(
      `/login/github/callback?code=github-code-ok&state=${github.searchParams.get('state') ?? ''}`,
    );
    expect(callback.status).toBe(303);
    const back = new URL(callback.headers.get('location') ?? '', BASE_URL);
    expect(back.toString()).toBe(authorize);

    const [tokenCall, userCall] = harness.githubCalls;
    const sent = new URLSearchParams(tokenCall?.body ?? '');
    expect(tokenCall?.url).toBe(FAKE_GITHUB.token);
    expect(sent.get('client_secret')).toBe('test-github-secret');
    expect(sent.get('redirect_uri')).toBe(`${BASE_URL}/login/github/callback`);
    expect(await pkceChallenge(sent.get('code_verifier') ?? '')).toBe(
      github.searchParams.get('code_challenge'),
    );
    expect(userCall?.authorization).toBe('Bearer gho_fake_token');

    const consent = await browser.fetch(back.toString());
    expect(await consent.text()).toContain('to use your Demo Store?');
    expect(await githubUserCount()).toBe(before + 1);

    // A second sign-in with the same GitHub account reuses the same internal user.
    const again = await startGithub();
    await again.browser.fetch(
      `/login/github/callback?code=github-code-ok&state=${again.github.searchParams.get('state') ?? ''}`,
    );
    expect(await githubUserCount()).toBe(before + 1);
  });

  it('refuses a callback with the wrong state or without the login cookie', async () => {
    const { browser, github } = await startGithub();
    const wrong = await browser.fetch('/login/github/callback?code=github-code-ok&state=forged');
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get('location')).toBeNull();

    const stranger = new Browser(harness);
    const noCookie = await stranger.fetch(
      `/login/github/callback?code=github-code-ok&state=${github.searchParams.get('state') ?? ''}`,
    );
    expect(noCookie.status).toBe(400);
    expect(stranger.cookies.has('__Host-store-ops-session')).toBe(false);
  });

  it('shows an error and starts no session when GitHub refuses the code', async () => {
    const { browser, github } = await startGithub();
    const response = await browser.fetch(
      `/login/github/callback?code=bad-code&state=${github.searchParams.get('state') ?? ''}`,
    );
    expect(response.status).toBe(502);
    expect(browser.cookies.has('__Host-store-ops-session')).toBe(false);
  });

  it('protects the sign-in forms with CSRF and only returns to our own pages', async () => {
    const { browser, html } = await signInPage();
    const csrf = hiddenField(html, 'csrf');
    const returnTo = hiddenField(html, 'return_to');
    expect((await browser.post('/login/demo', { return_to: returnTo })).status).toBe(403);
    expect(
      (await browser.post('/login/demo', { csrf, return_to: returnTo }, 'https://evil.example.com'))
        .status,
    ).toBe(403);
    for (const target of ['https://evil.example.com/', '//evil.example.com/', '/mcp']) {
      const response = await browser.post('/login/demo', { csrf, return_to: target });
      expect(response.status, target).toBe(400);
    }
    expect(browser.cookies.has('__Host-store-ops-session')).toBe(false);
  });
});

describe('without a GitHub OAuth App', () => {
  it('offers only the demo sign-in', async () => {
    const plain = await createHarness({ github: false });
    try {
      const clientId = await registerClient(plain, [CLAUDE_CALLBACK]);
      const browser = new Browser(plain);
      const html = await (
        await browser.fetch(await authorizeUrl(newAuthorizeRequest(clientId, CLAUDE_CALLBACK)))
      ).text();
      expect(html).toContain('Try the demo');
      expect(html).not.toContain('Sign in with GitHub');
      const response = await browser.post('/login/github', {
        csrf: hiddenField(html, 'csrf'),
        return_to: hiddenField(html, 'return_to'),
      });
      expect(response.status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
