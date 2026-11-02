import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  createApproval,
  decideLocked,
  hashArgs,
  isExpired,
  lockApproval,
  markExecuted,
  notFound,
  setStatus,
  type ApprovalDecision,
  type WriteToolName,
} from '../approvals.js';
import { isUuid } from '../db/principal.js';
import type { SqlClient } from '../db/types.js';
import { ToolError } from '../errors.js';
import {
  errorResult,
  jsonResult,
  toolErrorResult,
  withOpenStore,
  type ToolContext,
} from './shared.js';

/** The checked effect a first call prepares. `effect` is what execution will apply. */
export interface WritePlan {
  summary: string;
  effect: Record<string, unknown>;
}

export interface WriteExecution<Result> {
  result: Result;
  /** One line for the audit log and the tool result. */
  summary: string;
}

export interface WriteToolSpec<Args extends Record<string, unknown>, Result> {
  name: WriteToolName;
  /** Validates the arguments against the store and describes the exact effect. No writes. */
  plan(tx: SqlClient, args: Args): Promise<WritePlan>;
  /** Applies the approved effect. Runs in the transaction that holds the approval lock. */
  execute(
    tx: SqlClient,
    input: { args: Args; effect: Record<string, unknown>; approvalId: string; now: Date },
  ): Promise<WriteExecution<Result>>;
}

export const APPROVAL_FLOW_NOTE =
  'Needs human approval, in two calls. The first call (without approval_id) changes nothing: it returns an approval_id, a summary of the exact effect and an approval_url. ' +
  'Show the summary to the user and ask them to approve it. After they approve, call this tool again with exactly the same arguments plus approval_id; it then runs once. ' +
  'Repeating that call returns the same result without running again. Approvals expire after 10 minutes.';

export const approvalIdSchema = z
  .uuid()
  .optional()
  .describe(
    'Leave out on the first call. After the user approved, pass the approval_id from the first call, with the same other arguments.',
  );

export const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe('Why this change is made. Stored in the audit log.');

export function writeAnnotations(options: {
  destructive: boolean;
  openWorld?: boolean;
}): ToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: options.destructive,
    // With the same approval_id a repeated call returns the stored result.
    idempotentHint: true,
    openWorldHint: options.openWorld ?? false,
  };
}

export function writeOutputSchema<Result extends z.ZodType>(result: Result) {
  return z.object({
    status: z
      .enum(['approval_required', 'executed'])
      .describe('approval_required: nothing changed yet. executed: the change was applied.'),
    approval_id: z.string(),
    summary: z.string().describe('Plain description of the exact effect.'),
    approval: z
      .object({
        expires_at: z.string().describe('ISO 8601 timestamp.'),
        approval_url: z.string().describe('Page where the signed-in user approves or rejects.'),
        approve_command: z
          .string()
          .nullable()
          .describe('Local alternative to the page (stdio mode only).'),
        next_step: z.string(),
      })
      .nullable()
      .describe('Set while approval is required, null once executed.'),
    result: result.nullable().describe('Set once executed.'),
  });
}

const CONFIRM_KEY = 'confirm';

const confirmationSchema = z.object({
  confirm: z.boolean().describe('Approve this exact action'),
});

