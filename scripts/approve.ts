import { readLocalEnv } from '../src/local-env.js';
import { recordLocalDecision } from '../src/local-approvals.js';

// Usage: pnpm run approve <approval_id> [--reject]
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const reject = args.includes('--reject');
const approvalId = args.find((arg) => !arg.startsWith('--'));

if (!approvalId) {
  process.stderr.write('Usage: pnpm run approve <approval_id> [--reject]\n');
  process.exit(1);
}

try {
  const env = readLocalEnv(process.env);
  await recordLocalDecision(env.approvalsDir, approvalId, reject ? 'reject' : 'approve');
  process.stdout.write(
    `${reject ? 'Rejected' : 'Approved'} ${approvalId}. The running Store Ops MCP server applies this ` +
      'the next time the tool is called with this approval_id, after checking that the approval is ' +
      'yours, in your store, pending and not expired.\n',
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
