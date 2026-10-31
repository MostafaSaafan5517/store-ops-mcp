import { isUuid, withPrincipal } from './db/principal.js';
import type { Database, Principal, SqlClient } from './db/types.js';
import { ToolError } from './errors.js';

/** How long a prepared write waits for a human decision. */
export const APPROVAL_TTL_MS = 10 * 60_000;

export const WRITE_TOOLS = [
  'adjust_stock',
  'cancel_order',
  'issue_refund',
  'add_order_note',
] as const;

export type WriteToolName = (typeof WRITE_TOOLS)[number];

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';

export type ApprovalDecision = 'approve' | 'reject';

/** What the human approves: a plain sentence plus the exact effect the server will apply. */
export interface ApprovalSummary {
  text: string;
  effect: Record<string, unknown>;
}

export interface ApprovalRecord {
  id: string;
  tool: WriteToolName;
  argsHash: string;
  args: Record<string, unknown>;
  summary: ApprovalSummary;
  status: ApprovalStatus;
  result: Record<string, unknown> | null;
  expiresAt: Date;
}

interface ApprovalRow {
  id: string;
  tool: WriteToolName;
  args_hash: string;
  args: Record<string, unknown>;
  summary: ApprovalSummary;
  status: ApprovalStatus;
  result: Record<string, unknown> | null;
  expires_at: unknown;
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    tool: row.tool,
    argsHash: row.args_hash,
    args: row.args,
    summary: row.summary,
    status: row.status,
    result: row.result,
    expiresAt: new Date(row.expires_at as string | Date),
  };
}

/** JSON with object keys sorted at every depth, so equal arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of the tool name and its canonical arguments. */
export async function hashArgs(
  tool: WriteToolName,
  args: Record<string, unknown>,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ tool, args }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stores a pending approval in the current transaction. Nothing else changes. */
export async function createApproval(
  tx: SqlClient,
  principal: Principal,
  input: {
    tool: WriteToolName;
    args: Record<string, unknown>;
    argsHash: string;
    summary: ApprovalSummary;
  },
  now: Date,
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
  const { rows } = await tx.query<{ id: string }>(
    `insert into store_ops.approvals
       (store_id, user_id, tool, args_hash, args, summary, expires_at, created_at)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     returning id`,
    [
      principal.storeId,
      principal.userId,
      input.tool,
      input.argsHash,
      JSON.stringify(input.args),
      JSON.stringify(input.summary),
      expiresAt.toISOString(),
      now.toISOString(),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('approval insert returned no id');
  return { id, expiresAt };
}

/**
 * Locks one approval row for the rest of the transaction (`for update`), so two executions of
 * the same approval run one after the other. RLS limits it to the current user and store, so
 * another user's or store's approval reads as not found.
 */
export async function lockApproval(
  tx: SqlClient,
  approvalId: string,
): Promise<ApprovalRecord | undefined> {
  if (!isUuid(approvalId)) return undefined;
  const { rows } = await tx.query<ApprovalRow>(
    `select id, tool, args_hash, args, summary, status, result, expires_at
     from store_ops.approvals where id = $1 for update`,
    [approvalId],
  );
  const row = rows[0];
  return row ? toRecord(row) : undefined;
}

export function notFound(approvalId: string): ToolError {
  return new ToolError(
    `Approval ${approvalId} was not found for this user and store. Nothing was changed.`,
  );
}

export function isExpired(approval: ApprovalRecord, now: Date): boolean {
  return approval.status === 'expired' || approval.expiresAt.getTime() <= now.getTime();
}

export async function setStatus(
  tx: SqlClient,
  approvalId: string,
  status: 'approved' | 'rejected' | 'expired',
  now: Date,
): Promise<void> {
  await tx.query(
    `update store_ops.approvals
     set status = $2, decided_at = case when $2 = 'expired' then decided_at else $3::timestamptz end
     where id = $1`,
    [approvalId, status, now.toISOString()],
  );
}

export async function markExecuted(
  tx: SqlClient,
  approvalId: string,
  result: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `update store_ops.approvals set status = 'executed', result = $2::jsonb, executed_at = $3
     where id = $1 and status = 'approved'
     returning id`,
    [approvalId, JSON.stringify(result), now.toISOString()],
  );
  if (rows.length !== 1) throw new Error(`approval ${approvalId} was not in the approved state`);
}

export interface ApprovalView {
  approval_id: string;
  tool: WriteToolName;
  status: ApprovalStatus;
  summary: string;
  args: Record<string, unknown>;
  expires_at: string;
}

function toView(approval: ApprovalRecord, status: ApprovalStatus = approval.status): ApprovalView {
  return {
    approval_id: approval.id,
    tool: approval.tool,
    status,
    summary: approval.summary.text,
    args: approval.args,
    expires_at: approval.expiresAt.toISOString(),
  };
}

/** Reads one approval for the review page (Run 3), as the signed-in principal. */
export function getApproval(
  db: Database,
  principal: Principal,
  approvalId: string,
): Promise<ApprovalView> {
  return withPrincipal(db, principal, async (tx) => {
    const approval = await lockApproval(tx, approvalId);
    if (!approval) throw notFound(approvalId);
    return toView(approval);
  });
}

/**
 * Records a human decision on a pending approval. Called by the approval page (Run 3), the
 * in-chat confirmation and the local `pnpm run approve` command. Only the user who prepared the
 * action, in the same store, can decide, and only before it expires.
 */
export function approveAction(
  db: Database,
  principal: Principal,
  approvalId: string,
  decision: ApprovalDecision,
  now: Date = new Date(),
): Promise<ApprovalView> {
  return withPrincipal(db, principal, async (tx) => {
    const approval = await lockApproval(tx, approvalId);
    if (!approval) throw notFound(approvalId);
    return decideLocked(tx, approval, decision, now);
  });
}

/** Applies a decision to an approval already locked in this transaction. */
export async function decideLocked(
  tx: SqlClient,
  approval: ApprovalRecord,
  decision: ApprovalDecision,
  now: Date,
): Promise<ApprovalView> {
  if (approval.status !== 'pending') {
    throw new ToolError(
      `Approval ${approval.id} is already ${approval.status}, so it cannot be decided again.`,
    );
  }
  if (isExpired(approval, now)) {
    throw new ToolError(
      `Approval ${approval.id} expired at ${approval.expiresAt.toISOString()}. Prepare the action again.`,
    );
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await setStatus(tx, approval.id, status, now);
  return toView(approval, status);
}

/**
 * Decisions recorded outside the server process (the local `pnpm run approve` command). The
 * server applies a decision with the same checks as `approveAction` when the approval is
 * next used, then forgets it.
 */
export interface ApprovalInbox {
  take(approvalId: string): Promise<ApprovalDecision | undefined>;
}

/** Where a human can approve a prepared action. */
export interface ApprovalLinks {
  url(approvalId: string): string;
  /** Local stdio mode only: a command that approves from a terminal. */
  localCommand?: (approvalId: string) => string;
  inbox?: ApprovalInbox;
}

/** Builds `<base>/approve/<id>` from a configurable base URL. */
export function approvalUrlFrom(baseUrl: string): (approvalId: string) => string {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  return (approvalId) => new URL(`approve/${encodeURIComponent(approvalId)}`, base).toString();
}
