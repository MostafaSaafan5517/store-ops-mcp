import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/remote/html.js';
import { scopesForRequest } from '../src/remote/scopes.js';
import {
  BASE_URL,
  connectDemoUser,
  createHarness,
  hiddenField,
  MCP_URL,
  mcpClient,
  type Harness,
} from './support/remote-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

const RESOURCE_METADATA = `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`;

function rawCall(
  accessToken: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return harness.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('scopes per tool', () => {
  it('maps every tool to the scopes it needs', () => {
    const none = new Headers();
    expect(scopesForRequest(toolCall('list_orders'), none)).toEqual(['store:read']);
    for (const tool of ['adjust_stock', 'cancel_order', 'add_order_note']) {
      expect(scopesForRequest(toolCall(tool), none)).toEqual(['store:read', 'store:write']);
    }
    expect(scopesForRequest(toolCall('issue_refund'), none)).toEqual([
      'store:read',
      'store:write',
      'refunds:write',
    ]);
    expect(scopesForRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, none)).toEqual([
      'store:read',
    ]);
    expect(scopesForRequest(toolCall('toString'), none)).toEqual(['store:read']);
  });

  it('lets a store:read token list tools and call read tools', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    const client = await mcpClient(harness, tokens.access_token);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('issue_refund');
    const result = await client.callTool({
      name: 'get_stock_levels',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('answers a write tool without store:write with one 403 naming every scope it needs', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    const response = await rawCall(tokens.access_token, toolCall('adjust_stock'), {
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'adjust_stock',
    });
    expect(response.status).toBe(403);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="store:read store:write"');
    expect(challenge).toContain(RESOURCE_METADATA);
  });

  it('asks for refunds:write as well for issue_refund', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read store:write');
    const response = await rawCall(tokens.access_token, toolCall('issue_refund'));
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="store:read store:write refunds:write"',
    );
  });

  it('uses the stricter of the body and the Mcp-Name header', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    const response = await rawCall(tokens.access_token, toolCall('list_orders'), {
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'issue_refund',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="store:read store:write refunds:write"',
    );
  });

  it('checks every message of a batch', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    const response = await rawCall(tokens.access_token, [
      toolCall('list_orders'),
      { ...toolCall('cancel_order'), id: 2 },
    ]);
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('scope="store:read store:write"');
  });
});

describe('request size', () => {
  it('refuses a body over the SDK limit even without Content-Length', async () => {
    const { tokens } = await connectDemoUser(harness, 'store:read');
    const chunk = new TextEncoder().encode(' '.repeat(1024 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) controller.close();
        else controller.enqueue(chunk);
        sent += 1;
      },
    });
    const response = await harness.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
      body: stream,
      duplex: 'half',
    });
    expect(response.status).toBe(413);
  });
});

describe('tools through the Worker', () => {
  it('runs a read tool, then a write tool approved on the approval page', async () => {
    const { tokens, browser } = await connectDemoUser(harness);
    const client = await mcpClient(harness, tokens.access_token);
    const call = async (name: string, args: Record<string, unknown>) =>
      await client.callTool({ name, arguments: args });

    const stock = await call('get_stock_levels', {});
    expect(stock.isError).toBeFalsy();
    const product = (
      stock.structuredContent as { products: { sku: string; stock_on_hand: number }[] }
    ).products[0];
    if (!product) throw new Error('the demo store has no products');

    const args = { sku: product.sku, quantity_change: 5, reason: 'Restock from supplier' };
    const prepared = await call('adjust_stock', args);
    const output = prepared.structuredContent as {
      status: string;
      approval_id: string;
      summary: string;
      approval: { approval_url: string } | null;
    };
    expect(output.status).toBe('approval_required');
    expect(output.approval?.approval_url).toBe(`${BASE_URL}/approve/${output.approval_id}`);

    const notYet = await call('adjust_stock', { ...args, approval_id: output.approval_id });
    expect(notYet.isError).toBe(true);

    const page = await browser.fetch(output.approval?.approval_url ?? '');
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Approve this action?');
    expect(html).toContain(escapeHtml(output.summary));
    expect(html).toContain('Expires at:');
    const approved = await browser.post(new URL(output.approval?.approval_url ?? '').pathname, {
      csrf: hiddenField(html, 'csrf'),
      decision: 'approve',
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain('<h1>Approved</h1>');

    const executed = await call('adjust_stock', { ...args, approval_id: output.approval_id });
    expect(executed.isError).toBeFalsy();
    expect((executed.structuredContent as { status: string }).status).toBe('executed');

    const after = await call('get_stock_levels', {});
    const updated = (
      after.structuredContent as { products: { sku: string; stock_on_hand: number }[] }
    ).products.find((item) => item.sku === product.sku);
    expect(updated?.stock_on_hand).toBe(product.stock_on_hand + 5);
    await client.close();
    expect(harness.errors).toEqual([]);
  });

  it('keeps each user in their own store', async () => {
    const first = await connectDemoUser(harness, 'store:read');
    const second = await connectDemoUser(harness, 'store:read');
    const a = await harness.env.OAUTH_PROVIDER?.unwrapToken<{ storeId: string }>(
      first.tokens.access_token,
    );
    const b = await harness.env.OAUTH_PROVIDER?.unwrapToken<{ storeId: string }>(
      second.tokens.access_token,
    );
    expect(a?.grant.props.storeId).toBeTruthy();
    expect(a?.grant.props.storeId).not.toBe(b?.grant.props.storeId);
  });
});
