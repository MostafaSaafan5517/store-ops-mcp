/**
 * Where this server lets OAuth clients receive authorization codes. The OAuth provider already
 * holds every request to the client's own registered redirect URIs; this list narrows that to
 * the clients the demo is meant for.
 *
 * - Claude (claude.ai and the desktop app): its connector callback, exact match.
 * - ChatGPT: its stable connector callback, exact match. OpenAI documents that this one is
 *   used when the authorization server returns `iss` (RFC 9207), which this server does.
 * - Local apps (Claude Code, MCP Inspector): http on localhost or 127.0.0.1, any port and
 *   path. The provider matches the path exactly and the port loosely (RFC 8252).
 */
export const ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isAllowedRedirect(redirectUri: string): boolean {
  if ((ALLOWED_REDIRECT_URIS as readonly string[]).includes(redirectUri)) return true;
  if (!URL.canParse(redirectUri)) return false;
  const url = new URL(redirectUri);
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
}
