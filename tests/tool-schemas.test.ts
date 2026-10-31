import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import type { LocalDatabase } from '../src/db/pglite.js';
import { createEmptyStore, openTestDatabase, USER_A } from './helpers.js';
import { connectClient, textOf, type TestClient } from './mcp-client.js';

const READ_TOOLS = [
  'get_order',
  'get_sales_summary',
  'get_stock_levels',
  'list_orders',
  'search_orders',
  'search_products',
];

const WRITE_TOOLS = ['add_order_note', 'adjust_stock', 'cancel_order', 'issue_refund'];

let local: LocalDatabase;
let mcp: TestClient;
let tools: Tool[];

beforeAll(async () => {
  local = await openTestDatabase();
  const principal = await createEmptyStore(local, USER_A);
  mcp = await connectClient(local.app, principal, new Date('2026-10-31T12:00:00Z'));
  tools = (await mcp.client.listTools()).tools;
});

afterAll(async () => {
  await mcp.close();
  await local.close();
});

/** Every property name anywhere in a JSON Schema, at any depth. */
function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (typeof schema !== 'object' || schema === null) return [];
  const record = schema as Record<string, unknown>;
  const own =
    typeof record.properties === 'object' && record.properties !== null
      ? Object.keys(record.properties)
      : [];
  return [...own, ...Object.values(record).flatMap(propertyNames)];
}

describe('tool definitions', () => {
  it('lists exactly the read and write tools', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it('no tool input schema has a store id field, at any depth', () => {
    for (const tool of tools) {
      const names = propertyNames(tool.inputSchema);
      expect(
        names.filter((name) => /store/i.test(name)),
        tool.name,
      ).toEqual([]);
    }
  });

  it('input schemas reject unknown fields', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it('a store_id argument is rejected, not silently ignored', async () => {
    const result = await mcp.call('list_orders', {
      store_id: '00000000-0000-4000-8000-0000000000bb',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/store_id/);
  });

  it('every read tool is annotated read-only and has a description and output schema', () => {
    for (const tool of tools.filter((item) => READ_TOOLS.includes(item.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
  });

  it('every write tool needs approval, is not read-only and carries the right hints', () => {
    const destructive: Record<string, boolean> = {
      adjust_stock: true,
      cancel_order: true,
      issue_refund: true,
      add_order_note: false,
    };
    for (const tool of tools.filter((item) => WRITE_TOOLS.includes(item.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(destructive[tool.name]);
      expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
      expect(tool.annotations?.openWorldHint, tool.name).toBe(tool.name === 'issue_refund');
      expect(tool.description, tool.name).toMatch(/approval_id/);
      expect(propertyNames(tool.inputSchema), tool.name).toContain('approval_id');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
  });
});
