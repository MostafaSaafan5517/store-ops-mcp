import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import {
  APPROVAL_FLOW_NOTE,
  approvalIdSchema,
  reasonSchema,
  runWrite,
  writeAnnotations,
  writeOutputSchema,
  type WriteToolSpec,
} from './approval-flow.js';
import type { ToolContext } from './shared.js';

const MAX_STOCK_CHANGE = 10_000;

const adjustStockArgs = z.strictObject({
  sku: z.string().trim().min(1).max(64).describe('Product SKU, for example KIT-004.'),
  quantity_change: z
    .number()
    .int()
    .min(-MAX_STOCK_CHANGE)
    .max(MAX_STOCK_CHANGE)
    .refine((value) => value !== 0, { message: 'quantity_change cannot be 0' })
    .describe('Units to add (positive) or remove (negative). Stock can never go below 0.'),
  reason: reasonSchema,
});

type AdjustStockArgs = z.infer<typeof adjustStockArgs>;

const adjustStockResult = z.object({
  sku: z.string(),
  product_name: z.string(),
  quantity_change: z.number().int(),
  stock_before: z.number().int(),
  stock_after: z.number().int(),
});

const effectSchema = z.object({ product_id: z.uuid(), quantity_change: z.number().int() });

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  stock_on_hand: number;
}

function negativeStock(sku: string, stock: number): ToolError {
  return new ToolError(
    `Stock cannot go below 0: ${sku} has ${stock} on hand, so the largest decrease is -${stock}. Nothing was changed.`,
  );
}

const adjustStock: WriteToolSpec<AdjustStockArgs, z.infer<typeof adjustStockResult>> = {
  name: 'adjust_stock',
  async plan(tx, args) {
    const { rows } = await tx.query<ProductRow>(
      'select id, sku, name, stock_on_hand from store_ops.products where sku = $1',
      [args.sku],
    );
    const product = rows[0];
    if (!product) throw new ToolError(`Product ${args.sku} was not found in this store.`);
    const after = product.stock_on_hand + args.quantity_change;
    if (after < 0) throw negativeStock(product.sku, product.stock_on_hand);
    const change = args.quantity_change > 0 ? `+${args.quantity_change}` : args.quantity_change;
    return {
      summary: `Change the stock of "${product.name}" (${product.sku}) by ${change} units, from ${product.stock_on_hand} to ${after} on hand now. Reason: ${args.reason}`,
      effect: { product_id: product.id, quantity_change: args.quantity_change },
    };
  },
  async execute(tx, { effect, now }) {
    const planned = effectSchema.parse(effect);
    const { rows } = await tx.query<ProductRow>(
      `update store_ops.products
       set stock_on_hand = stock_on_hand + $2, updated_at = $3
       where id = $1 and stock_on_hand + $2 >= 0
       returning id, sku, name, stock_on_hand`,
      [planned.product_id, planned.quantity_change, now.toISOString()],
    );
    const product = rows[0];
    if (!product) {
      const current = await tx.query<ProductRow>(
        'select id, sku, name, stock_on_hand from store_ops.products where id = $1',
        [planned.product_id],
      );
      const existing = current.rows[0];
      if (!existing) throw new ToolError('The product no longer exists. Nothing was changed.');
      throw negativeStock(existing.sku, existing.stock_on_hand);
    }
    const before = product.stock_on_hand - planned.quantity_change;
    return {
      result: {
        sku: product.sku,
        product_name: product.name,
        quantity_change: planned.quantity_change,
        stock_before: before,
        stock_after: product.stock_on_hand,
      },
      summary: `Stock of ${product.sku} changed by ${planned.quantity_change}, from ${before} to ${product.stock_on_hand}.`,
    };
  },
};

export function registerStockWriteTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'adjust_stock',
    {
      title: 'Adjust stock',
      description:
        'Add or remove units of one product in the current store, by SKU, with a reason. Stock never goes below 0. ' +
        APPROVAL_FLOW_NOTE,
      inputSchema: adjustStockArgs.extend({ approval_id: approvalIdSchema }),
      outputSchema: writeOutputSchema(adjustStockResult),
      annotations: writeAnnotations({ destructive: true }),
    },
    (input, ctx) => runWrite(context, adjustStock, input, ctx),
  );
}
