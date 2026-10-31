// @ts-check
// PreToolUse guard for Edit, Write and MultiEdit. Exit code 2 blocks the edit and sends the
// reason to Claude. Blocks: em dashes in new text, pnpm-lock.yaml, .env files (except
// .env.example) and changes to migrations that git already tracks (add a new file instead).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const EM_DASH = String.fromCharCode(0x2014);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @typedef {{
 *   file_path?: string;
 *   content?: string;
 *   new_string?: string;
 *   edits?: { new_string?: string }[];
 * }} ToolInput
 */

/**
 * Repo-relative path with forward slashes, or null when the file is outside the repo.
 * @param {string} filePath
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function repoPath(filePath, repoRoot) {
  const absolute = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const rel = relative(repoRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

/**
 * The text the edit would write.
 * @param {ToolInput} input
 * @returns {string[]}
 */
function newTexts(input) {
  const texts = [input.content, input.new_string, ...(input.edits ?? []).map((e) => e.new_string)];
  return texts.filter((text) => typeof text === 'string');
}

/**
 * Decides whether an edit is allowed. Returns the reason to block it, or null to allow it.
 * @param {ToolInput} input
 * @param {{ repoRoot: string; trackedMigrations: string[] }} options
 * @returns {string | null}
 */
export function blockReason(input, options) {
  const filePath = input.file_path ?? '';
  const name = basename(filePath);

  if (name === 'pnpm-lock.yaml') {
    return 'pnpm-lock.yaml is generated. Change package.json and run pnpm install instead of editing the lock file.';
  }
  if (name.startsWith('.env') && name !== '.env.example') {
    return `${name} may hold secrets and is not edited by Claude. Document new settings in .env.example instead.`;
  }
  const rel = repoPath(filePath, options.repoRoot);
  if (rel !== null && rel.startsWith('migrations/')) {
    const tracked = options.trackedMigrations.map((file) => file.toLowerCase());
    if (tracked.includes(rel.toLowerCase())) {
      return `${rel} is already committed, so it may be applied somewhere. Never change an applied migration: add the next numbered file in migrations/ instead.`;
    }
  }
  if (newTexts(input).some((text) => text.includes(EM_DASH))) {
    return 'The new text contains an em dash (U+2014), which this repo forbids. Use a comma, period, colon or parentheses instead.';
  }
  return null;
}

/** @returns {string[]} */
function trackedMigrations() {
  const output = execFileSync('git', ['ls-files', 'migrations/'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return output.split('\n').filter((line) => line.length > 0);
}

function main() {
  const event = /** @type {{ tool_input?: ToolInput }} */ (JSON.parse(readFileSync(0, 'utf8')));
  const reason = blockReason(event.tool_input ?? {}, {
    repoRoot: REPO_ROOT,
    trackedMigrations: trackedMigrations(),
  });
  if (reason !== null) {
    process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${reason}\n`);
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
