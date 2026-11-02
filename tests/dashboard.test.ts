import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { approveAction } from '../src/approvals.js';
import { withPrincipal } from '../src/db/principal.js';
import type { Principal } from '../src/db/types.js';
import { provisionDemoStore } from '../src/seed/provision.js';
import { DASHBOARD_URI, type DashboardData } from '../src/tools/dashboard.js';
import { addSampleOrder, openTestDatabase, USER_A, USER_B, type TestDatabase } from './helpers.js';
import { APPROVAL_BASE_URL, connectClient, textOf, type TestClient } from './mcp-client.js';

const START = new Date('2026-10-31T12:00:00Z');
const HOSTILE_NAME = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

let local: TestDatabase;
let storeA: Principal;
let storeB: Principal;
let clock = START;
let mcp: TestClient;
let tools: Tool[];
const serverErrors: unknown[] = [];

beforeAll(async () => {
  local = await openTestDatabase();
  storeA = await provisionDemoStore(local.app, USER_A, START);
  storeB = await provisionDemoStore(local.app, USER_B, START);
  await addSampleOrder(local, storeB, 9001);
  mcp = await connectClient(local.app, storeA, () => clock, { errors: serverErrors });
  tools = (await mcp.client.listTools()).tools;
});

afterAll(async () => {
  await mcp.close();
  await local.close();
  expect(serverErrors).toEqual([]);
});

const dashboard = (args: Record<string, unknown> = {}) =>
  mcp.data<DashboardData>('get_dashboard_data', args);