/** True when this 2026-07-28 request declares form elicitation in its capabilities. */
function supportsFormElicitation(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/**
 * Reads a retried call that answers our confirmation. requestState comes back from the client
 * and is untrusted: it is used only as a lookup key, and the approval it names must still
 * belong to this user and store (RLS), match this tool and these exact arguments, and be
 * pending. So a forged value can at most point at another identical pending action.
 */
function confirmationAnswer(
  ctx: ServerContext,
): { approvalId: string; decision: ApprovalDecision } | undefined {
  const state = ctx.mcpReq.requestState<unknown>();
  if (typeof state !== 'string' || !isUuid(state)) return undefined;
  if (ctx.mcpReq.inputResponses?.[CONFIRM_KEY] === undefined) return undefined;
  const answer = acceptedContent(ctx.mcpReq.inputResponses, CONFIRM_KEY, confirmationSchema);
  return { approvalId: state, decision: answer?.confirm === true ? 'approve' : 'reject' };
}

type Outcome =
  | { kind: 'result'; output: Record<string, unknown> }
  /** A refusal after a status change that must be kept (rejected or expired). */
  | { kind: 'refused'; message: string };

function pendingMessage(context: ToolContext, tool: WriteToolName, approvalId: string): string {
  const command = context.approvals.localCommand?.(approvalId);
  return (
    `Approval ${approvalId} has not been approved yet, so nothing was changed. ` +
    `Ask the user to approve it at ${context.approvals.url(approvalId)}` +
    (command ? ` or by running: ${command}` : '') +
    `, then call ${tool} again with the same arguments and approval_id.`
  );
}

async function executeApproval<Args extends Record<string, unknown>, Result>(
  context: ToolContext,
  spec: WriteToolSpec<Args, Result>,
  args: Args,
  argsHash: string,
  approvalId: string,
  inChatDecision: ApprovalDecision | undefined,
): Promise<Outcome> {
  return withOpenStore(context, async (tx, now) => {
    const approval = await lockApproval(tx, approvalId);
    if (!approval) throw notFound(approvalId);
    if (approval.tool !== spec.name) {
      throw new ToolError(
        `Approval ${approvalId} is for ${approval.tool}, not ${spec.name}. Nothing was changed.`,
      );
    }
    if (approval.argsHash !== argsHash) {
      throw new ToolError(
        `These arguments differ from the ones approval ${approvalId} was prepared for, so nothing was changed. ` +
          `Call ${spec.name} with exactly the approved arguments, or call it without approval_id to prepare a new approval.`,
      );
    }
    if (approval.status === 'executed' && approval.result) {
      return { kind: 'result', output: approval.result };
    }
    if (approval.status === 'rejected') {
      throw new ToolError(`Approval ${approvalId} was rejected. Nothing was changed.`);
    }
    if (isExpired(approval, now)) {
      if (approval.status !== 'expired') await setStatus(tx, approvalId, 'expired', now);
      return {
        kind: 'refused',
        message: `Approval ${approvalId} expired at ${approval.expiresAt.toISOString()}. Nothing was changed. Call ${spec.name} without approval_id to prepare it again.`,
      };
    }

    let approved = approval.status === 'approved';
    if (!approved) {
      const decision = inChatDecision ?? (await context.approvals.inbox?.take(approvalId));
      if (decision) {
        await decideLocked(tx, approval, decision, now);
        if (decision === 'reject') {
          return {
            kind: 'refused',
            message: `The user rejected approval ${approvalId}. Nothing was changed.`,
          };
        }
        approved = true;
      }
    }
    if (!approved) throw new ToolError(pendingMessage(context, spec.name, approvalId));

    const execution = await spec.execute(tx, {
      args,
      effect: approval.summary.effect,
      approvalId,
      now,
    });
    const output = {
      status: 'executed',
      approval_id: approvalId,
      summary: execution.summary,
      approval: null,
      result: execution.result,
    };
    await tx.query(
      `insert into store_ops.audit_log
         (store_id, user_id, tool, approval_id, args, summary, details, created_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)`,
      [
        context.principal.storeId,
        context.principal.userId,
        spec.name,
        approvalId,
        JSON.stringify(args),
        execution.summary,
        JSON.stringify(execution.result),
        now.toISOString(),
      ],
    );
    await markExecuted(tx, approvalId, output, now);
    return { kind: 'result', output };
  });
}

/**
 * Runs one write tool call through the approval flow:
 * - with approval_id: executes once if approved, or returns the stored result again;
 * - answering our in-chat confirmation: records the decision, then executes if approved;
 * - otherwise: prepares a pending approval and asks for a human decision, in chat when the
 *   client supports form elicitation, else with an approval link.
 */
export async function runWrite<Args extends Record<string, unknown>, Result>(
  context: ToolContext,
  spec: WriteToolSpec<Args, Result>,
  input: Args & { approval_id?: string | undefined },
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const { approval_id: approvalId, ...rest } = input;
    const args = rest as unknown as Args;
    const argsHash = await hashArgs(spec.name, args);

    const answer = approvalId === undefined ? confirmationAnswer(ctx) : undefined;
    if (approvalId !== undefined || answer) {
      const outcome = await executeApproval(
        context,
        spec,
        args,
        argsHash,
        approvalId ?? answer?.approvalId ?? '',
        answer?.decision,
      );
      return outcome.kind === 'result' ? jsonResult(outcome.output) : errorResult(outcome.message);
    }

    const prepared = await withOpenStore(context, async (tx, now) => {
      const plan = await spec.plan(tx, args);
      const approval = await createApproval(
        tx,
        context.principal,
        { tool: spec.name, args, argsHash, summary: { text: plan.summary, effect: plan.effect } },
        now,
      );
      return { ...approval, summary: plan.summary };
    });
    const expiresAt = prepared.expiresAt.toISOString();

    if (context.approvals.inChat === true && supportsFormElicitation(ctx)) {
      return inputRequired({
        inputRequests: {
          [CONFIRM_KEY]: inputRequired.elicit({
            message: `${prepared.summary}\n\nApprove this exact action? The request expires at ${expiresAt}.`,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState: prepared.id,
      });
    }

    const command = context.approvals.localCommand?.(prepared.id) ?? null;
    const url = context.approvals.url(prepared.id);
    return jsonResult({
      status: 'approval_required',
      approval_id: prepared.id,
      summary: prepared.summary,
      approval: {
        expires_at: expiresAt,
        approval_url: url,
        approve_command: command,
        next_step:
          `Nothing has changed yet. Show the summary to the user and ask them to approve it at ${url}` +
          (command ? ` (or locally by running: ${command})` : '') +
          `. After they approve, call ${spec.name} again with the same arguments and approval_id "${prepared.id}". ` +
          `The approval expires at ${expiresAt}.`,
      },
      result: null,
    });
  } catch (error) {
    return toolErrorResult(context, error);
  }
}
