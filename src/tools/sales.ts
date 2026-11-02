import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { ORDER_STATUSES, SALE_STATUSES, type OrderStatus } from '../domain.js';
import { utcDayStart, utcNextDayStart } from './orders.js';
import type { SqlClient } from '../db/types.js';
import {
  centsSchema,
  READ_ONLY,
  runRead,
  storeCurrency,
  toInt,
  type ToolContext,
} from './shared.js';

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const TOP_PRODUCT_COUNT = 5;

export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Sales figures for one range; shared by get_sales_summary and the dashboard. */
export const salesShape = {
  currency: z.string(),
  order_count: z.number().int(),
  gross_sales_cents: centsSchema,
  refunds_cents: centsSchema,
  net_sales_cents: centsSchema,
  average_order_value_cents: centsSchema,
  orders_by_status: z
    .record(z.enum(ORDER_STATUSES), z.number().int())
    .describe('Count of all orders placed in the range, by status.'),
  top_products: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      units_sold: z.number().int(),
      revenue_cents: centsSchema,
    }),
  ),
};

export type SalesFigures = z.infer<z.ZodObject<typeof salesShape>>;

/** Sales for the inclusive UTC date range `from` to `to` (YYYY-MM-DD) in the current store. */
export async function salesForRange(
  tx: SqlClient,
  from: string,
  to: string,
): Promise<SalesFigures> {
  const range = [utcDayStart(from), utcNextDayStart(to)];
  const sales = [...SALE_STATUSES];

  const totals = await tx.query<Record<string, unknown>>(
    `select count(*) as order_count,
            coalesce(sum(o.total_cents), 0) as gross,
            coalesce(sum((select coalesce(sum(r.amount_cents), 0) from store_ops.refunds r
                          where r.order_id = o.id and r.status = 'succeeded')), 0) as refunds
     from store_ops.orders o
     where o.placed_at >= $1 and o.placed_at < $2 and o.status = any($3::text[])`,
    [...range, sales],
  );
  const byStatus = await tx.query<{ status: (typeof ORDER_STATUSES)[number]; n: unknown }>(
    `select status, count(*) as n from store_ops.orders
     where placed_at >= $1 and placed_at < $2 group by status`,
    range,
  );
  const top = await tx.query<{
    sku: string;
    name: string;
    units_sold: unknown;
    revenue_cents: unknown;
  }>(
    `select i.sku, min(i.product_name) as name, sum(i.quantity) as units_sold,
            sum(i.line_total_cents) as revenue_cents
     from store_ops.order_items i join store_ops.orders o on o.id = i.order_id
     where o.placed_at >= $1 and o.placed_at < $2 and o.status = any($3::text[])
     group by i.sku
     order by sum(i.line_total_cents) desc, i.sku
     limit $4`,
    [...range, sales, TOP_PRODUCT_COUNT],
  );

  const row = totals.rows[0] ?? {};
  const orderCount = toInt(row.order_count);
  const gross = toInt(row.gross);
  const refunds = toInt(row.refunds);
  const ordersByStatus = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<
    OrderStatus,
    number
  >;
  for (const statusRow of byStatus.rows) ordersByStatus[statusRow.status] = toInt(statusRow.n);

  return {
    currency: await storeCurrency(tx),
    order_count: orderCount,
    gross_sales_cents: gross,
    refunds_cents: refunds,
    net_sales_cents: gross - refunds,
    average_order_value_cents: orderCount === 0 ? 0 : Math.round(gross / orderCount),
    orders_by_status: ordersByStatus,
    top_products: top.rows.map((product) => ({
      sku: product.sku,
      name: product.name,
      units_sold: toInt(product.units_sold),
      revenue_cents: toInt(product.revenue_cents),
    })),
  };
}

export function registerSalesTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_sales_summary',
    {
      title: 'Get sales summary',
      description:
        `Sales for the current store over an inclusive UTC date range (default: the last ${DEFAULT_RANGE_DAYS} days including today, at most ${MAX_RANGE_DAYS} days). ` +
        'Sales count orders that were paid (paid, fulfilled, partially_refunded, refunded); pending and cancelled orders are excluded. ' +
        'gross_sales_cents is the sum of their totals, refunds_cents the succeeded refunds on those orders, net_sales_cents the difference, ' +
        'and average_order_value_cents is gross divided by order count (rounded). Top products are ranked by line revenue.',
      inputSchema: z.strictObject({
        from: z.iso.date().optional().describe('First day to include (YYYY-MM-DD, UTC).'),
        to: z.iso.date().optional().describe('Last day to include (YYYY-MM-DD, UTC).'),
      }),
      outputSchema: z.object({ from: z.string(), to: z.string(), ...salesShape }),
      annotations: READ_ONLY,
    },
    (input) =>
      runRead(context, async (tx) => {
        const today = isoDate(context.now());
        const to = input.to ?? (input.from && input.from > today ? input.from : today);
        const from =
          input.from ??
          isoDate(new Date(Date.parse(utcDayStart(to)) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS));
        if (from > to) throw new ToolError('from must be on or before to.');
        const days = (Date.parse(utcDayStart(to)) - Date.parse(utcDayStart(from))) / DAY_MS + 1;
        if (days > MAX_RANGE_DAYS) {
          throw new ToolError(`The date range can be at most ${MAX_RANGE_DAYS} days.`);
        }
        return { from, to, ...(await salesForRange(tx, from, to)) };
      }),
  );
}
