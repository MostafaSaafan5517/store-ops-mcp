import { describe, expect, it } from 'vitest';
import { DEMO_STORE_NAME, PRODUCT_NAME } from '../src/config.js';

describe('config', () => {
  it('names the product and labels demo data', () => {
    expect(PRODUCT_NAME).toBe('Store Ops MCP');
    expect(DEMO_STORE_NAME).toBe('Demo Store');
  });
});
