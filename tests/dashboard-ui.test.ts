import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDashboardHtml, GENERATED_FILE, generatedModule } from '../scripts/build-ui.js';
import { INSTRUCTION_LIKE_NOTE } from '../src/seed/catalog.js';
import { approvalUrlFrom } from '../src/approvals.js';
import {
  APPROVAL_PREFIX_PLACEHOLDER,
  dashboardHtml,
  type DashboardData,
} from '../src/tools/dashboard.js';
import type { ToolContext } from '../src/tools/shared.js';
import { DASHBOARD_HTML } from '../src/ui/dashboard-html.generated.js';

const PREFIX = 'https://store-ops.example.com/approve/';
const APPROVAL_ID = '6a1f2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const HOSTILE_NAME = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
const HOSTILE_PRODUCT = '<b onmouseover="window.pwned=3">Mug</b>';

function fixture(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    store: { label: 'Demo Store', name: 'Demo Store' },
    period_days: 30,
    from: '2026-10-02',
    to: '2026-10-31',
    generated_at: '2026-10-31T12:00:00.000Z',
    sales: {
      currency: 'USD',
      order_count: 2,
      gross_sales_cents: 5000,
      refunds_cents: 1000,
      net_sales_cents: 4000,
      average_order_value_cents: 2500,
      orders_by_status: {
        pending: 1,
        paid: 1,
        fulfilled: 1,
        cancelled: 0,
        partially_refunded: 0,
        refunded: 0,
      },
      top_products: [{ sku: 'MUG-1', name: HOSTILE_PRODUCT, units_sold: 3, revenue_cents: 3600 }],
    },
    latest_orders: [
      {
        order_number: 1067,
        customer_name: HOSTILE_NAME,
        status: 'paid',
        total_cents: 2500,
        placed_at: '2026-10-30T10:00:00.000Z',
      },
    ],
    stock: {
      low_stock: [
        { sku: 'MUG-1', name: HOSTILE_PRODUCT, stock_on_hand: 2, low_stock_threshold: 5 },
      ],
      sold_out: [],
      low_stock_count: 1,
      sold_out_count: 0,
    },
    pending_approvals: [
      {
        approval_id: APPROVAL_ID,
        tool: 'add_order_note',
        summary: `Add a note to order #1067: ${INSTRUCTION_LIKE_NOTE}`,
        created_at: '2026-10-31T11:58:00.000Z',
        expires_at: '2026-10-31T12:08:00.000Z',
        approval_url: `${PREFIX}${APPROVAL_ID}`,
      },
      {
        approval_id: '7a1f2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
        tool: 'adjust_stock',
        summary: 'A link that points somewhere else',
        created_at: '2026-10-31T11:59:00.000Z',
        expires_at: '2026-10-31T12:09:00.000Z',
        approval_url: 'https://evil.example.net/approve/7a1f2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      },
    ],
    ...overrides,
  };
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/** A minimal MCP Apps host: answers the view's JSON-RPC messages over postMessage. */
class FakeHost {
  readonly window: Window;
  readonly received: RpcMessage[] = [];
  openLinkResult: Record<string, unknown> = {};
  toolResult: () => Record<string, unknown> = () => ({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: fixture({ period_days: 7 }),
  });

  constructor() {
    this.window = new Window({
      url: 'https://sandbox.example.org/',
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    const host = { postMessage: (message: RpcMessage) => this.answer(message) };
    Object.defineProperty(this.window, 'parent', { value: host, configurable: true });
    this.source = host;
  }

  private readonly source: unknown;

  deliver(message: Record<string, unknown>): void {
    const event = new this.window.MessageEvent('message', {
      data: { jsonrpc: '2.0', ...message },
      source: this.source as never,
    });
    this.window.dispatchEvent(event);
  }

  private answer(message: RpcMessage): void {
    this.received.push(message);
    if (message.id === undefined) return;
    const reply = (result: Record<string, unknown>) =>
      setTimeout(() => this.deliver({ id: message.id, result }), 0);
    if (message.method === 'ui/initialize') {
      reply({
        protocolVersion: message.params?.protocolVersion,
        hostInfo: { name: 'fake-host', version: '0.0.0' },
        hostCapabilities: { openLinks: {}, serverTools: {} },
        hostContext: {
          theme: 'dark',
          styles: { variables: { '--color-background-primary': 'rgb(1, 2, 3)' } },
        },
      });
    } else if (message.method === 'tools/call') {
      reply(this.toolResult());
    } else if (message.method === 'ui/open-link') {
      reply(this.openLinkResult);
    } else {
      reply({});
    }
  }

  requests(method: string): RpcMessage[] {
    return this.received.filter((message) => message.method === method);
  }

  async load(html: string): Promise<void> {
    this.window.document.write(html);
    await this.until(() => this.requests('ui/notifications/initialized').length === 1);
  }

  async until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the view');
  }

  get document() {
    return this.window.document;
  }

  /** The visible text: the body without the inline script (which holds the UI strings). */
  text(): string {
    return [...this.document.body.children]
      .filter((element) => element.tagName !== 'SCRIPT')
      .map((element) => element.textContent)
      .join(' ');
  }

  buttons(label: string) {
    return [...this.document.querySelectorAll('button')].filter(
      (button) => button.textContent === label,
    );
  }
}

describe('dashboard build', () => {
  it('the committed HTML module matches a fresh build (run pnpm build:ui)', async () => {
    const committed = readFileSync(GENERATED_FILE, 'utf8');
    expect(committed === generatedModule(await buildDashboardHtml())).toBe(true);
  });

  it('keeps $ patterns in a base URL literal', () => {
    const html = dashboardHtml({
      approvals: { url: approvalUrlFrom("https://store-ops.example.com/a$'b$&/") },
    } as ToolContext);
    expect(html).toContain(`content="https://store-ops.example.com/a$&#39;b$&#38;/approve/"`);
    expect(html.length).toBeLessThan(DASHBOARD_HTML.length + 100);
  });

  it('is ASCII only and has one approval prefix slot', () => {
    expect(readFileSync(GENERATED_FILE, 'utf8')).toMatch(/^[\x20-\x7e\n]*$/);
    expect(DASHBOARD_HTML.split(APPROVAL_PREFIX_PLACEHOLDER)).toHaveLength(2);
  });
});

describe('dashboard view in a fake host', () => {
  let host: FakeHost;

  beforeEach(async () => {
    host = new FakeHost();
    await host.load(DASHBOARD_HTML.replace(APPROVAL_PREFIX_PLACEHOLDER, PREFIX));
    host.deliver({
      method: 'ui/notifications/tool-result',
      params: { content: [{ type: 'text', text: 'summary' }], structuredContent: fixture() },
    });
    await host.until(() => host.text().includes('Latest orders'));
  });

  afterEach(async () => {
    await host.window.happyDOM.close();
  });

  it('applies the host theme and style variables', () => {
    const root = host.document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.getPropertyValue('--color-background-primary')).toBe('rgb(1, 2, 3)');
  });

  it('renders store text as inert text: no element, attribute or script comes from it', () => {
    const { document } = host;
    expect(host.text()).toContain(HOSTILE_NAME);
    expect(host.text()).toContain(HOSTILE_PRODUCT);
    expect(host.text()).toContain(INSTRUCTION_LIKE_NOTE);
    expect(document.querySelectorAll('img, b, iframe, object, embed, a')).toHaveLength(0);
    expect(document.querySelectorAll('script')).toHaveLength(1);
    const handlers = [...document.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].filter((attribute) => attribute.name.startsWith('on')),
    );
    expect(handlers).toEqual([]);
    expect((host.window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('shows the sales cards and the latest orders table', () => {
    expect(host.text()).toContain('Net sales');
    expect(host.text()).toContain('$40.00');
    const rows = [...host.document.querySelectorAll('table tbody tr')].map(
      (row) => row.textContent,
    );
    expect(rows.some((row) => row.includes('#1067') && row.includes('$25.00'))).toBe(true);
  });

  it('opens only the approval page on this server, through the host', async () => {
    const buttons = host.buttons('Open approval page');
    expect(buttons).toHaveLength(1);
    buttons[0]?.click();
    await host.until(() => host.requests('ui/open-link').length === 1);
    expect(host.requests('ui/open-link')[0]?.params).toEqual({ url: `${PREFIX}${APPROVAL_ID}` });
    expect(host.text()).toContain(
      'https://evil.example.net/approve/7a1f2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    );
    expect(host.text()).toContain('This link is not on this server');
  });

  it('shows the link as text when the host refuses to open it', async () => {
    host.openLinkResult = { isError: true };
    host.buttons('Open approval page')[0]?.click();
    await host.until(() => host.text().includes('The host did not open the link.'));
    expect(host.text()).toContain(`${PREFIX}${APPROVAL_ID}`);
  });

  it('has no approve button', () => {
    const labels = [...host.document.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels.some((label) => /approve|reject/i.test(label))).toBe(false);
  });

  it('switches the period and refreshes through get_dashboard_data', async () => {
    host.buttons('7 days')[0]?.click();
    await host.until(() => host.requests('tools/call').length === 1);
    expect(host.requests('tools/call')[0]?.params).toMatchObject({
      name: 'get_dashboard_data',
      arguments: { period_days: 7 },
    });
    await host.until(() => host.text().includes('last 7 days'));
    expect(host.buttons('7 days')[0]?.getAttribute('aria-pressed')).toBe('true');

    host.toolResult = () => ({
      content: [{ type: 'text', text: 'This demo expired.' }],
      isError: true,
    });
    host.buttons('Refresh')[0]?.click();
    await host.until(() => host.requests('tools/call').length === 2);
    expect(host.requests('tools/call')[1]?.params).toMatchObject({
      name: 'get_dashboard_data',
      arguments: { period_days: 7 },
    });
    await host.until(() => host.text().includes('This demo expired.'));
  });
});

describe('dashboard view with a bad approval prefix', () => {
  it('opens nothing when the page has no valid prefix', async () => {
    const host = new FakeHost();
    await host.load(DASHBOARD_HTML.replace(APPROVAL_PREFIX_PLACEHOLDER, 'javascript:alert(1)//'));
    host.deliver({
      method: 'ui/notifications/tool-result',
      params: { content: [], structuredContent: fixture() },
    });
    await host.until(() => host.text().includes('Latest orders'));
    expect(host.buttons('Open approval page')).toHaveLength(0);
    expect(host.text()).toContain(`${PREFIX}${APPROVAL_ID}`);
    await host.window.happyDOM.close();
  });
});
