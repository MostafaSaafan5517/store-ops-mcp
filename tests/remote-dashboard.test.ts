import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRemoteConfig } from '../src/remote/config.js';
import { serveMcp } from '../src/remote/mcp-endpoint.js';
import { scopesForRequest, scopesForTool } from '../src/remote/scopes.js';
import type { DashboardData } from '../src/tools/dashboard.js';
import { USER_A } from './helpers.js';
import {
  BASE_URL,
  connectDemoUser,
  createHarness,
  MCP_URL,
  mcpClient,
  type Harness,
} from './support/remote-harness.js';

const DASHBOARD_TOOLS = ['show_store_dashboard', 'get_dashboard_data'];

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

const toolCall = (name: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('dashboard tools on the remote server', () => {
  it('both need store:read, like every read tool', () => {
    for (const name of DASHBOARD_TOOLS) {
      expect(scopesForTool(name)).toEqual(['store:read']);
      expect(scopesForRequest(toolCall(name), new Headers())).toEqual(['store:read']);
    }
  });

  it('refuses both with a 403 for a token without store:read', async () => {
    const config = readRemoteConfig(harness.env, {});
    for (const name of DASHBOARD_TOOLS) {
      const response = await serveMcp(
        new Request(MCP_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': name,
          },
          body: JSON.stringify(toolCall(name)),
        }),
        {
          env: harness.env,
          context: {
            props: { userId: USER_A, storeId: crypto.randomUUID() },
            auth: { token: 'test-token', audience: MCP_URL, scope: [] },
          },
          config,
          db: harness.local.app,
          now: () => new Date(),
          onError: (error) => harness.errors.push(error),
        },
      );
      expect(response.status, name).toBe(403);
      const challenge = response.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain('scope="store:read"');
    }
  });

  it('serves the dashboard to a store:read token, with links to this server', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read store:write');
    const client = await mcpClient(harness, tokens.access_token);
    try {
      const listed = await client.listTools();
      const appTool = listed.tools.find((tool) => tool.name === 'get_dashboard_data');
      expect(appTool?._meta?.ui).toEqual({
        resourceUri: 'ui://store-ops/dashboard',
        visibility: ['app'],
      });

      const prepared = await client.callTool({
        name: 'add_order_note',
        arguments: { order_number: 1001, note: 'Dashboard check' },
      });
      const approvalId = (prepared.structuredContent as { approval_id: string }).approval_id;

      const result = await client.callTool({ name: 'get_dashboard_data', arguments: {} });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as DashboardData;
      expect(data.store.label).toBe('Demo Store');
      expect(data.pending_approvals.map((item) => item.approval_url)).toEqual([
        `${BASE_URL}/approve/${approvalId}`,
      ]);

      const resource = await client.readResource({ uri: 'ui://store-ops/dashboard' });
      const html =
        resource.contents[0] && 'text' in resource.contents[0] ? resource.contents[0].text : '';
      expect(html).toContain(`content="${BASE_URL}/approve/"`);
    } finally {
      await client.close();
    }
    expect(harness.errors).toEqual([]);
  });
});
