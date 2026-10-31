import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Database, Principal } from '../src/db/types.js';
import { createStoreOpsServer } from '../src/server.js';

export interface TestClient {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Calls a tool and returns its structuredContent, failing if the call returned an error. */
  data<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** Connects an SDK client to a fresh server instance for `principal` over an in-memory pair. */
export async function connectClient(
  db: Database,
  principal: Principal,
  now: Date,
  errors: unknown[] = [],
): Promise<TestClient> {
  const server = createStoreOpsServer({
    db,
    principal,
    now: () => now,
    onError: (error) => errors.push(error),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'store-ops-tests', version: '0.0.0' });
  await client.connect(clientTransport);

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  return {
    client,
    call,
    async data<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
      return result.structuredContent as T;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
