import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createHarness, MCP_URL, type Harness } from './support/remote-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('remote server discovery', () => {
  it('serves protected resource metadata whose resource is exactly the MCP URL', async () => {
    const response = await harness.fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.resource).toBe(MCP_URL);
    expect(metadata.authorization_servers).toEqual([BASE_URL]);
    expect(metadata.scopes_supported).toEqual(['store:read']);
    expect(metadata.bearer_methods_supported).toEqual(['header']);
  });

  it('serves authorization server metadata with CIMD, PKCE S256, DCR and iss support', async () => {
    const response = await harness.fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(BASE_URL);
    expect(metadata.authorization_endpoint).toBe(`${BASE_URL}/authorize`);
    expect(metadata.token_endpoint).toBe(`${BASE_URL}/token`);
    expect(metadata.registration_endpoint).toBe(`${BASE_URL}/register`);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    expect(metadata.scopes_supported).toEqual(['store:read', 'store:write', 'refunds:write']);
    expect(metadata.response_types_supported).toEqual(['code']);
    expect(metadata.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
  });

  it('answers an MCP request without a token with a real 401 challenge', async () => {
    const response = await harness.fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('scope="store:read"');
  });

  it('answers an unknown token with 401 invalid_token', async () => {
    const response = await harness.fetch(MCP_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('shows a home page with the MCP URL and the demo label', async () => {
    const response = await harness.fetch(`${BASE_URL}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(MCP_URL);
    expect(html).toContain('Demo Store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});
