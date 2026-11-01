import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { ensureDemoStore } from '../seed/provision.js';
import { createDemoUser, signInGithubUser } from '../users.js';
import { fetchGithubUser, githubAuthorizeUrl, GithubSignInError } from './github.js';
import { htmlResponse } from './html.js';
import type { PageContext } from './config.js';
import { consentBody, messageBody, signInBody } from './pages.js';
import { isAllowedRedirect } from './redirects.js';
import { BASELINE_SCOPE, isScope, SCOPES, type Scope } from './scopes.js';
import {
  hostCookie,
  randomToken,
  readCookie,
  readSession,
  sessionEndedDemo,
  SESSION_TTL_MS,
  sessionCookie,
  type Session,
} from './session.js';

const GITHUB_LOGIN_COOKIE = '__Host-store-ops-github';
const GITHUB_LOGIN_TTL_MS = 10 * 60_000;

/** Props stored with every grant and handed to the MCP endpoint with each token. */
export interface TokenProps {
  userId: string;
  storeId: string;
  /** Epoch milliseconds, set for demo users only. Refreshing fails after it. */
  demoExpiresAt?: number;
}

function errorPage(status: number, title: string, message: string, headers?: Headers): Response {
  return htmlResponse(title, messageBody(title, message), {
    status,
    ...(headers ? { headers } : {}),
  });
}

function redirect(location: string, headers = new Headers(), status = 303): Response {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status, headers });
}

/** Only our own sign-in targets: the authorize page or an approval page. */
function safeReturnTo(context: PageContext, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return undefined;
  }
  if (!URL.canParse(value, context.config.baseUrl)) return undefined;
  const url = new URL(value, context.config.baseUrl);
  if (url.origin !== context.config.baseUrl) return undefined;
  if (url.pathname !== '/authorize' && !/^\/approve\/[^/]+$/.test(url.pathname)) return undefined;
  return `${url.pathname}${url.search}`;
}

/** The scopes this server grants for a request: the known ones asked for, always with read. */
export function grantedScopes(requested: string[]): Scope[] {
  const asked = new Set<string>([BASELINE_SCOPE, ...requested.filter(isScope)]);
  return SCOPES.filter((scope) => asked.has(scope));
}

export const DEMO_EXPIRED_REASON =
  'Your demo expired. Demo stores last 24 hours, then their data is deleted. Choose "Try the demo" to start a new one.';

/** The sign-in page, shown before consent or an approval when there is no session. */
export async function signInPage(context: PageContext, reason: string): Promise<Response> {
  if (await sessionEndedDemo(context.config.signer, context.request, context.now)) {
    reason = DEMO_EXPIRED_REASON;
  }
  const { token, setCookie } = await context.config.csrf.issue(context.request);
  const headers = new Headers();
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return htmlResponse(
    'Sign in',
    signInBody({
      csrf: token,
      returnTo: `${context.url.pathname}${context.url.search}`,
      githubEnabled: context.config.github !== undefined,
      reason,
    }),
    { headers },
  );
}

function authorizationFailure(error: unknown): Response {
  // A redirect back to the client is safe only once the client and redirect URI are verified.
  if (error instanceof AuthorizationError && error.redirectTo) {
    return redirect(error.redirectTo, new Headers(), 302);
  }
  if (error instanceof AuthorizationError) {
    return errorPage(400, 'This sign-in request is not valid', error.description);
  }
  if (error instanceof CimdFetchError) {
    return errorPage(
      400,
      'This app could not be verified',
      'Its client metadata could not be read.',
    );
  }
  throw error;
}

const REDIRECT_NOT_ALLOWED =
  'This app asked to receive access at an address this demo server does not allow. Supported apps: Claude, ChatGPT and local apps on this computer.';

export async function showAuthorize(context: PageContext): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await context.oauth.parseAuthRequest(context.request);
  } catch (error) {
    return authorizationFailure(error);
  }
  if (!isAllowedRedirect(authRequest.redirectUri)) {
    return errorPage(400, 'This app is not supported', REDIRECT_NOT_ALLOWED);
  }
  const session = await readSession(context.config.signer, context.request, context.now);
  if (!session) {
    return signInPage(context, 'Sign in to connect an app to your Demo Store.');
  }
  try {
    const details = await context.oauth.describeConsent(authRequest);
    const consent = await context.oauth.beginConsent(authRequest);
    const { token, setCookie } = await context.config.csrf.issue(context.request);
    if (setCookie) consent.headers.append('Set-Cookie', setCookie);
    return htmlResponse(
      'Connect an app',
      consentBody({
        details,
        scopes: grantedScopes(authRequest.scope),
        handle: consent.handle,
        csrf: token,
      }),
      { headers: consent.headers },
    );
  } catch (error) {
    return authorizationFailure(error);
  }
}