function toolNamed(name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe('dashboard tool listing', () => {
  it('links show_store_dashboard to the ui:// resource with default visibility', () => {
    const tool = toolNamed('show_store_dashboard');
    const ui = tool._meta?.ui as { resourceUri?: string; visibility?: string[] } | undefined;
    expect(ui?.resourceUri).toBe(DASHBOARD_URI);
    expect(ui?.visibility).toBeUndefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('marks get_dashboard_data as callable by the app only', () => {
    const tool = toolNamed('get_dashboard_data');
    expect(tool._meta?.ui).toEqual({ resourceUri: DASHBOARD_URI, visibility: ['app'] });
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('lists the ui:// resource with the MCP Apps mime type and an empty CSP', async () => {
    const { resources } = await mcp.client.listResources();
    const resource = resources.find((item) => item.uri === DASHBOARD_URI);
    expect(resource?.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource?._meta?.ui).toEqual({
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    });
  });
});

describe('the dashboard resource', () => {
  let html = '';
  let meta: unknown;

  beforeAll(async () => {
    const result = await mcp.client.readResource({ uri: DASHBOARD_URI });
    const content = result.contents[0];
    expect(content?.mimeType).toBe('text/html;profile=mcp-app');
    meta = content?._meta;
    html = content && 'text' in content ? content.text : '';
  });

  it('returns one self-contained HTML document with the empty CSP', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(meta).toEqual({
      ui: {
        csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
        prefersBorder: true,
      },
    });
    // Everything but the one inline script: no outside scripts, styles, fonts or images.
    const markup = html.replace(/<script>[\s\S]*<\/script>/, '<script></script>');
    expect(markup.match(/<script\b/g)).toHaveLength(1);
    expect(markup).not.toMatch(/\b(src|href)=/i);
    expect(markup).not.toMatch(/<link\b|<img\b|<iframe\b/i);
    expect(markup).not.toMatch(/@import|@font-face|url\(/i);
  });

  it("carries the server's own approval link prefix", () => {
    expect(html).toContain(
      `<meta name="store-ops-approval-prefix" content="${APPROVAL_BASE_URL}/approve/" />`,
    );
    expect(html).not.toContain('%%STORE_OPS_APPROVAL_PREFIX%%');
  });
});

describe('dashboard data', () => {
  it('matches get_sales_summary for the same period', async () => {
    for (const period of [7, 30, 90] as const) {
      const data = await dashboard({ period_days: period });
      const from = new Date(START.getTime() - (period - 1) * 86_400_000).toISOString().slice(0, 10);
      expect(data.period_days).toBe(period);
      expect(data.from).toBe(from);
      expect(data.to).toBe('2026-10-31');
      const summary = await mcp.data<Record<string, unknown>>('get_sales_summary', {
        from,
        to: '2026-10-31',
      });
      expect({ from: data.from, to: data.to, ...data.sales }).toEqual(summary);
    }
  });

  it('defaults to 30 days and labels the Demo Store', async () => {
    const data = await dashboard();
    expect(data.period_days).toBe(30);
    expect(data.store).toEqual({ label: 'Demo Store', name: 'Demo Store' });
    expect(data.sales.top_products.length).toBeLessThanOrEqual(5);
  });

  it('lists the 10 latest orders like list_orders', async () => {
    const data = await dashboard();
    const listed = await mcp.data<{
      orders: {
        order_number: number;
        customer_name: string;
        status: string;
        total_cents: number;
        placed_at: string;
      }[];
    }>('list_orders', { limit: 10 });
    expect(data.latest_orders).toEqual(
      listed.orders.map((order) => ({
        order_number: order.order_number,
        customer_name: order.customer_name,
        status: order.status,
        total_cents: order.total_cents,
        placed_at: order.placed_at,
      })),
    );
  });

  it('splits low stock and sold out products like get_stock_levels counts them', async () => {
    const data = await dashboard();
    const levels = await mcp.data<{
      summary: { low_stock_count: number; out_of_stock_count: number };
    }>('get_stock_levels', { limit: 1 });
    expect(data.stock.sold_out_count).toBe(levels.summary.out_of_stock_count);
    expect(data.stock.low_stock_count + data.stock.sold_out_count).toBe(
      levels.summary.low_stock_count,
    );
    for (const item of data.stock.low_stock) {
      expect(item.stock_on_hand).toBeGreaterThan(0);
      expect(item.stock_on_hand).toBeLessThanOrEqual(item.low_stock_threshold);
    }
    for (const item of data.stock.sold_out) expect(item.stock_on_hand).toBe(0);
    expect(data.stock.sold_out_count).toBeGreaterThan(0);
  });

  it("never shows another store's orders", async () => {
    const data = await dashboard({ period_days: 90 });
    expect(data.latest_orders.map((order) => order.order_number)).not.toContain(9001);
    const other = await connectClient(local.app, storeB, START);
    try {
      const otherData = await other.data<DashboardData>('get_dashboard_data');
      expect(otherData.latest_orders.map((order) => order.order_number)).toContain(9001);
      expect(otherData.sales).not.toEqual(data.sales);
    } finally {
      await other.close();
    }
  });

  it('rejects a store id, an unknown period and unknown fields', async () => {
    for (const args of [
      { store_id: storeB.storeId },
      { period_days: 14 },
      { period_days: '30' },
      { extra: true },
    ]) {
      for (const name of ['get_dashboard_data', 'show_store_dashboard']) {
        const result = await mcp.call(name, args);
        expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      }
    }
  });
});

describe('pending approvals on the dashboard', () => {
  async function prepareStockChange(quantity: number): Promise<string> {
    const result = await mcp.call('adjust_stock', {
      sku: (await dashboard()).stock.sold_out[0]?.sku ?? '',
      quantity_change: quantity,
      reason: 'Restock for the dashboard test',
    });
    const output = result.structuredContent as { status: string; approval_id: string };
    expect(output.status).toBe('approval_required');
    return output.approval_id;
  }

  it('shows a pending approval with its summary, times and approval link', async () => {
    const approvalId = await prepareStockChange(5);
    const data = await dashboard();
    const pending = data.pending_approvals.find((item) => item.approval_id === approvalId);
    expect(pending).toMatchObject({
      tool: 'adjust_stock',
      created_at: clock.toISOString(),
      expires_at: new Date(clock.getTime() + 10 * 60_000).toISOString(),
      approval_url: `${APPROVAL_BASE_URL}/approve/${approvalId}`,
    });
    expect(pending?.summary).toMatch(/^Change the stock of /);
  });

  it('drops an approval once it is decided, and one that expired', async () => {
    const decided = await prepareStockChange(2);
    const expiring = await prepareStockChange(3);
    await approveAction(local.app, storeA, decided, 'approve', clock);
    let ids = (await dashboard()).pending_approvals.map((item) => item.approval_id);
    expect(ids).not.toContain(decided);
    expect(ids).toContain(expiring);
    clock = new Date(clock.getTime() + 11 * 60_000);
    ids = (await dashboard()).pending_approvals.map((item) => item.approval_id);
    expect(ids).toEqual([]);
  });

  it("never shows another user's approvals", async () => {
    clock = START;
    const other = await connectClient(local.app, storeB, () => clock);
    try {
      const result = await other.call('adjust_stock', {
        sku: 'SKU-9001',
        quantity_change: 1,
        reason: 'Other store',
      });
      expect((result.structuredContent as { status: string }).status).toBe('approval_required');
      const mine = await dashboard();
      expect(mine.pending_approvals.map((item) => item.summary).join(' ')).not.toContain(
        'SKU-9001',
      );
      const theirs = await other.data<DashboardData>('get_dashboard_data');
      expect(theirs.pending_approvals).toHaveLength(1);
    } finally {
      await other.close();
    }
  });
});

describe('text fallback and untrusted text', () => {
  it('show_store_dashboard returns a short summary and the data as JSON', async () => {
    const result: CallToolResult = await mcp.call('show_store_dashboard', { period_days: 7 });
    expect(result.isError).toBeFalsy();
    const [summary, json] = result.content;
    expect(summary?.type === 'text' && summary.text).toMatch(/^Demo Store dashboard, last 7 days/);
    expect(json?.type === 'text' && JSON.parse(json.text)).toEqual(result.structuredContent);
  });

  it('returns a hostile customer name as plain data, and the summary never includes it', async () => {
    await withPrincipal(local.app, storeA, async (tx) => {
      await tx.query(
        `update store_ops.customers set name = $1
         where id = (select customer_id from store_ops.orders
                     order by placed_at desc, order_number desc limit 1)`,
        [HOSTILE_NAME],
      );
    });
    const result = await mcp.call('show_store_dashboard', {});
    const data = result.structuredContent as DashboardData;
    expect(data.latest_orders[0]?.customer_name).toBe(HOSTILE_NAME);
    expect(result.content[0]?.type === 'text' && result.content[0].text).not.toContain('<img');
    expect(textOf(result)).toContain(JSON.stringify(HOSTILE_NAME).slice(1, -1));
  });
});
