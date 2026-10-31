import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  centsSchema,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  likePattern,
  limitSchema,
  nextCursorSchema,
  paginate,
  READ_ONLY,
  runRead,
  storeCurrency,
  toInt,
  type ToolContext,
} from './shared.js';

const productSchema = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  price_cents: centsSchema,
  stock_on_hand: z.number().int(),
  low_stock_threshold: z.number().int(),
  is_low_stock: z.boolean().describe('True when stock_on_hand is at or below the threshold.'),
  active: z.boolean(),
});

type ProductRow = Omit<z.infer<typeof productSchema>, 'is_low_stock'>;

const PRODUCT_COLUMNS =
  'sku, name, category, price_cents, stock_on_hand, low_stock_threshold, active';

function toProduct(row: ProductRow): z.infer<typeof productSchema> {
  return { ...row, is_low_stock: row.stock_on_hand <= row.low_stock_threshold };
}

export function registerProductTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Search products in the current store by text (name or SKU) and/or category, ordered by SKU. Leave both empty to browse everything. Also returns the list of categories. Paginate with cursor and next_cursor.',
      inputSchema: z.strictObject({
        query: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe('Part of a product name or SKU.'),
        category: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .optional()
          .describe('Exact category name (case-insensitive), for example Kitchen.'),
        limit: limitSchema(20),
        cursor: cursorSchema,
      }),
      outputSchema: z.object({
        currency: z.string(),
        products: z.array(productSchema),
        categories: z.array(z.string()).describe('All categories in this store.'),
        next_cursor: nextCursorSchema,
      }),
      annotations: READ_ONLY,
    },
    (input) =>
      runRead(context, async (tx) => {
        const after =
          input.cursor === undefined
            ? null
            : decodeCursor('search_products', input.cursor, z.string());
        const { rows } = await tx.query<ProductRow>(
          `select ${PRODUCT_COLUMNS} from store_ops.products
           where ($1::text is null or name ilike $1 or sku ilike $1)
             and ($2::text is null or lower(category) = lower($2))
             and ($3::text is null or sku > $3)
           order by sku
           limit $4`,
          [
            input.query ? likePattern(input.query) : null,
            input.category ?? null,
            after,
            input.limit + 1,
          ],
        );
        const categories = await tx.query<{ category: string }>(
          'select distinct category from store_ops.products order by category',
        );
        const { page, nextCursor } = paginate(rows, input.limit, (last) =>
          encodeCursor('search_products', last.sku),
        );
        return {
          currency: await storeCurrency(tx),
          products: page.map(toProduct),
          categories: categories.rows.map((row) => row.category),
          next_cursor: nextCursor,
        };
      }),
  );

  server.registerTool(
    'get_stock_levels',
    {
      title: 'Get stock levels',
      description:
        'Stock on hand for products in the current store, lowest stock first. Set low_stock_only to see only products at or below their low stock threshold. Includes store-wide counts of low stock and sold out products. Paginate with cursor and next_cursor.',
      inputSchema: z.strictObject({
        low_stock_only: z
          .boolean()
          .default(false)
          .describe('Only products at or below their low stock threshold.'),
        limit: limitSchema(20),
        cursor: cursorSchema,
      }),
      outputSchema: z.object({
        products: z.array(productSchema),
        summary: z.object({
          product_count: z.number().int(),
          low_stock_count: z.number().int(),
          out_of_stock_count: z.number().int(),
        }),
        next_cursor: nextCursorSchema,
      }),
      annotations: READ_ONLY,
    },
    (input) =>
      runRead(context, async (tx) => {
        const after =
          input.cursor === undefined
            ? null
            : decodeCursor(
                'get_stock_levels',
                input.cursor,
                z.object({ stock: z.number().int(), sku: z.string() }),
              );
        const { rows } = await tx.query<ProductRow>(
          `select ${PRODUCT_COLUMNS} from store_ops.products
           where (not $1::boolean or stock_on_hand <= low_stock_threshold)
             and ($2::int is null or (stock_on_hand, sku) > ($2::int, $3::text))
           order by stock_on_hand, sku
           limit $4`,
          [input.low_stock_only, after?.stock ?? null, after?.sku ?? null, input.limit + 1],
        );
        const summary = await tx.query<Record<string, unknown>>(
          `select count(*) as product_count,
                  count(*) filter (where stock_on_hand <= low_stock_threshold) as low_stock_count,
                  count(*) filter (where stock_on_hand = 0) as out_of_stock_count
           from store_ops.products`,
        );
        const counts = summary.rows[0] ?? {};
        const { page, nextCursor } = paginate(rows, input.limit, (last) =>
          encodeCursor('get_stock_levels', { stock: last.stock_on_hand, sku: last.sku }),
        );
        return {
          products: page.map(toProduct),
          summary: {
            product_count: toInt(counts.product_count),
            low_stock_count: toInt(counts.low_stock_count),
            out_of_stock_count: toInt(counts.out_of_stock_count),
          },
          next_cursor: nextCursor,
        };
      }),
  );
}
