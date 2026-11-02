import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { WRITE_TOOLS } from '../approvals.js';
import { DEMO_STORE_NAME } from '../config.js';
import type { SqlClient } from '../db/types.js';
import { ORDER_STATUSES } from '../domain.js';
import { escapeHtml } from '../remote/html.js';
import { DASHBOARD_HTML } from '../ui/dashboard-html.generated.js';
import { isoDate, salesForRange, salesShape } from './sales.js';
import {
  centsSchema,
  jsonResult,
  READ_ONLY,
  toInt,
  toIso,
  toolErrorResult,
  UNTRUSTED_NOTE,
  withOpenStore,
  type ToolContext,
} from './shared.js';

export const DASHBOARD_URI = 'ui://store-ops/dashboard';

/** Replaced in the HTML when the resource is read; the app only opens links under it. */
export const APPROVAL_PREFIX_PLACEHOLDER = '%%STORE_OPS_APPROVAL_PREFIX%%';

const DAY_MS = 86_400_000;
const LATEST_ORDER_COUNT = 10;
const STOCK_LIST_LIMIT = 20;

/**
 * No external requests at all: every domain list is empty, so hosts apply their strictest
 * policy (no fetch, no outside scripts, styles, fonts, images or frames).
 */
export const DASHBOARD_CSP = {
  connectDomains: [],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
};

const RESOURCE_UI_META = { csp: DASHBOARD_CSP, prefersBorder: true };

const dashboardInput = z.strictObject({
  period_days: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .default(30)
    .describe('Days of sales to show, including today (7, 30 or 90; default 30).'),
});

const stockItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  stock_on_hand: z.number().int(),
  low_stock_threshold: z.number().int(),
});

export const dashboardOutput = z.object({
  store: z.object({ label: z.literal(DEMO_STORE_NAME), name: z.string() }),
  period_days: z.number().int(),
  from: z.string(),
  to: z.string(),
  generated_at: z.string(),
  sales: z.object(salesShape),
  latest_orders: z.array(
    z.object({
      order_number: z.number().int(),
      customer_name: z.string(),
      status: z.enum(ORDER_STATUSES),
      total_cents: centsSchema,
      placed_at: z.string(),
    }),
  ),
  stock: z.object({
    low_stock: z.array(stockItemSchema).describe('In stock but at or below the threshold.'),
    sold_out: z.array(stockItemSchema),
    low_stock_count: z.number().int(),
    sold_out_count: z.number().int(),
  }),
  pending_approvals: z
    .array(
      z.object({
        approval_id: z.string(),
        tool: z.enum(WRITE_TOOLS),
        summary: z.string(),
        created_at: z.string(),
        expires_at: z.string(),
        approval_url: z.string(),
      }),
    )
    .describe("This user's pending, unexpired approvals in this store, newest first."),
});

export type DashboardData = z.infer<typeof dashboardOutput>;

async function readDashboard(
  context: ToolContext,
  tx: SqlClient,
  now: Date,
  periodDays: number,
): Promise<DashboardData> {
  const to = isoDate(now);
  const from = isoDate(new Date(now.getTime() - (periodDays - 1) * DAY_MS));
  const store = await tx.query<{ name: string }>('select name from store_ops.stores');
  const latest = await tx.query<{
    order_number: number;
    customer_name: string;
    status: (typeof ORDER_STATUSES)[number];
    total_cents: number;
    placed_at: unknown;
  }>(
    `select o.order_number, c.name as customer_name, o.status, o.total_cents, o.placed_at
     from store_ops.orders o join store_ops.customers c on c.id = o.customer_id
     order by o.placed_at desc, o.order_number desc
     limit $1`,
    [LATEST_ORDER_COUNT],
  );
  const stock = await tx.query<z.infer<typeof stockItemSchema> & { sold_out: boolean }>(
    `(select sku, name, stock_on_hand, low_stock_threshold, false as sold_out
      from store_ops.products
      where active and stock_on_hand > 0 and stock_on_hand <= low_stock_threshold
      order by stock_on_hand, sku limit $1)
     union all
     (select sku, name, stock_on_hand, low_stock_threshold, true as sold_out
      from store_ops.products
      where active and stock_on_hand = 0
      order by sku limit $1)`,
    [STOCK_LIST_LIMIT],
  );
  const counts = await tx.query<Record<string, unknown>>(
    `select count(*) filter (where stock_on_hand > 0 and stock_on_hand <= low_stock_threshold)
              as low_stock_count,
            count(*) filter (where stock_on_hand = 0) as sold_out_count
     from store_ops.products where active`,
  );
  // RLS already limits approvals to this user and store; the filter keeps the intent visible.
  const approvals = await tx.query<{
    id: string;
    tool: (typeof WRITE_TOOLS)[number];
    summary: { text: string };
    created_at: unknown;
    expires_at: unknown;
  }>(
    `select id, tool, summary, created_at, expires_at from store_ops.approvals
     where status = 'pending' and expires_at > $1
       and user_id = store_ops.current_user_id()
     order by created_at desc, id
     limit 20`,
    [now.toISOString()],
  );

  const stockItem = (row: z.infer<typeof stockItemSchema>) => ({
    sku: row.sku,
    name: row.name,
    stock_on_hand: row.stock_on_hand,
    low_stock_threshold: row.low_stock_threshold,
  });
  const countRow = counts.rows[0] ?? {};
  return {
    store: { label: DEMO_STORE_NAME, name: store.rows[0]?.name ?? DEMO_STORE_NAME },
    period_days: periodDays,
    from,
    to,
    generated_at: now.toISOString(),
    sales: await salesForRange(tx, from, to),
    latest_orders: latest.rows.map((row) => ({
      order_number: row.order_number,
      customer_name: row.customer_name,
      status: row.status,
      total_cents: row.total_cents,
      placed_at: toIso(row.placed_at),
    })),
    stock: {
      low_stock: stock.rows.filter((row) => !row.sold_out).map(stockItem),
      sold_out: stock.rows.filter((row) => row.sold_out).map(stockItem),
      low_stock_count: toInt(countRow.low_stock_count),
      sold_out_count: toInt(countRow.sold_out_count),
    },
    pending_approvals: approvals.rows.map((row) => ({
      approval_id: row.id,
      tool: row.tool,
      summary: row.summary.text,
      created_at: toIso(row.created_at),
      expires_at: toIso(row.expires_at),
      approval_url: context.approvals.url(row.id),
    })),
  };
}

