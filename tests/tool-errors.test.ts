import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/types.js';
import { connectClient, textOf } from './mcp-client.js';
import { USER_A } from './helpers.js';

describe('unexpected errors', () => {
  it('are reported to onError and never leak details to the client', async () => {
    const failing: Database = {
      transaction: () => Promise.reject(new Error('relation "secret_table" does not exist')),
    };
    const errors: unknown[] = [];
    const mcp = await connectClient(
      failing,
      { userId: USER_A, storeId: '00000000-0000-4000-8000-0000000000cc' },
      new Date(),
      { errors },
    );
    try {
      const result = await mcp.call('get_stock_levels');
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Something went wrong on the server. Please try again.');
      expect(textOf(result)).not.toMatch(/secret_table/);
      expect(errors).toHaveLength(1);
    } finally {
      await mcp.close();
    }
  });
});
