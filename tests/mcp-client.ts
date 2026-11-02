import { Client, type CallToolResult, type ElicitResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ApprovalInbox } from '../src/approvals.js';
import type { Database, Principal } from '../src/db/types.js';
import { createFakePayments } from '../src/payments/fake.js';
import type { PaymentsAdapter } from '../src/payments/types.js';
import { createStoreOpsServer } from '../src/server.js';

export const APPROVAL_BASE_URL = 'https://store-ops.example.com';

export interface TestClient {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Calls a tool and returns its structuredContent, failing if the call returned an error. */
  data<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  errors?: unknown[];
  payments?: PaymentsAdapter;
  /** Declares form elicitation and answers every confirmation with this handler. */
  elicit?: (message: string) => ElicitResult;
  /** Server side: ask in chat when the client declares elicitation. Defaults to Boolean(elicit). */
  inChatConfirmation?: boolean;
  localApproval?: { inbox: ApprovalInbox; command: (approvalId: string) => string };
}

export function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/**
 * Connects an SDK client to the server through the real stdio serving entry (which picks the
 * protocol era), over an in-memory transport pair. The client pins the 2026-07-28 revision.
 * `now` is a fixed time or a clock the test can move.
 */
export async function connectClient(
  db: Database,
  principal: Principal,
  now: Date | (() => Date),
  options: ConnectOptions = {},
): Promise<TestClient> {
  const errors = options.errors ?? [];
  const clock = typeof now === 'function' ? now : () => now;
  const payments = options.payments ?? createFakePayments();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () =>
      createStoreOpsServer({
        db,
        principal,
        payments,
        approvalBaseUrl: APPROVAL_BASE_URL,
        ...(options.localApproval ? { localApproval: options.localApproval } : {}),
        inChatConfirmation: options.inChatConfirmation ?? Boolean(options.elicit),
        now: clock,
        onError: (e) => errors.push(e),
      }),
    { transport: serverTransport, onerror: (error) => errors.push(error) },
  );
  const client = new Client(
    { name: 'store-ops-tests', version: '0.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      ...(options.elicit ? { capabilities: { elicitation: { form: {} } } } : {}),
    },
  );
  const elicit = options.elicit;
  if (elicit) {
    client.setRequestHandler('elicitation/create', (request) =>
      Promise.resolve(elicit(request.params.message)),
    );
  }
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
