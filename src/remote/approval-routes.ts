import { approveAction, getApproval, type ApprovalView } from '../approvals.js';
import { ToolError } from '../errors.js';
import { signInPage } from './auth-routes.js';
import type { PageContext } from './config.js';
import { htmlResponse } from './html.js';
import { APPROVAL_NOT_FOUND, approvalBody, messageBody } from './pages.js';
import { readSession, type Session } from './session.js';

function isExpired(view: ApprovalView, now: Date): boolean {
  return (
    view.status === 'expired' ||
    ((view.status === 'pending' || view.status === 'approved') &&
      new Date(view.expires_at).getTime() <= now.getTime())
  );
}

async function loadApproval(
  context: PageContext,
  session: Session,
  approvalId: string,
): Promise<ApprovalView | undefined> {
  try {
    return await getApproval(context.db, session, approvalId);
  } catch (error) {
    // RLS hides other users' and stores' approvals, so they read as not found too.
    if (error instanceof ToolError) return undefined;
    throw error;
  }
}

async function render(
  context: PageContext,
  view: ApprovalView | undefined,
  status = 200,
): Promise<Response> {
  if (!view) return htmlResponse('Approval not found', APPROVAL_NOT_FOUND, { status: 404 });
  const { token, setCookie } = await context.config.csrf.issue(context.request);
  const headers = new Headers();
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return htmlResponse(
    'Approval',
    approvalBody(view, { expired: isExpired(view, context.now), csrf: token }),
    { status, headers },
  );
}

export async function showApproval(context: PageContext, approvalId: string): Promise<Response> {
  const session = await readSession(context.config.signer, context.request, context.now);
  if (!session) {
    return signInPage(context, 'Sign in with the account you connected to review this action.');
  }
  return render(context, await loadApproval(context, session, approvalId));
}

export async function decideApproval(context: PageContext, approvalId: string): Promise<Response> {
  const form = await context.request.formData();
  const session = await readSession(context.config.signer, context.request, context.now);
  if (!session || !(await context.config.csrf.check(context.request, form))) {
    const title = 'Request refused';
    return htmlResponse(
      title,
      messageBody(title, 'This page expired. Open the approval link again and retry.'),
      { status: 403 },
    );
  }
  const decision = form.get('decision');
  if (decision !== 'approve' && decision !== 'reject') {
    return render(context, await loadApproval(context, session, approvalId), 400);
  }
  try {
    const view = await approveAction(context.db, session, approvalId, decision, context.now);
    return render(context, view);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    // Already decided, expired or not found: show its current state instead.
    const view = await loadApproval(context, session, approvalId);
    return render(context, view, view ? 409 : 404);
  }
}