const EXPIRED_FORM =
  'This page expired or was already used. Go back to your app and start connecting again.';

export async function submitAuthorize(context: PageContext): Promise<Response> {
  const form = await context.request.formData();
  if (!(await context.config.csrf.check(context.request, form))) {
    return errorPage(403, 'Request refused', EXPIRED_FORM);
  }
  const session = await readSession(context.config.signer, context.request, context.now);
  if (!session) return errorPage(403, 'Signed out', EXPIRED_FORM);
  const handle = form.get('handle');
  if (typeof handle !== 'string') return errorPage(400, 'Request refused', EXPIRED_FORM);
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await context.oauth.denyConsent(context.request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await context.oauth.approveConsent(context.request, handle);
    if (!isAllowedRedirect(approved.request.redirectUri)) {
      return errorPage(400, 'This app is not supported', REDIRECT_NOT_ALLOWED);
    }
    const props: TokenProps = {
      userId: session.userId,
      storeId: session.storeId,
      ...(session.kind === 'demo' ? { demoExpiresAt: session.expiresAt } : {}),
    };
    const { redirectTo } = await context.oauth.completeAuthorization({
      request: approved.request,
      userId: session.userId,
      metadata: { kind: session.kind },
      scope: grantedScopes(approved.request.scope),
      props,
    });
    return redirect(redirectTo, approved.headers, 302);
  } catch (error) {
    if (error instanceof AuthorizationError && !error.redirectTo) {
      return errorPage(400, 'Request refused', EXPIRED_FORM);
    }
    return authorizationFailure(error);
  }
}

async function startSession(
  context: PageContext,
  input: { userId: string; kind: Session['kind']; expiresAt: number },
  returnTo: string,
  headers = new Headers(),
): Promise<Response> {
  const { principal } = await ensureDemoStore(context.db, input.userId, context.now);
  const session: Session = { ...principal, kind: input.kind, expiresAt: input.expiresAt };
  headers.append('Set-Cookie', await sessionCookie(context.config.signer, session, context.now));
  return redirect(returnTo, headers);
}

async function checkedLoginForm(
  context: PageContext,
): Promise<{ returnTo: string } | { refused: Response }> {
  const form = await context.request.formData();
  if (!(await context.config.csrf.check(context.request, form))) {
    return { refused: errorPage(403, 'Request refused', EXPIRED_FORM) };
  }
  const returnTo = safeReturnTo(context, form.get('return_to'));
  if (!returnTo) return { refused: errorPage(400, 'Request refused', EXPIRED_FORM) };
  return { returnTo };
}

/** Seconds until the next UTC midnight, when the daily demo cap resets. */
function secondsUntilUtcMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  const headers = new Headers({ 'Retry-After': String(retryAfterSeconds) });
  return errorPage(429, 'Too many demo sign-ups', message, headers);
}

/** Seconds a client waits after hitting the per-client limit (the binding's period). */
export const DEMO_LOGIN_RETRY_SECONDS = 60;

/** New demos per client network per UTC day, so one client cannot use up the global cap. */
export const DEMO_CLIENT_DAILY_LIMIT = 5;

/**
 * The client's network as the rate limit key: the IPv4 address, or the /64 prefix of an IPv6
 * address (one subscriber usually holds a whole /64). Cloudflare sets CF-Connecting-IP on
 * every request from the internet.
 */
