import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { ApprovalView } from '../approvals.js';
import { csrfField, escapeHtml } from './html.js';
import { isScope, SCOPE_DESCRIPTIONS } from './scopes.js';

export function signInBody(input: {
  csrf: string;
  returnTo: string;
  githubEnabled: boolean;
  reason: string;
}): string {
  const returnTo = `<input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}">`;
  const github = input.githubEnabled
    ? `<form method="post" action="/login/github">${csrfField(input.csrf)}${returnTo}<button class="primary" type="submit">Sign in with GitHub</button></form>`
    : '<p class="box">GitHub sign-in is not configured on this server.</p>';
  return `<h1>Sign in</h1>
<p>${escapeHtml(input.reason)}</p>
${github}
<form method="post" action="/login/demo">${csrfField(input.csrf)}${returnTo}<button type="submit">Try the demo</button></form>
<p class="box">"Try the demo" creates a new demo user with its own freshly generated Demo Store. It stops working after 24 hours. GitHub sign-in reads only your public GitHub id and login.</p>`;
}

export function consentBody(input: {
  details: ConsentDescription;
  scopes: string[];
  handle: string;
  csrf: string;
}): string {
  const { details } = input;
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `<p>The app is published by <strong>${escapeHtml(details.clientDomain)}</strong> (from its client metadata document).</p>`
    : '<p>This app registered itself. Its name is not verified.</p>';
  const loopback = details.redirectIsLoopback
    ? '<p class="warning"><strong>Access goes to an app on your own computer.</strong> Any program on this computer could be listening there, whatever name it shows. Continue only if you just started connecting from that app.</p>'
    : '';
  const scopes = input.scopes
    .map(
      (scope) =>
        `<li><strong>${escapeHtml(scope)}</strong>: ${escapeHtml(isScope(scope) ? SCOPE_DESCRIPTIONS[scope] : scope)}</li>`,
    )
    .join('');
  const fields = `${csrfField(input.csrf)}<input type="hidden" name="handle" value="${escapeHtml(input.handle)}">`;
  return `<h1>Allow ${name} to use your Demo Store?</h1>
${origin}
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>It asks to:</p>
<ul>${scopes}</ul>
<form method="post" action="/authorize">${fields}<input type="hidden" name="decision" value="approve"><button class="primary" type="submit">Approve</button></form>
<form method="post" action="/authorize">${fields}<input type="hidden" name="decision" value="deny"><button type="submit">Deny</button></form>`;
}

export function messageBody(title: string, message: string): string {
  return `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;
}

/** Same page for an unknown id and for someone else's approval, so ids cannot be probed. */
export const APPROVAL_NOT_FOUND = messageBody(
  'Approval not found',
  'There is no approval with this link for your account. It may belong to another account, or the link is wrong.',
);

function approvalDetails(view: ApprovalView): string {
  return `<div class="box"><p><strong>${escapeHtml(view.summary)}</strong></p>
<p>Tool: ${escapeHtml(view.tool)}<br>Expires at: ${escapeHtml(view.expires_at)} (UTC)</p>
<pre>${escapeHtml(JSON.stringify(view.args, null, 2))}</pre></div>`;
}

export function approvalBody(
  view: ApprovalView,
  input: { expired: boolean; csrf: string },
): string {
  const details = approvalDetails(view);
  if (input.expired) {
    return `<h1>This approval expired</h1>${details}<p>Nothing was changed. Ask the assistant to prepare the action again.</p>`;
  }
  switch (view.status) {
    case 'pending': {
      const action = `/approve/${encodeURIComponent(view.approval_id)}`;
      return `<h1>Approve this action?</h1>${details}
<p>Nothing changes until you approve. After that, the assistant runs this exact action once.</p>
<form method="post" action="${escapeHtml(action)}">${csrfField(input.csrf)}<input type="hidden" name="decision" value="approve"><button class="primary" type="submit">Approve</button></form>
<form method="post" action="${escapeHtml(action)}">${csrfField(input.csrf)}<input type="hidden" name="decision" value="reject"><button type="submit">Reject</button></form>`;
    }
    case 'approved':
      return `<h1>Approved</h1>${details}<p>Go back to your chat and ask the assistant to continue. It runs the action once.</p>`;
    case 'rejected':
      return `<h1>Rejected</h1>${details}<p>Nothing was changed.</p>`;
    case 'executed':
      return `<h1>Already done</h1>${details}<p>This action has run. It cannot run again.</p>`;
    case 'expired':
      return `<h1>This approval expired</h1>${details}<p>Nothing was changed. Ask the assistant to prepare the action again.</p>`;
  }
}
