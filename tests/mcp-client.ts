import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
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

/**
 * Connects an SDK client to the server through the real stdio serving entry (which picks the
 * protocol era), over an in-memory transport pair. The client pins the 2026-07-28 revision.
 */
export async function connectClient(
  db: Database,
  principal: Principal,
  now: Date,
  errors: unknown[] = [],
): Promise<TestClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createStoreOpsServer({ db, principal, now: () => now, onError: (e) => errors.push(e) }),
    { transport: serverTransport, onerror: (error) => errors.push(error) },
  );
  const client = new Client(
    { name: 'store-ops-tests', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
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
      await handle.close();
    },
  };
}