function dollars(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/** A short text answer for clients that do not render MCP Apps. Holds no customer text. */
export function dashboardText(data: DashboardData): string {
  const { sales } = data;
  const lines = [
    `${data.store.label} dashboard, last ${data.period_days} days (${data.from} to ${data.to}, UTC).`,
    `Sales: ${sales.order_count} orders, gross ${dollars(sales.gross_sales_cents, sales.currency)}, refunds ${dollars(sales.refunds_cents, sales.currency)}, net ${dollars(sales.net_sales_cents, sales.currency)}, average order ${dollars(sales.average_order_value_cents, sales.currency)}.`,
    `Stock: ${data.stock.low_stock_count} products low on stock, ${data.stock.sold_out_count} sold out.`,
    data.pending_approvals.length === 0
      ? 'No actions are waiting for approval.'
      : `${data.pending_approvals.length} action(s) waiting for approval: ${data.pending_approvals
          .map((approval) => `${approval.tool} (${approval.approval_url})`)
          .join(', ')}.`,
    'Approvals happen only on the approval page. The full data follows as JSON.',
  ];
  return lines.join('\n');
}

async function dashboardResult(
  context: ToolContext,
  input: z.infer<typeof dashboardInput>,
  withSummary: boolean,
): Promise<CallToolResult> {
  try {
    const data = await withOpenStore(context, (tx, now) =>
      readDashboard(context, tx, now, input.period_days),
    );
    if (!withSummary) return jsonResult(data);
    return {
      content: [
        { type: 'text', text: dashboardText(data) },
        { type: 'text', text: JSON.stringify(data) },
      ],
      structuredContent: data,
    };
  } catch (error) {
    return toolErrorResult(context, error);
  }
}

/** The dashboard HTML with the approval link prefix the app may open. */
export function dashboardHtml(context: ToolContext): string {
  // A replacer function, so `$'` and similar in a configured base URL stay literal.
  const prefix = escapeHtml(context.approvals.url(''));
  return DASHBOARD_HTML.replace(APPROVAL_PREFIX_PLACEHOLDER, () => prefix);
}

export function registerDashboardTools(server: McpServer, context: ToolContext): void {
  registerAppResource(
    server,
    'Store dashboard',
    DASHBOARD_URI,
    {
      description: 'Interactive dashboard for the current Demo Store (MCP App).',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: RESOURCE_UI_META },
    },
    () => ({
      contents: [
        {
          uri: DASHBOARD_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: dashboardHtml(context),
          _meta: { ui: RESOURCE_UI_META },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    'show_store_dashboard',
    {
      title: 'Show store dashboard',
      description:
        'Shows an interactive dashboard for the current store: sales for the last 7, 30 or 90 days, order counts by status, the 10 latest orders, low stock and sold out products, and actions waiting for approval with links to the approval page. ' +
        'Clients without MCP Apps get a short text summary and the same data as JSON. The dashboard never approves anything. ' +
        UNTRUSTED_NOTE,
      inputSchema: dashboardInput,
      outputSchema: dashboardOutput,
      annotations: READ_ONLY,
      _meta: { ui: { resourceUri: DASHBOARD_URI } },
    },
    (input) => dashboardResult(context, input, true),
  );

  registerAppTool(
    server,
    'get_dashboard_data',
    {
      title: 'Get dashboard data',
      description:
        'Data for the store dashboard app (refresh and period switch). Same data as show_store_dashboard. ' +
        UNTRUSTED_NOTE,
      inputSchema: dashboardInput,
      outputSchema: dashboardOutput,
      annotations: READ_ONLY,
      _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ['app'] } },
    },
    (input) => dashboardResult(context, input, false),
  );
}
