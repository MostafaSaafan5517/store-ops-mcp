import type { Client } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPROVAL_TTL_MS } from '../src/approvals.js';
import {
  BASE_URL,
  Browser,
  connectDemoUser,
  createHarness,
  hiddenField,
  mcpClient,
  type Harness,
} from './support/remote-harness.js';

let harness: Harness;
let client: Client;
let browser: Browser;
let sku: string;

beforeAll(async () => {
  harness = await createHarness();
  const connected = await connectDemoUser(harness);
  browser = connected.browser;
  client = await mcpClient(harness, connected.tokens.access_token);
  const stock = await client.callTool({ name: 'get_stock_levels', arguments: {} });
  const first = (stock.structuredContent as { products: { sku: string }[] }).products[0];
  if (!first) throw new Error('the demo store has no products');
  sku = first.sku;
});

afterAll(async () => {
  await client.close();
  await harness.close();
});

afterEach(() => {
  vi.useRealTimers();
});

let counter = 0;

async function prepare(): Promise<{ id: string; path: string; args: Record<string, unknown> }> {
  counter += 1;
  const args = { sku, quantity_change: counter, reason: `Approval page test ${counter}` };
  const result = await client.callTool({ name: 'adjust_stock', arguments: args });
  const id = (result.structuredContent as { approval_id: string }).approval_id;
  return { id, path: `/approve/${id}`, args };
}

async function open(path: string, as = browser): Promise<{ status: number; html: string }> {
  const response = await as.fetch(path);
  return { status: response.status, html: await response.text() };
}

async function decide(path: string, decision: string): Promise<{ status: number; html: string }> {
  const page = await open(path);
  const response = await browser.post(path, { csrf: hiddenField(page.html, 'csrf'), decision });
  return { status: response.status, html: await response.text() };
}

function heading(html: string): string {
  return /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? '';
}

describe('approval page', () => {
  it('asks a signed-out visitor to sign in and comes back to the approval', async () => {
    const { path } = await prepare();
    const visitor = new Browser(harness);
    const page = await open(path, visitor);
    expect(page.status).toBe(200);
    expect(heading(page.html)).toBe('Sign in');
    expect(hiddenField(page.html, 'return_to')).toBe(path);
  });

  it('shows the exact summary, the expiry and Approve and Reject buttons', async () => {
    const { path } = await prepare();
    const page = await open(path);
    expect(heading(page.html)).toBe('Approve this action?');
    expect(page.html).toMatch(new RegExp(`by [+]?${counter} units`));
    expect(page.html).toContain(`Approval page test ${counter}`);
    expect(page.html).toMatch(/Expires at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(page.html).toContain('value="approve"');
    expect(page.html).toContain('value="reject"');
    expect(page.html).toContain('Demo Store');
  });

  it('looks the same for an unknown id, a malformed id and another user', async () => {
    const { path } = await prepare();
    const other = await connectDemoUser(harness, 'store:read');
    const unknownId = '00000000-0000-4000-8000-0000000000ee';
    const pages = await Promise.all([
      open(`/approve/${unknownId}`),
      open('/approve/not-a-uuid'),
      open('/approve/%E0%A4%A'),
      open(path, other.browser),
    ]);
    for (const page of pages) {
      expect(page.status).toBe(404);
      expect(heading(page.html)).toBe('Approval not found');
    }
    expect(new Set(pages.map((page) => page.html)).size).toBe(1);
  });

  it('refuses a decision without CSRF, with a wrong token, or from another origin', async () => {
    const { path } = await prepare();
    const page = await open(path);
    const csrf = hiddenField(page.html, 'csrf');
    for (const [fields, origin] of [
      [{ decision: 'approve' }, BASE_URL],
      [{ csrf: `${csrf}x`, decision: 'approve' }, BASE_URL],
      [{ csrf, decision: 'approve' }, 'https://evil.example.com'],
    ] as const) {
      const response = await browser.post(path, fields, origin);
      expect(response.status).toBe(403);
    }
    expect(heading((await open(path)).html)).toBe('Approve this action?');
  });

  it("does not let another signed-in user decide someone's approval", async () => {
    const { path } = await prepare();
    const other = await connectDemoUser(harness);
    const otherClient = await mcpClient(harness, other.tokens.access_token);
    const own = await otherClient.callTool({ name: 'get_stock_levels', arguments: {} });
    const otherSku = (own.structuredContent as { products: { sku: string }[] }).products[0]?.sku;
    const prepared = await otherClient.callTool({
      name: 'adjust_stock',
      arguments: { sku: otherSku, quantity_change: 1, reason: 'Other user' },
    });
    const ownPath = `/approve/${(prepared.structuredContent as { approval_id: string }).approval_id}`;
    const csrf = hiddenField((await open(ownPath, other.browser)).html, 'csrf');
    const response = await other.browser.post(path, { csrf, decision: 'approve' });
    expect(response.status).toBe(404);
    expect(heading(await response.text())).toBe('Approval not found');
    expect(heading((await open(path)).html)).toBe('Approve this action?');
    await otherClient.close();
  });

  it('shows Rejected after a rejection, and the tool then refuses to run', async () => {
    const { id, path, args } = await prepare();
    const csrf = hiddenField((await open(path)).html, 'csrf');
    const rejected = await decide(path, 'reject');
    expect(heading(rejected.html)).toBe('Rejected');
    const result = await client.callTool({
      name: 'adjust_stock',
      arguments: { ...args, approval_id: id },
    });
    expect(result.isError).toBe(true);
    expect(heading((await open(path)).html)).toBe('Rejected');
    const again = await browser.post(path, { csrf, decision: 'approve' });
    expect(again.status).toBe(409);
    expect(heading(await again.text())).toBe('Rejected');
  });

  it('shows Already done once the action ran', async () => {
    const { id, path, args } = await prepare();
    expect(heading((await decide(path, 'approve')).html)).toBe('Approved');
    expect(heading((await open(path)).html)).toBe('Approved');
    const result = await client.callTool({
      name: 'adjust_stock',
      arguments: { ...args, approval_id: id },
    });
    expect(result.isError).toBeFalsy();
    expect(heading((await open(path)).html)).toBe('Already done');
  });

  it('shows an expired approval as expired and refuses to approve it', async () => {
    const { path } = await prepare();
    const csrf = hiddenField((await open(path)).html, 'csrf');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + APPROVAL_TTL_MS + 1000 });
    const page = await open(path);
    expect(heading(page.html)).toBe('This approval expired');
    expect(page.html).not.toContain('value="approve"');
    const response = await browser.post(path, { csrf, decision: 'approve' });
    expect(response.status).toBe(409);
    expect(heading(await response.text())).toBe('This approval expired');
  });
});