export function clientNetwork(request: Request): string | undefined {
  const address = request.headers.get('cf-connecting-ip')?.trim().toLowerCase();
  if (!address) return undefined;
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * "Try the demo": a new demo user with a freshly generated Demo Store. Limited per client
 * network by the Rate Limiting binding (approximate, per Cloudflare location), per client
 * network per UTC day and by a global daily cap (both counted exactly by the database).
 */
export async function demoLogin(context: PageContext): Promise<Response> {
  const network = clientNetwork(context.request);
  if (!network) context.onError(new Error('demo sign-in without CF-Connecting-IP'));
  const client = network ?? 'unknown';
  const { success } = await context.env.DEMO_LOGIN_LIMITER.limit({ key: `demo-login:${client}` });
  if (!success) {
    return tooManyRequests(
      'You started several demos in a short time. Please wait a minute and try again.',
      DEMO_LOGIN_RETRY_SECONDS,
    );
  }
  const checked = await checkedLoginForm(context);
  if ('refused' in checked) return checked.refused;
  const demo = await createDemoUser(context.db, context.now, {
    dailyCap: context.config.demoDailyCap,
    clientDailyCap: DEMO_CLIENT_DAILY_LIMIT,
    clientHash: await context.config.signer.sign('demo-client', client),
  });
  if ('refused' in demo) {
    const github = context.config.github ? ', or sign in with GitHub.' : '.';
    return tooManyRequests(
      demo.refused === 'client_cap'
        ? `This network started ${DEMO_CLIENT_DAILY_LIMIT} demos today, the most allowed. Please try again after midnight UTC${github}`
        : `Today's limit of new demos is reached. Please try again after midnight UTC${github}`,
      secondsUntilUtcMidnight(context.now),
    );
  }
  return startSession(
    context,
    { userId: demo.userId, kind: 'demo', expiresAt: demo.expiresAt.getTime() },
    checked.returnTo,
  );
}

interface GithubLoginState {
  state: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

function githubCallbackUrl(context: PageContext): string {
  return `${context.config.baseUrl}/login/github/callback`;
}

export async function githubLogin(context: PageContext): Promise<Response> {
  const github = context.config.github;
  if (!github) return errorPage(404, 'Not available', 'GitHub sign-in is not configured.');
  const checked = await checkedLoginForm(context);
  if ('refused' in checked) return checked.refused;
  const login: GithubLoginState = {
    state: randomToken(),
    verifier: randomToken(48),
    returnTo: checked.returnTo,
    expiresAt: context.now.getTime() + GITHUB_LOGIN_TTL_MS,
  };
  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    hostCookie(
      GITHUB_LOGIN_COOKIE,
      await context.config.signer.seal('github-login', login),
      GITHUB_LOGIN_TTL_MS / 1000,
    ),
  );
  const location = await githubAuthorizeUrl(github, {
    redirectUri: githubCallbackUrl(context),
    state: login.state,
    verifier: login.verifier,
  });
  return redirect(location, headers);
}

function isLoginState(value: unknown): value is GithubLoginState {
  if (typeof value !== 'object' || value === null) return false;
  const login = value as Record<string, unknown>;
  return (
    typeof login.state === 'string' &&
    typeof login.verifier === 'string' &&
    typeof login.returnTo === 'string' &&
    typeof login.expiresAt === 'number'
  );
}

export async function githubCallback(context: PageContext): Promise<Response> {
  const github = context.config.github;
  if (!github) return errorPage(404, 'Not available', 'GitHub sign-in is not configured.');
  const headers = new Headers();
  headers.append('Set-Cookie', hostCookie(GITHUB_LOGIN_COOKIE, '', 0));
  const login = await context.config.signer.unseal(
    'github-login',
    readCookie(context.request, GITHUB_LOGIN_COOKIE),
  );
  const params = context.url.searchParams;
  if (
    !isLoginState(login) ||
    login.expiresAt <= context.now.getTime() ||
    params.get('state') !== login.state
  ) {
    return errorPage(
      400,
      'Sign-in failed',
      'This GitHub sign-in expired. Please try again.',
      headers,
    );
  }
  const returnTo = safeReturnTo(context, login.returnTo);
  const code = params.get('code');
  if (!returnTo || !code) {
    return errorPage(400, 'Sign-in cancelled', 'GitHub sign-in did not finish.', headers);
  }
  try {
    const user = await fetchGithubUser(github, {
      code,
      redirectUri: githubCallbackUrl(context),
      verifier: login.verifier,
    });
    const userId = await signInGithubUser(context.db, user);
    return await startSession(
      context,
      { userId, kind: 'github', expiresAt: context.now.getTime() + SESSION_TTL_MS },
      returnTo,
      headers,
    );
  } catch (error) {
    if (error instanceof GithubSignInError) {
      return errorPage(502, 'Sign-in failed', error.message, headers);
    }
    throw error;
  }
}
