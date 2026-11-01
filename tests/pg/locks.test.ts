import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveAction } from '../../src/approvals.js';
import { listStoreIdsForUser, withPrincipal } from '../../src/db/principal.js';
import type { Principal } from '../../src/db/types.js';
import { createFakePayments } from '../../src/payments/fake.js';
import type { PaymentsAdapter } from '../../src/payments/types.js';
import { ensureDemoStore } from '../../src/seed/provision.js';
import { addSampleOrder, createEmptyStore, USER_A } from '../helpers.js';
import { connectClient, textOf, type TestClient } from '../mcp-client.js';
import { openPostgresTestDatabase, type PostgresTestDatabase } from '../support/postgres.js';

// Lock proofs on real Postgres. Unlike PGlite, every transaction here runs on its own
// connection (the Hyperdrive adapter connects per transaction), so these races are real and
// only the locks keep the outcome correct: the per-user advisory lock in
// store_ops.ensure_owned_store and the `for update` row lock in lockApproval.

const NOW = new Date('2026-11-01T10:00:00.000Z');
const ROUNDS = 5;

let local: PostgresTestDatabase;

beforeAll(async () => {
  local = await openPostgresTestDatabase();
});

afterAll(async () => {
  await local.close();
});

function userId(round: number): string {
  return `00000000-0000-4000-8000-${String(round + 100).padStart(12, '0')}`;
}

describe('the app uses separate connections', () => {
  it('runs parallel transactions on different server backends at the same time', async () => {
    const pids = await Promise.all(
      [1, 2, 3].map(() =>
        local.app.transaction(async (tx) => {
          const { rows } = await tx.query<{ pid: number }>(
            'select pg_backend_pid() as pid from pg_sleep(0.3)',
          );
          return rows[0]?.pid;
        }),
      ),
    );
    expect(new Set(pids).size).toBe(3);
  });
});

describe('first requests for one user (advisory lock)', () => {
  it('two at the same time create exactly one store, in every round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const user = userId(round);
      const results = await Promise.allSettled([
        ensureDemoStore(local.app, user, NOW),
        ensureDemoStore(local.app, user, NOW),
      ]);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(
        rejected.map((result) => String(result.reason)),
        `round ${round}`,
      ).toEqual([]);
      const fulfilled = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const storeIds = await listStoreIdsForUser(local.app, user);
      expect(storeIds, `round ${round}`).toHaveLength(1);
      expect(fulfilled.map((result) => result.principal.storeId)).toEqual([
        storeIds[0],
        storeIds[0],
      ]);
      expect(fulfilled.filter((result) => result.created)).toHaveLength(1);
    }
    const { rows } = await local.owner.query<{ n: number }>(
      "select count(*)::int as n from store_ops.store_members where role = 'owner'",
    );
    expect(rows[0]?.n).toBe(ROUNDS);
  });
});

describe('parallel executions of one approval (row lock)', () => {
  let store: Principal;
  let clients: TestClient[];
  const errors: unknown[] = [];
  const fake = createFakePayments();
  // The refund call happens inside the approval transaction. A slow processor keeps the first
  // transaction open long enough that the other two are certain to arrive while it runs.
  const slowPayments: PaymentsAdapter = {
    processor: fake.processor,
    async refund(request) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fake.refund(request);
    },
  };

  beforeAll(async () => {
    store = await createEmptyStore(local, USER_A);
    // Three separate server instances, as three Worker requests would be.
    clients = await Promise.all(
      [1, 2, 3].map(() => connectClient(local.app, store, NOW, { errors, payments: slowPayments })),
    );
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    expect(errors).toEqual([]);
  });

  it('three at the same time give one refund, one audit row and one processor call', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const orderNumber = 3001 + round;
      const { orderId } = await addSampleOrder(local, store, orderNumber, 'paid');
      const args = { order_number: orderNumber, amount_cents: 250, reason: 'Late delivery' };
      const first = await clients[0]?.data<{ approval_id: string }>('issue_refund', args);
      const approvalId = first?.approval_id ?? '';
      await approveAction(local.app, store, approvalId, 'approve', NOW);
      const callsBefore = fake.calls.length;

      const results = await Promise.all(
        clients.map((client) => client.call('issue_refund', { ...args, approval_id: approvalId })),
      );
      for (const result of results) expect(result.isError, textOf(result)).toBeFalsy();
      expect(results[1]?.structuredContent).toEqual(results[0]?.structuredContent);
      expect(results[2]?.structuredContent).toEqual(results[0]?.structuredContent);

      const counts = await withPrincipal(local.app, store, async (tx) => {
        const { rows } = await tx.query<{ refunds: number; audits: number }>(
          `select (select count(*)::int from store_ops.refunds where order_id = $1) as refunds,
                  (select count(*)::int from store_ops.audit_log where approval_id = $2) as audits`,
          [orderId, approvalId],
        );
        return rows[0];
      });
      expect(counts, `round ${round}`).toEqual({ refunds: 1, audits: 1 });
      expect(fake.calls.length - callsBefore, `round ${round}`).toBe(1);
    }
  });
});
