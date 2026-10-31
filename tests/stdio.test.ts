import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, describe, expect, it } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000d1';
const dataDir = mkdtempSync(join(tmpdir(), 'store-ops-stdio-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function withStdioClient<T>(
  mode: 'auto' | 'legacy' | { pin: string },
  fn: (client: Client, stderr: () => string) => Promise<T>,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/stdio.ts'],
    cwd: process.cwd(),
    env: { STORE_OPS_USER_ID: USER_ID, STORE_OPS_DATA_DIR: dataDir, PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: 'stdio-test', version: '0.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  try {
    return await fn(client, () => stderr);
  } finally {
    await client.close();
  }
}

const storeIdIn = (stderr: string) => /Demo Store ([0-9a-f-]{36})/.exec(stderr)?.[1];

let firstStoreId: string | undefined;

describe('stdio server', () => {
  it('seeds a demo store on first run and serves a 2026-07-28 client', async () => {
    await withStdioClient({ pin: '2026-07-28' }, async (client, stderr) => {
      expect(client.getServerVersion()?.name).toBe('store-ops-mcp');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('list_orders');
      expect(tools).toHaveLength(6);

      const stock = await client.callTool({ name: 'get_stock_levels', arguments: { limit: 5 } });
      expect(stock.isError).toBeFalsy();
      expect(stock.structuredContent).toMatchObject({ summary: { product_count: 40 } });

      const orders = await client.callTool({ name: 'list_orders', arguments: { limit: 3 } });
      expect((orders.structuredContent as { orders: unknown[] }).orders).toHaveLength(3);
      // The client probes with a short-lived sibling process first, and that sibling seeds the
      // store, so this session may log either Created or Opened.
      expect(stderr()).toMatch(/(Created|Opened) Demo Store/);
      firstStoreId = storeIdIn(stderr());
    });
  });

  it('reuses the same store on the next run and serves a 2025-era client', async () => {
    await withStdioClient('legacy', async (client, stderr) => {
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      const summary = await client.callTool({ name: 'get_stock_levels', arguments: {} });
      expect(summary.structuredContent).toMatchObject({ summary: { product_count: 40 } });
      expect(stderr()).toMatch(/Opened Demo Store/);
      expect(firstStoreId).toBeDefined();
      expect(storeIdIn(stderr())).toBe(firstStoreId);
    });
  });
});
