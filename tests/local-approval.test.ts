import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPrincipal } from '../src/db/principal.js';
import type { Principal } from '../src/db/types.js';
import { createFileApprovalInbox, recordLocalDecision } from '../src/local-approvals.js';
import {
  addSampleOrder,
  createEmptyStore,
  openTestDatabase,
  USER_A,
  type TestDatabase,
} from './helpers.js';
import { connectClient, textOf, type TestClient } from './mcp-client.js';

const run = promisify(execFile);
const APPROVAL_ID = '1f0e2d3c-4b5a-4968-8776-655443322110';

const dir = mkdtempSync(join(tmpdir(), 'store-ops-approvals-'));
let local: TestDatabase;
let store: Principal;
let mcp: TestClient;

beforeAll(async () => {
  local = await openTestDatabase();
  store = await createEmptyStore(local, USER_A);
  await addSampleOrder(local, store, 5001);
  await addSampleOrder(local, store, 5002);
  mcp = await connectClient(local.app, store, new Date(), {
    localApproval: {
      inbox: createFileApprovalInbox(dir),
      command: (approvalId) => `pnpm run approve ${approvalId}`,
    },
  });
});

afterAll(async () => {
  await mcp.close();
  await local.close();
  rmSync(dir, { recursive: true, force: true });
});

async function stockOf(sku: string): Promise<number> {
  return withPrincipal(local.app, store, async (tx) => {
    const { rows } = await tx.query<{ stock_on_hand: number }>(
      'select stock_on_hand from store_ops.products where sku = $1',
      [sku],
    );
    return rows[0]?.stock_on_hand ?? -1;
  });
}

describe('file approval inbox', () => {
  it('returns a recorded decision once, then forgets it', async () => {
    const inbox = createFileApprovalInbox(dir);
    expect(await inbox.take(APPROVAL_ID)).toBeUndefined();
    const file = await recordLocalDecision(dir, APPROVAL_ID, 'reject');
    expect(existsSync(file)).toBe(true);
    expect(await inbox.take(APPROVAL_ID)).toBe('reject');
    expect(existsSync(file)).toBe(false);
    expect(await inbox.take(APPROVAL_ID)).toBeUndefined();
  });

  it('refuses ids that are not UUIDs, so no path can escape the folder', async () => {
    await expect(recordLocalDecision(dir, '../../etc/passwd', 'approve')).rejects.toThrow(/UUID/);
  });
});

describe('local approval in stdio mode', () => {
  it('shows the command, and the server applies a recorded approval on the next call', async () => {
    const args = { sku: 'SKU-5001', quantity_change: 3, reason: 'Delivery' };
    const first = await mcp.data<{ approval_id: string; approval: { approve_command: string } }>(
      'adjust_stock',
      args,
    );
    expect(first.approval.approve_command).toBe(`pnpm run approve ${first.approval_id}`);

    const pending = await mcp.call('adjust_stock', { ...args, approval_id: first.approval_id });
    expect(textOf(pending)).toContain(`or by running: pnpm run approve ${first.approval_id}`);

    await recordLocalDecision(dir, first.approval_id, 'approve');
    const done = await mcp.call('adjust_stock', { ...args, approval_id: first.approval_id });
    expect(done.isError, textOf(done)).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ status: 'executed' });
    expect(await stockOf('SKU-5001')).toBe(13);
  });

  it('a recorded rejection is applied and nothing changes', async () => {
    const args = { sku: 'SKU-5002', quantity_change: -2, reason: 'Count' };
    const first = await mcp.data<{ approval_id: string }>('adjust_stock', args);
    await recordLocalDecision(dir, first.approval_id, 'reject');
    const result = await mcp.call('adjust_stock', { ...args, approval_id: first.approval_id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/rejected/);
    expect(await stockOf('SKU-5002')).toBe(10);
  });
});

describe('pnpm run approve', () => {
  const cli = (args: string[]) =>
    run(process.execPath, ['--import', 'tsx', 'scripts/approve.ts', ...args], {
      env: { PATH: process.env.PATH ?? '', STORE_OPS_APPROVALS_DIR: dir },
    });

  it('records an approval or a rejection for the running server', async () => {
    const { stdout } = await cli([APPROVAL_ID]);
    expect(stdout).toMatch(new RegExp(`^Approved ${APPROVAL_ID}`));
    expect(await createFileApprovalInbox(dir).take(APPROVAL_ID)).toBe('approve');

    await cli([APPROVAL_ID, '--reject']);
    expect(await createFileApprovalInbox(dir).take(APPROVAL_ID)).toBe('reject');
  });

  it('fails with a clear message for a missing or invalid id', async () => {
    // A rejected execFile promise means a non-zero exit; its message includes stderr.
    await expect(cli([])).rejects.toThrow(/Usage: pnpm run approve/);
    await expect(cli(['not-an-id'])).rejects.toThrow(/must be a UUID/);
  });
});
