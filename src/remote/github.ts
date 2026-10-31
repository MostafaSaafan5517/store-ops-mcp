import { PRODUCT_NAME } from '../config.js';
import { toBase64Url } from './session.js';

/** GitHub's OAuth App endpoints. Tests replace them and `fetch`; they never call GitHub. */
export interface GithubEndpoints {
  authorize: string;
  token: string;
  user: string;
}

export const GITHUB_ENDPOINTS: GithubEndpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
};

export interface GithubApp {
  clientId: string;
  clientSecret: string;
  endpoints: GithubEndpoints;
  fetch: typeof fetch;
}

export class GithubSignInError extends Error {}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * The GitHub authorize URL for a standard authorization code flow with `state` and PKCE
 * (S256). No scopes: only the public profile (id and login) is read.
 */
export async function githubAuthorizeUrl(
  app: GithubApp,
  input: { redirectUri: string; state: string; verifier: string },
): Promise<string> {
  const url = new URL(app.endpoints.authorize);
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', await pkceChallenge(input.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

/**
 * Exchanges the code for a GitHub token, reads the user's id and login, and drops the token.
 * The GitHub token is never stored and never reaches MCP clients.
 */
export async function fetchGithubUser(
  app: GithubApp,
  input: { code: string; redirectUri: string; verifier: string },
): Promise<{ id: number; login: string }> {
  const tokenResponse = await app.fetch(app.endpoints.token, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    }),
  });
  const token = (await tokenResponse.json().catch(() => ({}))) as {
    access_token?: unknown;
    error?: unknown;
  };
  if (!tokenResponse.ok || typeof token.access_token !== 'string') {
    throw new GithubSignInError(
      `GitHub did not accept the sign-in${typeof token.error === 'string' ? ` (${token.error})` : ''}.`,
    );
  }
  const userResponse = await app.fetch(app.endpoints.user, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': PRODUCT_NAME,
    },
  });
  const user = (await userResponse.json().catch(() => ({}))) as { id?: unknown; login?: unknown };
  if (!userResponse.ok || typeof user.id !== 'number' || typeof user.login !== 'string') {
    throw new GithubSignInError('GitHub did not return your profile.');
  }
  return { id: user.id, login: user.login };
}
