import { isUuid } from '../db/principal.js';
import type { Principal } from '../db/types.js';

const SESSION_COOKIE = '__Host-store-ops-session';
const CSRF_COOKIE = '__Host-store-ops-csrf';

/** How long a browser sign-in lasts (demo users stop earlier, at their expiry). */
export const SESSION_TTL_MS = 12 * 60 * 60_000;

export interface Session extends Principal {
  kind: 'github' | 'demo';
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Signs and checks small values with HMAC-SHA-256 under the Worker's SESSION_SECRET. */
export class Signer {
  readonly #key: ReturnType<typeof crypto.subtle.importKey>;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    this.#key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }

  async sign(purpose: string, value: string): Promise<string> {
    const data = new TextEncoder().encode(`${purpose}\n${value}`);
    return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await this.#key, data)));
  }

  /** Constant-time check (crypto.subtle.verify). */
  async verify(purpose: string, value: string, signature: string): Promise<boolean> {
    const bytes = fromBase64Url(signature);
    if (!bytes) return false;
    const data = new TextEncoder().encode(`${purpose}\n${value}`);
    return crypto.subtle.verify('HMAC', await this.#key, bytes, data);
  }

  /** `<base64url JSON>.<signature>` */
  async seal(purpose: string, payload: unknown): Promise<string> {
    const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    return `${body}.${await this.sign(purpose, body)}`;
  }

  async unseal(purpose: string, sealed: string | undefined): Promise<unknown> {
    if (!sealed) return undefined;
    const [body, signature, extra] = sealed.split('.');
    if (body === undefined || signature === undefined || extra !== undefined) return undefined;
    if (!(await this.verify(purpose, body, signature))) return undefined;
    const bytes = fromBase64Url(body);
    if (!bytes) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return undefined;
    }
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** A `__Host-` cookie: Secure, host-only, Path=/, HttpOnly, SameSite=Lax. */
export function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export async function readSession(
  signer: Signer,
  request: Request,
  now: Date,
): Promise<Session | undefined> {
  const payload = (await signer.unseal('session', readCookie(request, SESSION_COOKIE))) as
    Partial<Session> | undefined;
  if (
    !payload ||
    typeof payload.userId !== 'string' ||
    !isUuid(payload.userId) ||
    typeof payload.storeId !== 'string' ||
    !isUuid(payload.storeId) ||
    (payload.kind !== 'github' && payload.kind !== 'demo') ||
    typeof payload.expiresAt !== 'number' ||
    payload.expiresAt <= now.getTime()
  ) {
    return undefined;
  }
  return {
    userId: payload.userId,
    storeId: payload.storeId,
    kind: payload.kind,
    expiresAt: payload.expiresAt,
  };
}

export async function sessionCookie(signer: Signer, session: Session, now: Date): Promise<string> {
  const value = await signer.seal('session', session);
  return hostCookie(SESSION_COOKIE, value, (session.expiresAt - now.getTime()) / 1000);
}

export function clearSessionCookie(): string {
  return hostCookie(SESSION_COOKIE, '', 0);
}

/**
 * CSRF protection for every form POST: a random value in a `__Host-` cookie, and in the form
 * an HMAC of it. A cross-site page can neither read the cookie nor compute the HMAC. POSTs
 * must also come from our own origin when the browser sends `Origin`.
 */
export class Csrf {
  constructor(
    private readonly signer: Signer,
    private readonly origin: string,
  ) {}

  /** The token for forms on this page, and a cookie to set when the browser has none yet. */
  async issue(request: Request): Promise<{ token: string; setCookie?: string }> {
    const existing = readCookie(request, CSRF_COOKIE);
    const value = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken();
    const token = await this.signer.sign('csrf', value);
    return value === existing
      ? { token }
      : { token, setCookie: hostCookie(CSRF_COOKIE, value, 24 * 60 * 60) };
  }

  async check(request: Request, form: FormData): Promise<boolean> {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== this.origin) return false;
    const value = readCookie(request, CSRF_COOKIE);
    const token = form.get('csrf');
    if (!value || typeof token !== 'string') return false;
    return this.signer.verify('csrf', value, token);
  }
}
