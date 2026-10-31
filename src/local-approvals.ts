import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ApprovalDecision, ApprovalInbox } from './approvals.js';
import { isUuid } from './db/principal.js';

const decisionFile = z.object({ decision: z.enum(['approve', 'reject']) });

function fileFor(dir: string, approvalId: string): string {
  if (!isUuid(approvalId)) throw new Error('The approval id must be a UUID');
  return join(dir, `${approvalId.toLowerCase()}.json`);
}

/**
 * Records a decision from the local `pnpm run approve` command. PGlite allows one connection, so
 * the command cannot write to the database while the stdio server has it open; it leaves the
 * decision in a folder instead, and the server applies it.
 */
export async function recordLocalDecision(
  dir: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<string> {
  const file = fileFor(dir, approvalId);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ decision }), 'utf8');
  return file;
}

/**
 * The stdio server's side: reads and removes a recorded decision. The server then applies it
 * with the usual checks (this user and store, pending, not expired). Anyone who can write to
 * this folder can approve, which matches stdio mode: a single local user on their own machine.
 */
export function createFileApprovalInbox(dir: string): ApprovalInbox {
  return {
    async take(approvalId) {
      const file = fileFor(dir, approvalId);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      await rm(file, { force: true });
      return decisionFile.parse(JSON.parse(text)).decision;
    },
  };
}
